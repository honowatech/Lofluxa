"""Disponibilité du jour (F2) : stocks dépôt, affectabilité des camions et des chauffeurs,
affectation chauffeur ↔ camion.

Fonctions réutilisables par les autres lots (lecture seule, aucune ne valide la transaction)
-------------------------------------------------------------------------------------------
    await load_day_resources(session, day) -> DayResources
        Tous les camions et chauffeurs du référentiel avec, pour le jour J : marquage du jour,
        motif de blocage (RM-04 via `truck_block_reason`, RM-03 via `driver_block_reason` /
        `driver_unavailable_reason`) et affectation chauffeur ↔ camion effective.
        `DayResources.trucks` / `.drivers` : listes de `TruckDay` / `DriverDay` ;
        `.assignments` : {driver_id: truck_id}.
    await current_depot_stocks(session, day) -> {(depot_id, product_id): DailyDepotStock}
        Saisie qui fait foi (la plus récente) pour chaque couple renseigné ; couple absent =
        stock non renseigné (RM-08 : avertissement).
    await record_depot_stock(session, depot_id=…, product_id=…, day=…, available_l=…, user_id=…)
        Nouvelle saisie de stock (ex. pénurie F6.3) : ajoute une ligne, n'écrase jamais.

Affectation effective du jour (F2.4) : une ligne `daily_truck_drivers` fait foi ; sans ligne, le
chauffeur reprend son camion habituel (`drivers.default_truck_id`) si aucun autre chauffeur ne l'a
pris pour la journée. Un camion a au plus un chauffeur par jour, et inversement.
"""

import uuid
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.availability.models import DailyDepotStock, DailyResourceStatus, DailyTruckDriver
from app.core.time import utcnow
from app.planning.domain import DriverD, TruckD
from app.planning.violations.eligibility import (
    driver_block_reason,
    driver_unavailable_reason,
    truck_block_reason,
)
from app.referentials.models import Carrier, Driver, Truck

# --- Camions et chauffeurs -------------------------------------------------------------------


@dataclass(slots=True)
class TruckDay:
    truck: Truck
    carrier_name: str | None
    available_today: bool
    day_reason: str | None
    block_reason: str | None  # RM-04 ; None = affectable
    driver: Driver | None = None
    assignment_source: str | None = None  # "daily" | "default"

    @property
    def assignable(self) -> bool:
        return self.block_reason is None


@dataclass(slots=True)
class DriverDay:
    driver: Driver
    carrier_name: str | None
    available_today: bool
    day_reason: str | None
    block_reason: str | None  # None = affectable
    rm03_reason: str | None  # motif RM-03 (permis, habilitation) s'il y en a un
    default_truck: Truck | None = None
    truck: Truck | None = None
    assignment_source: str | None = None  # "daily" | "default"

    @property
    def assignable(self) -> bool:
        return self.block_reason is None


@dataclass(slots=True)
class DayResources:
    day: date
    trucks: list[TruckDay]
    drivers: list[DriverDay]

    @property
    def assignments(self) -> dict[uuid.UUID, uuid.UUID]:
        """Affectation effective du jour : {driver_id: truck_id}."""
        return {d.driver.id: d.truck.id for d in self.drivers if d.truck is not None}


def truck_domain(truck: Truck, available_today: bool = True) -> TruckD:
    """Vue minimale d'un camion pour `truck_block_reason` (RM-04)."""
    return TruckD(
        id=str(truck.id),
        plate=truck.plate,
        size=truck.size,
        compartments=(),
        carrier_id=str(truck.carrier_id) if truck.carrier_id else None,
        status=truck.status,
        available_today=available_today,
    )


def driver_domain(driver: Driver, available_today: bool = True) -> DriverD:
    """Vue minimale d'un chauffeur pour `driver_block_reason` (RM-03)."""
    return DriverD(
        id=str(driver.id),
        full_name=driver.full_name,
        carrier_id=str(driver.carrier_id) if driver.carrier_id else None,
        license_expiry=driver.license_expiry,
        hazmat_cert=driver.hazmat_cert,
        hazmat_expiry=driver.hazmat_expiry,
        status=driver.status.value,
        available_today=available_today,
        default_truck_id=str(driver.default_truck_id) if driver.default_truck_id else None,
    )


async def load_day_resources(session: AsyncSession, day: date) -> DayResources:
    trucks = (
        (
            await session.execute(
                select(Truck).where(Truck.deleted_at.is_(None)).order_by(Truck.plate, Truck.id)
            )
        )
        .scalars()
        .all()
    )
    drivers = (
        (
            await session.execute(
                select(Driver).where(Driver.deleted_at.is_(None)).order_by(Driver.full_name, Driver.id)
            )
        )
        .scalars()
        .all()
    )
    carriers = dict((await session.execute(select(Carrier.id, Carrier.name))).all())
    marks = (
        (await session.execute(select(DailyResourceStatus).where(DailyResourceStatus.day == day)))
        .scalars()
        .all()
    )
    truck_marks = {m.truck_id: m for m in marks if m.truck_id is not None}
    driver_marks = {m.driver_id: m for m in marks if m.driver_id is not None}
    daily = (
        (await session.execute(select(DailyTruckDriver).where(DailyTruckDriver.day == day))).scalars().all()
    )

    truck_days: dict[uuid.UUID, TruckDay] = {}
    for truck in trucks:
        mark = truck_marks.get(truck.id)
        available_today = mark.available if mark else True
        truck_days[truck.id] = TruckDay(
            truck=truck,
            carrier_name=carriers.get(truck.carrier_id),
            available_today=available_today,
            day_reason=mark.reason if mark and not mark.available else None,
            block_reason=truck_block_reason(truck_domain(truck, available_today)),
        )

    driver_days: dict[uuid.UUID, DriverDay] = {}
    for driver in drivers:
        mark = driver_marks.get(driver.id)
        available_today = mark.available if mark else True
        domain = driver_domain(driver, available_today)
        default_truck = truck_days.get(driver.default_truck_id)
        driver_days[driver.id] = DriverDay(
            driver=driver,
            carrier_name=carriers.get(driver.carrier_id),
            available_today=available_today,
            day_reason=mark.reason if mark and not mark.available else None,
            block_reason=driver_unavailable_reason(domain, day),
            rm03_reason=driver_block_reason(domain, day),
            default_truck=default_truck.truck if default_truck else None,
        )

    def _link(driver_day: DriverDay, truck_day: TruckDay, source: str) -> None:
        driver_day.truck, driver_day.assignment_source = truck_day.truck, source
        truck_day.driver, truck_day.assignment_source = driver_day.driver, source

    # 1. Les affectations du jour font foi.
    for row in daily:
        if row.driver_id in driver_days and row.truck_id in truck_days:
            _link(driver_days[row.driver_id], truck_days[row.truck_id], "daily")
    # 2. Sinon le camion habituel, s'il est encore libre ; les chauffeurs affectables sont servis d'abord.
    pending = [d for d in driver_days.values() if d.truck is None and d.default_truck is not None]
    for driver_day in sorted(pending, key=lambda d: not d.assignable):
        truck_day = truck_days[driver_day.default_truck.id]
        if truck_day.driver is None:
            _link(driver_day, truck_day, "default")

    return DayResources(day=day, trucks=list(truck_days.values()), drivers=list(driver_days.values()))


# --- Stocks dépôt ----------------------------------------------------------------------------


async def current_depot_stocks(
    session: AsyncSession, day: date
) -> dict[tuple[uuid.UUID, uuid.UUID], DailyDepotStock]:
    """Saisie qui fait foi (la plus récente) pour chaque (dépôt, produit) renseigné le jour J."""
    rows = (
        (
            await session.execute(
                select(DailyDepotStock)
                .where(DailyDepotStock.day == day)
                .order_by(DailyDepotStock.entered_at, DailyDepotStock.id)
            )
        )
        .scalars()
        .all()
    )
    # Parcours chronologique : la dernière saisie de chaque couple remplace les précédentes.
    return {(row.depot_id, row.product_id): row for row in rows}


async def depot_stock_counts(session: AsyncSession, day: date) -> dict[tuple[uuid.UUID, uuid.UUID], int]:
    """Nombre de saisies conservées par (dépôt, produit) pour le jour J."""
    rows = await session.execute(
        select(DailyDepotStock.depot_id, DailyDepotStock.product_id, func.count())
        .where(DailyDepotStock.day == day)
        .group_by(DailyDepotStock.depot_id, DailyDepotStock.product_id)
    )
    return {(depot_id, product_id): count for depot_id, product_id, count in rows}


async def record_depot_stock(
    session: AsyncSession,
    *,
    depot_id: uuid.UUID,
    product_id: uuid.UUID,
    day: date,
    available_l: Decimal | float,
    user_id: uuid.UUID | None,
) -> DailyDepotStock:
    """Ajoute une saisie de stock (F2.1). Les saisies précédentes sont conservées ; la plus
    récente fait foi."""
    entry = DailyDepotStock(
        depot_id=depot_id,
        product_id=product_id,
        day=day,
        available_l=Decimal(str(available_l)),
        entered_at=utcnow(),
        entered_by=user_id,
    )
    session.add(entry)
    await session.flush()
    return entry
