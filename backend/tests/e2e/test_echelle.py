"""Passage à l'échelle par l'API (critère d'acceptation 3, F4.5) : `demo_scale` importé par les fichiers
(2 dépôts, 70 stations, 25 camions, 28 chauffeurs, 120 commandes) puis calculé par le service réel.

Les temps sont mesurés étape par étape et affichés (`pytest -m slow -s`) ; avec la variable
`TOURNEO_E2E_ARTIFACTS`, ils sont aussi écrits dans `echelle_temps.json`.
"""

from __future__ import annotations

import json
import time

import pytest

from tests.e2e.conftest import artifacts_dir, load

LIMIT_S = 60.0  # F4.5 : calcul < 60 s pour 70 stations, 25 camions, 120 commandes

# Étapes de `service.run_compute`, repérées par le pourcentage de progression qu'il annonce.
STEPS = (
    (2, 8, "construction du problème (lecture de la base)"),
    (8, 15, "matrice de distances"),
    (15, 92, "calcul des tournées (moteur)"),
    (92, 100, "enregistrement du plan"),
)


@pytest.mark.slow
async def test_demo_scale_importe_par_les_fichiers_puis_calcule_en_moins_de_60_s(api, db, tasks):
    started = time.perf_counter()
    summary = await load(api, "demo_scale")
    load_s = time.perf_counter() - started
    assert {k: v["created"] for k, v in summary.imports.items()} == {
        "depots": 2,
        "stations": 69,  # 70 attendues : voir `test_defaut_demo_scale_a_70_stations_distinctes`
        "trucks": 25,
        "drivers": 28,
        "orders": 120,
    }
    assert summary.stocks_entered == 6 and summary.orders_by_status == {"confirmed": 120}
    day_summary = (
        await api.call("GET", "/availability/summary", "dispatcher", params={"day": summary.day.isoformat()})
    ).json()
    assert day_summary["trucks"]["assignable"] == 25
    # Le jeu contient un chauffeur en congé et un chauffeur au permis expiré (RM-03).
    assert day_summary["drivers"]["assignable"] == 26 and day_summary["drivers"]["blocked_rm03"] == 1

    task_id = await api.start_compute(summary.day, summary.compute_params)
    started = time.perf_counter()
    computed = await tasks.run(db, task_id)
    compute_s = time.perf_counter() - started

    marks = {pct: at for at, pct, _ in tasks.progress if pct in {2, 8, 15, 92, 100}}
    steps = {label: marks[end] - marks[begin] for begin, end, label in STEPS}

    started = time.perf_counter()
    plan = (await api.call("GET", f"/plans/{computed.id}", "dispatcher")).json()
    read_s = time.perf_counter() - started

    served = {d["order_id"] for t in plan["trips"] for s in t["stops"] for d in s["deliveries"]}
    timings = {
        "imports_s": {k: round(v, 2) for k, v in summary.timings.items()},
        "chargement_total_s": round(load_s, 2),
        "etapes_calcul_s": {k: round(v, 2) for k, v in steps.items()},
        "calcul_total_s": round(compute_s, 2),
        "moteur_computed_in_ms": plan["computed_in_ms"],
        "lecture_plan_s": round(read_s, 2),
        "plan": {
            "tournees": len(plan["trips"]),
            "camions": len({t["truck_id"] for t in plan["trips"]}),
            "km": round(sum(t["distance_m"] for t in plan["trips"]) / 1000, 1),
            "commandes_servies": len(served),
            "non_servies": len(plan["unserved"]),
            "bloquantes": plan["blocking_count"],
            "avertissements": plan["warning_count"],
        },
    }
    print("\nTemps mesurés sur demo_scale :\n" + json.dumps(timings, ensure_ascii=False, indent=1))
    if (target := artifacts_dir()) is not None:
        (target / "echelle_temps.json").write_text(json.dumps(timings, ensure_ascii=False, indent=1))

    # Seuils de la spec (§7.5, F4.5, critère 3).
    assert plan["blocking_count"] == 0, [v for v in plan["violations"] if v["severity"] == "blocking"]
    assert plan["computed_in_ms"] < LIMIT_S * 1000
    assert compute_s < LIMIT_S, timings  # tout compris : lecture, matrice, moteur, enregistrement
    # Rien ne disparaît silencieusement (F4.4) : chaque commande est servie ou listée avec sa raison.
    unserved = {u["order_id"] for u in plan["unserved"]}
    assert len(served | unserved) == 120 and all(u["reason_code"] for u in plan["unserved"])
    assert len(served) == 120, plan["unserved"]  # le jeu est faisable par construction
    assert plan["approximate"] is True and plan["publishable"] is True
    # Les deux dépôts servent : le calcul est bien multi-dépôt.
    assert {t["depot_code"] for t in plan["trips"]} == {"SCDP-DLA", "SCDP-YDE"}
