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

import sys
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
    progress: list[tuple[int, str]] = field(default_factory=list)

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
                    progress=lambda pct, message: self.progress.append((pct, message)),
                )
            else:
                plan = await service.run_recompute(
                    db,
                    uuid.UUID(kwargs["plan_id"]),
                    params_override=kwargs.get("params_override"),
                    progress=lambda pct, message: self.progress.append((pct, message)),
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


async def load(api: load_demo.DemoApi, name: str) -> load_demo.LoadSummary:
    """Charge un jeu par les fichiers d'import et connecte aussi les comptes fleet et manager."""
    summary = await load_demo.load_demo(api, name, admin=ADMIN)
    for role in ("fleet", "manager"):
        await api.login(role, load_demo.DEMO_USERS[role][0], load_demo.DEMO_PASSWORD)
    return summary
