"""Jeu de données et doublures communs aux tests du service de plans."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, time, timedelta
from decimal import Decimal

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

from app.availability.models import DailyDepotStock, DailyTruckDriver
from app.core.context import current_user_id
from app.core.enums import OrderPriority, OrderStatus, TruckSize
from app.core.geo import point
from app.core.time import utcnow
from app.orders.models import Order
from app.planning import service
from app.planning.models import Plan
from app.referentials.models import Carrier, Depot, Driver, Station, Truck, TruckCompartment
from tests.integration.planning import fakes as fakes_module

DAY = date(2027, 1, 12)  # un mardi
OPEN = {k: [["06:00", "18:00"]] for k in ("mon", "tue", "wed", "thu", "fri", "sat")} | {"sun": []}


@pytest.fixture
def fakes(monkeypatch) -> fakes_module.Fakes:
    """Moteur et règles simulés (lots L1 et L2 non livrés dans cette branche)."""
    return fakes_module.install(monkeypatch)


@dataclass
class World:
    day: date
    depot: Depot
    stations: dict[str, Station]
    trucks: dict[str, Truck]
    drivers: dict[str, Driver]
    orders: dict[str, Order] = field(default_factory=dict)
    products: dict = field(default_factory=dict)


@pytest_asyncio.fixture
async def world(db: AsyncSession, products) -> World:
    """1 dépôt, 4 stations, 2 camions (2 compartiments chacun), 3 chauffeurs, 5 commandes confirmées."""
    carrier = Carrier(name="Transport Test")
    depot = Depot(code="SCDP-DLA", name="SCDP Douala", location=point(4.0483, 9.7043), opening_hours=OPEN)
    db.add_all([carrier, depot])
    await db.flush()

    stations = {}
    for index, (code, lat, lon) in enumerate(
        [("ST-01", 4.06, 9.72), ("ST-02", 4.08, 9.75), ("ST-03", 4.02, 9.68), ("ST-04", 4.10, 9.78)], start=1
    ):
        stations[code] = Station(
            code=code,
            name=f"Station {index}",
            city="Douala",
            location=point(lat, lon),
            opening_hours=OPEN,
            contact_name=f"Gérant {index}",
            contact_phone=f"+237 600 00 00 0{index}",
        )
    db.add_all(stations.values())

    trucks = {}
    for plate in ("LT-001-AA", "LT-002-BB"):
        truck = Truck(
            plate=plate, carrier_id=carrier.id, size=TruckSize.LARGE, total_capacity_l=Decimal("30000")
        )
        truck.compartments = [
            TruckCompartment(position=1, capacity_l=Decimal("18000")),
            TruckCompartment(position=2, capacity_l=Decimal("12000")),
        ]
        trucks[plate] = truck
    db.add_all(trucks.values())
    await db.flush()

    far = DAY + timedelta(days=400)
    drivers = {
        name: Driver(
            full_name=name,
            phone="+237 699 00 00 00",
            license_no=f"P-{name}",
            license_expiry=far,
            hazmat_cert=True,
            hazmat_expiry=far,
            carrier_id=carrier.id,
        )
        for name in ("Abena", "Biya", "Che")
    }
    drivers["Abena"].default_truck_id = trucks["LT-001-AA"].id
    db.add_all(drivers.values())
    await db.flush()
    db.add(DailyTruckDriver(day=DAY, truck_id=trucks["LT-002-BB"].id, driver_id=drivers["Biya"].id))

    for code in ("SUPER", "GASOIL"):
        db.add(
            DailyDepotStock(
                depot_id=depot.id,
                product_id=products[code].id,
                day=DAY,
                available_l=Decimal("200000"),
                entered_at=utcnow(),
            )
        )

    spec = [
        ("o1", "ST-01", "SUPER", 10000, OrderPriority.NORMAL),
        ("o2", "ST-02", "GASOIL", 8000, OrderPriority.NORMAL),
        ("o3", "ST-03", "SUPER", 6000, OrderPriority.URGENT),
        ("o4", "ST-04", "GASOIL", 9000, OrderPriority.NORMAL),
        ("o5", "ST-04", "SUPER", 5000, OrderPriority.NORMAL),
    ]
    orders = {}
    for key, station, product, volume, priority in spec:
        orders[key] = Order(
            day=DAY,
            station_id=stations[station].id,
            product_id=products[product].id,
            requested_l=Decimal(volume),
            priority=priority,
            status=OrderStatus.CONFIRMED,
        )
    orders["o2"].window_start = time(7, 0)
    orders["o2"].window_end = time(16, 0)
    db.add_all(orders.values())
    # Validé (point de sauvegarde) : une réponse en erreur de l'API annule la transaction en cours
    # de la session de test, les données du jeu doivent y survivre.
    await db.commit()
    return World(DAY, depot, stations, trucks, drivers, orders, products)


@pytest_asyncio.fixture
async def dispatcher(db: AsyncSession, make_user):
    """Utilisateur dispatcher, posé comme utilisateur courant (audit, journal)."""
    user = await make_user("dispatcher", email="dispatch@tourneo-test.cm")
    await db.commit()
    token = current_user_id.set(user.id)
    yield user
    current_user_id.reset(token)


@pytest_asyncio.fixture
async def plan(db: AsyncSession, world: World, fakes, dispatcher) -> Plan:
    """Plan brouillon calculé par le faux moteur : 2 tournées (o1+o2+o3 puis o4+o5)."""
    plan = await service.run_compute(db, world.day)
    await db.commit()
    return plan


@pytest_asyncio.fixture
async def auth_headers(auth_headers, db: AsyncSession):
    """Comme la fixture commune, mais l'utilisateur créé survit à une réponse en erreur."""

    async def _headers(role="dispatcher") -> dict[str, str]:
        headers = await auth_headers(role)
        await db.commit()
        return headers

    return _headers
