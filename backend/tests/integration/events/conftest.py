"""Jeu de données des tests des événements : celui du service de plans (`world` : 1 dépôt,
4 stations, 2 camions, 3 chauffeurs, 5 commandes), complété par des camions de réserve et un
second dépôt. Le plan publié est calculé par le faux moteur du lot L5 (`fakes`) ; les règles et le
recontrôle sont les vrais. Le scénario complet (`test_scenario_complet.py`) n'utilise aucune doublure.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal

import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

from app.availability.models import DailyDepotStock
from app.core.enums import TruckSize
from app.core.geo import point
from app.core.time import utcnow
from app.planning import service as planning_service
from app.planning.checking import load_plan
from app.planning.models import Plan
from app.referentials.models import Depot, Truck, TruckCompartment
from tests.integration.planning.conftest import (  # noqa: F401
    DAY,
    OPEN,
    World,
    auth_headers,
    dispatcher,
    fakes,
    plan,
    world,
)


def at(hour: int, minute: int = 0) -> datetime:
    """Horodatage UTC du jour J (Africa/Douala = UTC+1 : 08:00 UTC = 09:00 locales)."""
    return datetime(DAY.year, DAY.month, DAY.day, hour, minute, tzinfo=UTC)


def iso(moment: datetime) -> str:
    return moment.isoformat().replace("+00:00", "Z")


@dataclass
class Spare:
    truck: Truck  # grand porteur de réserve, 2 compartiments tous produits
    small: Truck  # petit porteur : capacité insuffisante
    super_only: Truck  # compartiments réservés au super
    depot2: Depot  # second dépôt, stock renseigné


@pytest_asyncio.fixture
async def spare(db: AsyncSession, world: World) -> Spare:  # noqa: F811
    carrier_id = world.trucks["LT-001-AA"].carrier_id
    truck = Truck(
        plate="LT-003-CC", carrier_id=carrier_id, size=TruckSize.LARGE, total_capacity_l=Decimal(30000)
    )
    truck.compartments = [
        TruckCompartment(position=1, capacity_l=Decimal("18000")),
        TruckCompartment(position=2, capacity_l=Decimal("12000")),
    ]
    small = Truck(
        plate="LT-004-DD", carrier_id=carrier_id, size=TruckSize.SMALL, total_capacity_l=Decimal(6000)
    )
    small.compartments = [TruckCompartment(position=1, capacity_l=Decimal("6000"))]
    super_only = Truck(
        plate="LT-005-EE", carrier_id=carrier_id, size=TruckSize.LARGE, total_capacity_l=Decimal(30000)
    )
    super_only.compartments = [
        TruckCompartment(
            position=1, capacity_l=Decimal("30000"), allowed_product_ids=[world.products["SUPER"].id]
        )
    ]
    depot2 = Depot(code="DEP-BON", name="Dépôt Bonabéri", location=point(4.07, 9.66), opening_hours=OPEN)
    db.add_all([truck, small, super_only, depot2])
    await db.flush()
    for code in ("SUPER", "GASOIL"):
        db.add(
            DailyDepotStock(
                depot_id=depot2.id,
                product_id=world.products[code].id,
                day=DAY,
                available_l=Decimal("100000"),
                entered_at=utcnow(),
            )
        )
    await db.commit()
    return Spare(truck, small, super_only, depot2)


@pytest_asyncio.fixture
async def published(db: AsyncSession, plan: Plan, spare: Spare) -> Plan:  # noqa: F811
    """Plan publié (version 1) : tournée 1 = o1 + o2 + o3, tournée 2 = o4 + o5."""
    await planning_service.publish_plan(db, plan.id)
    await db.commit()
    return await load_plan(db, plan.id)
