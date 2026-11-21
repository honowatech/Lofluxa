import pytest_asyncio

from tests.integration.loading.factory import TripScenario, make_trip_scenario


@pytest_asyncio.fixture
async def scenario(db, products) -> TripScenario:
    """Plan publié avec une tournée `planned` complète (voir factory.py)."""
    return await make_trip_scenario(db, products)
