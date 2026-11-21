"""Fixtures du lot L7 : monde de test et doublures du moteur (lot L2, non livré).

Le service de plans (lot L5) et les règles (lot L1) sont les vrais. Restent simulés, avec les
doublures du lot L5 (`tests/integration/planning/fakes.py`) : `build_matrix`, `coord_hash`,
`assign_compartments` et `engine.solve`. L'envoi de la tâche de calcul à Celery
(`tasks.dispatch_compute`) est intercepté : une tâche ouvre sa propre connexion et ne verrait pas
la transaction du test ; `run_compute` est appelé directement avec les arguments interceptés.
"""

import pytest
import pytest_asyncio

import app.planning.engine as engine_pkg
from app.planning import tasks
from app.planning.engine import compartments, distance_matrix
from app.planning.violations import rules
from tests.integration.planning import fakes

from . import factory


@pytest.fixture(autouse=True)
def engine_doubles(monkeypatch):
    """Branche les doublures du moteur ; renvoie les appels reçus par `tasks.dispatch_compute`."""
    calls: list[dict] = []

    def fake_dispatch(**kwargs) -> str:
        calls.append(kwargs)
        return "task-rejeu-1"

    fake_engine = fakes.FakeEngine(rules=fakes.FakeRules(real_check_plan=rules.check_plan))
    monkeypatch.setattr(distance_matrix, "coord_hash", fakes.fake_coord_hash)
    monkeypatch.setattr(distance_matrix, "build_matrix", fakes.fake_build_matrix)
    monkeypatch.setattr(compartments, "assign_compartments", fakes.fake_assign_compartments)
    monkeypatch.setattr(engine_pkg, "solve", fake_engine.solve)
    monkeypatch.setattr(engine_pkg, "ENGINE_VERSION", fakes.FAKE_ENGINE_VERSION)
    monkeypatch.setattr(tasks, "dispatch_compute", fake_dispatch)
    return calls


@pytest_asyncio.fixture
async def world(db, products):
    return await factory.make_world(db, products)
