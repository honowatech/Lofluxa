"""Critères d'acceptation du prototype (spec §13) : un test par critère vérifiable automatiquement.

| # | Critère | Ici |
|---|---|---|
| 1 | Rejeu de la journée A sans violation bloquante, au moins autant de commandes servies | oui, sur la journée fabriquée |
| 2 | Kilométrage calculé inférieur d'au moins `ab_success_threshold_pct` | oui, sur la journée fabriquée |
| 3 | Calcul < 60 s sur `demo_scale` | oui (`-m slow`) |
| 4 | Dispatcher autonome après une heure de formation | non automatisable (recette chez OLA) |
| 5 | RM-01 à RM-20 testées ; couverture de `planning` ≥ 80 % | présence d'un `test_RM_xx` par règle |
| 6 | Redémarrage sans perte, sauvegarde restaurable en 30 min | non vérifiable ici (pas de Docker) |
| 7 | Aucun fichier Excel lu hors de `imports/` | oui (application et scripts) |

La journée A réelle d'OLA n'est pas encore fournie : les critères 1 et 2 sont vérifiés sur la journée
manuelle fabriquée par `scripts/demo/make_reference_day.py` (voir `docs/DEMO.md`). L'état de chaque
critère, y compris les 4 et 6, est tenu dans `docs/DEMO.md`.
"""  # noqa: E501

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

from tests.e2e.conftest import load, run_ab, timed_compute
from tests.unit.imports.test_isolation import FORBIDDEN_CALLS, FORBIDDEN_MODULES
from tests.unit.imports.test_isolation import violations as excel_reads

BACKEND = Path(__file__).resolve().parents[2]
REPO = BACKEND.parent
APP = BACKEND / "app"
TESTS = BACKEND / "tests"

# ------------------------------------------------------------------ critères 1 et 2 (journée A fabriquée)


async def test_critere_1_rejeu_sans_violation_bloquante_et_autant_de_commandes_servies(api, db, tasks):
    await load(api, "demo_douala", orders=False)
    ab = await run_ab(api, db, tasks)
    a, b, verdict = ab["comparison"]["metrics_a"], ab["comparison"]["metrics_b"], ab["comparison"]["verdict"]

    assert ab["comparison"]["plan_b"]["kind"] == "replay"
    assert b["violations_blocking"] == 0
    assert b["orders_served"] >= a["orders_served"] and a["orders_served"] == 20
    assert b["stations_served"] >= a["stations_served"]
    assert b["volume_planned_l"] >= a["volume_planned_l"]
    assert verdict["no_blocking_violation"] is True and verdict["orders_served_ok"] is True
    assert ab["comparison"]["unserved_b"] == []


async def test_critere_2_gain_kilometrique_au_moins_egal_au_seuil(api, db, tasks):
    await load(api, "demo_douala", orders=False)
    settings = {s["key"]: s["value"] for s in await api.get_all("/settings", "manager")}
    threshold = settings["ab_success_threshold_pct"]
    assert threshold == 10.0  # valeur par défaut de la spec, paramétrable

    ab = await run_ab(api, db, tasks)
    a, b, verdict = ab["comparison"]["metrics_a"], ab["comparison"]["metrics_b"], ab["comparison"]["verdict"]
    gain_pct = 100 * (a["distance_estimated_m"] - b["distance_estimated_m"]) / a["distance_estimated_m"]
    assert gain_pct >= threshold, f"gain {gain_pct:.1f} % sous le seuil de {threshold} %"
    assert verdict["threshold_pct"] == threshold and verdict["success"] is True
    assert verdict["gain_pct"] == pytest.approx(gain_pct, abs=0.06)
    # Le plan calculé ne mobilise pas plus de moyens que le plan manuel.
    assert b["trucks_used"] <= a["trucks_used"] and b["trips_count"] <= a["trips_count"]

    # Le verdict suit le paramètre : avec un seuil hors d'atteinte, l'objectif n'est plus atteint.
    await api.call("PUT", "/settings", "admin", json={"values": {"ab_success_threshold_pct": 50}})
    strict = await api.comparison(ab["plan_a"], ab["plan_b"], "manager")
    assert strict["verdict"]["threshold_pct"] == 50 and strict["verdict"]["success"] is False


# ------------------------------------------------------------------ critère 3


@pytest.mark.slow
async def test_critere_3_calcul_en_moins_de_60_s_sur_demo_scale(api, db, tasks):
    summary = await load(api, "demo_scale")
    plan, total_s, _ = await timed_compute(api, db, tasks, summary)
    assert plan["computed_in_ms"] < 60_000 and total_s < 60.0
    assert plan["blocking_count"] == 0


# ------------------------------------------------------------------ critère 5

RULES = [f"RM-{n:02d}" for n in range(1, 21)]
# Règles sans test nommé `test_RM_xx…` à ce jour, avec le lot qui doit le fournir.
MISSING = {
    "RM-19": "L10 (événements, vague 2) non encore livré : la panne de camion (F6.1) n'existe pas, "
    "donc aucun `test_RM_19_…` (transfert des seuls arrêts `pending`).",
}


def rule_tests() -> dict[str, list[str]]:
    """Règle → tests nommés `test_RM_xx…` dans `backend/tests/` (hors ce fichier)."""
    found: dict[str, list[str]] = {rule: [] for rule in RULES}
    for path in sorted(TESTS.rglob("test_*.py")):
        if path == Path(__file__).resolve():
            continue
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
                match = re.match(r"test_RM_(\d{2})(?!\d)", node.name, flags=re.IGNORECASE)
                if match and f"RM-{match.group(1)}" in found:
                    found[f"RM-{match.group(1)}"].append(f"{path.relative_to(BACKEND)}::{node.name}")
    return found


@pytest.mark.parametrize(
    "rule",
    [
        pytest.param(rule, marks=pytest.mark.xfail(strict=True, reason=MISSING[rule]))
        if rule in MISSING
        else rule
        for rule in RULES
    ],
)
def test_critere_5_chaque_regle_a_un_test_qui_la_cite(rule):
    tests = rule_tests()[rule]
    assert tests, f"aucun test nommé test_{rule.replace('-', '_')}_… dans backend/tests/"


def test_critere_5_liste_des_regles_sans_test():
    """La liste des règles sans test est exactement celle qui est déclarée (et documentée) ici."""
    missing = sorted(rule for rule, tests in rule_tests().items() if not tests)
    assert missing == sorted(MISSING), f"règles sans test : {missing}"


# ------------------------------------------------------------------ critère 7


def test_critere_7_aucun_fichier_excel_lu_hors_de_app_imports():
    """Dans l'application : contrôle du lot L3 (bibliothèques et appels de lecture interdits hors de
    `app/imports/`). Dans `scripts/` : aucun script ne lit de classeur — ceux qui en écrivent passent
    par les fonctions d'écriture de `app/imports/`."""
    imports = APP / "imports"
    outside = [p for p in sorted(APP.rglob("*.py")) if imports not in p.parents]
    assert len(outside) > 60
    found = [v for path in outside for v in excel_reads(path)]
    assert found == [], "\n".join(found)

    scripts = sorted((REPO / "scripts").rglob("*.py"))
    assert {p.name for p in scripts} >= {"export_fixture.py", "load_demo.py", "make_reference_day.py"}
    offenders = []
    for path in scripts:
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            elif isinstance(node, ast.Attribute) and node.attr in FORBIDDEN_CALLS:
                names = [node.attr]
            elif isinstance(node, ast.Name) and node.id in FORBIDDEN_CALLS:
                names = [node.id]
            else:
                continue
            offenders += [
                f"{path.relative_to(REPO)}:{node.lineno} {name}"
                for name in names
                if name.split(".")[0] in FORBIDDEN_MODULES | FORBIDDEN_CALLS
            ]
    assert offenders == [], "\n".join(offenders)
    # Contre-épreuve : le lecteur de fichiers est bien dans `app/imports/`.
    assert {p.name for p in imports.glob("*.py") if excel_reads(p)} >= {"tabular.py", "reference_day.py"}
