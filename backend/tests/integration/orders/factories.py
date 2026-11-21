"""Fabriques de données pour les tests du lot L4 (référentiels créés directement par l'ORM).

Chaque fabrique valide (`commit`) ses données : la transaction englobante du test est annulée à la
fin, mais une requête en erreur n'efface ainsi pas le jeu de données du test.
"""

from datetime import date
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import DriverStatus, OrderPriority, OrderStatus, TruckSize, TruckStatus
from app.core.geo import point
from app.orders.models import Order
from app.referentials.models import Carrier, Depot, Driver, Product, Station, StationTank, Truck

DAY = date(2027, 1, 12)


async def make_station(
    db: AsyncSession,
    code: str = "ST-001",
    *,
    tanks: dict[Product, tuple[float, float]] | None = None,
    active: bool = True,
) -> Station:
    """`tanks` : {produit: (capacité, stock de sécurité)}."""
    station = Station(code=code, name=f"Station {code}", location=point(4.05, 9.70), active=active)
    for product, (capacity, safety) in (tanks or {}).items():
        station.tanks.append(
            StationTank(
                product_id=product.id, capacity_l=Decimal(str(capacity)), safety_stock_l=Decimal(str(safety))
            )
        )
    db.add(station)
    await db.commit()
    return station


async def make_depot(db: AsyncSession, code: str = "SCDP-DLA", *, active: bool = True) -> Depot:
    depot = Depot(code=code, name=f"Dépôt {code}", location=point(4.0483, 9.7043), active=active)
    db.add(depot)
    await db.commit()
    return depot


async def make_carrier(db: AsyncSession, name: str = "Transports du Wouri") -> Carrier:
    carrier = Carrier(name=name)
    db.add(carrier)
    await db.commit()
    return carrier


async def make_truck(
    db: AsyncSession,
    plate: str = "LT-001-AA",
    *,
    status: TruckStatus = TruckStatus.AVAILABLE,
    carrier: Carrier | None = None,
) -> Truck:
    truck = Truck(
        plate=plate,
        size=TruckSize.MEDIUM,
        total_capacity_l=Decimal("30000"),
        status=status,
        carrier_id=carrier.id if carrier else None,
    )
    db.add(truck)
    await db.commit()
    return truck


async def make_driver(
    db: AsyncSession,
    full_name: str = "Jean Mbarga",
    *,
    license_expiry: date | None = date(2030, 1, 1),
    hazmat_cert: bool = True,
    hazmat_expiry: date | None = date(2030, 1, 1),
    status: DriverStatus = DriverStatus.AVAILABLE,
    default_truck: Truck | None = None,
    carrier: Carrier | None = None,
) -> Driver:
    driver = Driver(
        full_name=full_name,
        license_expiry=license_expiry,
        hazmat_cert=hazmat_cert,
        hazmat_expiry=hazmat_expiry,
        status=status,
        default_truck_id=default_truck.id if default_truck else None,
        carrier_id=carrier.id if carrier else None,
    )
    db.add(driver)
    await db.commit()
    return driver


async def make_order(
    db: AsyncSession,
    station: Station,
    product: Product,
    *,
    day: date = DAY,
    requested_l: float = 10000,
    status: OrderStatus = OrderStatus.DRAFT,
    priority: OrderPriority = OrderPriority.NORMAL,
) -> Order:
    order = Order(
        day=day,
        station_id=station.id,
        product_id=product.id,
        requested_l=Decimal(str(requested_l)),
        status=status,
        priority=priority,
    )
    db.add(order)
    await db.commit()
    return order
