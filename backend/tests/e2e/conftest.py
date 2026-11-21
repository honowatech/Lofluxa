"""Outillage des tests de bout en bout (lot L15).

Les tests passent par les mêmes portes qu'un utilisateur : l'API HTTP (client de `tests/conftest.py`)
et les fichiers d'import versionnés dans `data/fixtures/<jeu>/import/`. Le chargement d'un jeu est fait
par le code même du chargeur de démonstration (`scripts/demo/load_demo.py`), branché sur le client de
test. Vrai moteur, vraies règles, aucune doublure — sauf l'exécution de la tâche Celery : l'envoi est
intercepté (`tasks`) et le test exécute `service.run_compute` / `run_recompute` avec sa propre session,
comme `tests/integration/planning/test_real_engine.py` (une tâche Celery ouvrirait sa propre connexion
et ne verrait pas la transaction du test).
"""

from __future__ import annotations

import os
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

import pytest
import pytest_asyncio

from app.core.context import current_user_id
from app.core.enums import PlanKind
from app.planning import service
from app.planning import tasks as planning_tasks
from app.planning.models import Plan

DEMO_SCRIPTS = Path(__file__).resolve().parents[3] / "scripts" / "demo"
if str(DEMO_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(DEMO_SCRIPTS))

import load_demo  # noqa: E402  (scripts/demo/load_demo.py)

ADMIN = ("admin@e2e.tourneo.cm", "admin-e2e-secret")


@dataclass
class TaskBox:
    """Tâches de calcul interceptées : identifiant de tâche → arguments transmis à Celery."""

    calls: dict[str, tuple[str, dict[str, Any]]] = field(default_factory=dict)
    # Progression rapportée par le service : (instant `perf_counter`, pourcentage, message).
    progress: list[tuple[float, int, str]] = field(default_factory=list)

    async def run(self, db: Any, task_id: str) -> Plan:
        """Exécute la tâche avec la session du test : même conversion d'arguments que `planning.tasks`."""
        name, kwargs = self.calls.pop(task_id)
        token = current_user_id.set(uuid.UUID(kwargs["user_id"]) if kwargs.get("user_id") else None)
        try:
            if name == "compute":
                order_ids = kwargs.get("order_ids")
                parent = kwargs.get("parent_plan_id")
                plan = await service.run_compute(
                    db,
                    date.fromisoformat(kwargs["day"]),
                    params_override=kwargs.get("params_override"),
                    kind=PlanKind(kwargs.get("kind", PlanKind.COMPUTED.value)),
                    order_ids=[uuid.UUID(o) for o in order_ids] if order_ids is not None else None,
                    parent_plan_id=uuid.UUID(parent) if parent else None,
                    label=kwargs.get("label"),
                    progress=lambda pct, message: self.progress.append((time.perf_counter(), pct, message)),
                )
            else:
                plan = await service.run_recompute(
                    db,
                    uuid.UUID(kwargs["plan_id"]),
                    params_override=kwargs.get("params_override"),
                    progress=lambda pct, message: self.progress.append((time.perf_counter(), pct, message)),
                )
            await db.commit()
            return plan
        finally:
            current_user_id.reset(token)


@pytest.fixture
def tasks(monkeypatch) -> TaskBox:
    """Intercepte l'envoi des tâches de calcul à Celery (seule doublure des tests de bout en bout)."""
    box = TaskBox()

    def _dispatch(name: str):
        def dispatch(**kwargs: Any) -> str:
            task_id = f"e2e-{name}-{len(box.calls) + 1}-{uuid.uuid4().hex[:8]}"
            box.calls[task_id] = (name, kwargs)
            return task_id

        return dispatch

    monkeypatch.setattr(planning_tasks, "dispatch_compute", _dispatch("compute"))
    monkeypatch.setattr(planning_tasks, "dispatch_recompute", _dispatch("recompute"))
    return box


@pytest_asyncio.fixture
async def api(client, db, make_user, products) -> load_demo.DemoApi:
    """Client de démonstration branché sur l'application de test : produits et compte admin en place
    (ce que fait `python -m app.cli seed`), connexions réelles par `POST /auth/login`."""
    await make_user("admin", email=ADMIN[0], password=ADMIN[1])
    await db.commit()
    return load_demo.DemoApi(client, log=lambda message: None)


async def load(api: load_demo.DemoApi, name: str, **options: Any) -> load_demo.LoadSummary:
    """Charge un jeu par les fichiers d'import et connecte aussi les comptes fleet et manager."""
    summary = await load_demo.load_demo(api, name, admin=ADMIN, **options)
    for role in ("fleet", "manager"):
        await api.login(role, load_demo.DEMO_USERS[role][0], load_demo.DEMO_PASSWORD)
    return summary


async def set_settings(api: load_demo.DemoApi, **values: Any) -> None:
    """Modifie des paramètres par l'API (administrateur), comme à l'écran Administration."""
    await api.call("PUT", "/settings", "admin", json={"values": values})


# Limite du solveur pour les rejeux des tests : le rejeu (`POST /plans/{id}/replay`) n'accepte pas de
# surcharge de paramètres, il lit la table `settings` (45 s par défaut). Même valeur que le jeu.
FAST_SOLVER = {"solver_time_limit_s": 6}


async def run_ab(
    api: load_demo.DemoApi, db: Any, tasks: TaskBox, name: str = "demo_douala"
) -> dict[str, Any]:
    """Journée A fabriquée importée par son fichier → rejeu par le vrai moteur → comparaison.

    Renvoie `{"imported", "plan_a", "plan_b", "comparison"}` (identifiants en texte)."""
    await set_settings(api, **FAST_SOLVER)
    imported = await api.import_reference_day(load_demo.reference_day_file(name), replace=False)
    replay = await tasks.run(db, await api.start_replay(imported["plan_id"]))
    comparison = await api.comparison(imported["plan_id"], str(replay.id), "manager")
    return {
        "imported": imported,
        "plan_a": imported["plan_id"],
        "plan_b": str(replay.id),
        "comparison": comparison,
    }


def artifacts_dir() -> Path | None:
    """Répertoire où déposer les PDF produits par les tests (variable `TOURNEO_E2E_ARTIFACTS`),
    pour un contrôle visuel ; rien n'est écrit si la variable est absente."""
    target = os.environ.get("TOURNEO_E2E_ARTIFACTS")
    if not target:
        return None
    path = Path(target)
    path.mkdir(parents=True, exist_ok=True)
    return path


async def get_plan(api: load_demo.DemoApi, plan_id: str, role: str = "dispatcher") -> dict[str, Any]:
    return (await api.call("GET", f"/plans/{plan_id}", role)).json()


async def compute_day(
    api: load_demo.DemoApi, db: Any, tasks: TaskBox, summary: load_demo.LoadSummary
) -> dict:
    """`POST /plans/compute` avec les paramètres du jeu, tâche exécutée, plan relu par l'API."""
    plan = await tasks.run(db, await api.start_compute(summary.day, summary.compute_params))
    return await get_plan(api, str(plan.id))


async def published_day(
    api: load_demo.DemoApi, db: Any, tasks: TaskBox, name: str = "demo_douala"
) -> tuple[load_demo.LoadSummary, dict[str, Any]]:
    """Jeu chargé par les fichiers, plan calculé et publié. Renvoie le résumé du chargement et le plan."""
    summary = await load(api, name)
    plan = await compute_day(api, db, tasks, summary)
    published = (await api.call("POST", f"/plans/{plan['id']}/publish", "dispatcher")).json()
    return summary, published


def loading_payload(trip: dict[str, Any], temperature: float = 27.0) -> dict[str, Any]:
    """Chargement conforme au plan de chargement de la tournée (volumes observés = volumes planifiés)."""
    return {
        "depot_ticket_no": f"BC-{trip['seq']:04d}",
        "lines": [
            {
                "compartment_id": line["compartment_id"],
                "product_id": line["product_id"],
                "observed_l": line["planned_l"],
                "observed_temp_c": temperature,
            }
            for line in trip["loads"]
        ],
    }
