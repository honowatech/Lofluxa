"""Fixtures du lot L7 : monde de test et doublures du moteur (lot L2, non livré).

Le service de plans (lot L5) et les règles (lot L1) sont les vrais. Restent simulés, avec les
doublures du lot L5 (`tests/integration/planning/fakes.py`) : `build_matrix`, `coord_hash`,
`assign_compartments` et `engine.solve`. L'envoi de la tâche de calcul à Celery
(`tasks.dispatch_compute`) est intercepté : une tâche ouvre sa propre connexion et ne verrait pas
la transaction du test ; `run_compute` est appelé directement avec les arguments interceptés.
"""

import pytest
import pytest_asyncio

from app.planning import tasks
from tests.integration.planning import fakes

from . import factory


@pytest.fixture(autouse=True)
def engine_doubles(monkeypatch):
    """Branche les doublures du moteur ; renvoie les appels reçus par `tasks.dispatch_compute`."""
    calls: list[dict] = []

    def fake_dispatch(**kwargs) -> str:
        calls.append(kwargs)
        return "task-rejeu-1"

    fakes.install(monkeypatch)  # moteur simulé ; les règles restent celles du lot L1
    monkeypatch.setattr(tasks, "dispatch_compute", fake_dispatch)
    return calls


@pytest_asyncio.fixture
async def world(db, products):
    return await factory.make_world(db, products)
