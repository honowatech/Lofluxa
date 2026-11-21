"""Fixtures du lot L7 : monde de test et doublures des lots non livrés (L2, L5)."""

import pytest
import pytest_asyncio

from app.planning import service as plan_service
from app.planning.engine import compartments, distance_matrix

from . import factory


@pytest.fixture(autouse=True)
def engine_doubles(monkeypatch):
    """Remplace `build_problem`, `build_matrix`, `assign_compartments` et `launch_compute` ; renvoie
    les appels reçus par `launch_compute`. Les règles (`check_plan`) sont les vraies."""
    calls: list[dict] = []

    async def fake_launch_compute(session, day, **kwargs) -> str:
        calls.append({"day": day, **kwargs})
        return "task-rejeu-1"

    monkeypatch.setattr(plan_service, "build_problem", factory.fake_build_problem)
    monkeypatch.setattr(plan_service, "launch_compute", fake_launch_compute)
    monkeypatch.setattr(distance_matrix, "build_matrix", factory.fake_build_matrix)
    monkeypatch.setattr(compartments, "assign_compartments", factory.fake_assign_compartments)
    return calls


@pytest_asyncio.fixture
async def world(db, products):
    return await factory.make_world(db, products)
