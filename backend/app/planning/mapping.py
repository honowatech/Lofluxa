"""Conversion base ↔ domaine du moteur (lot L5).

- base → domaine : `assemble_problem` (problème du jour J), `trip_to_domain` (tournée persistée) ;
- domaine → base : `new_trip_row`, `apply_trip_schedule` ;
- matrice : `build_plan_matrix` (OSRM + cache `distance_cache`, repli haversine côté moteur).

RM-20 : le domaine raisonne en secondes depuis minuit local du jour J, la base stocke de l'UTC.
La conversion se fait ici, et nulle part ailleurs dans le service de plans.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Iterable
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.availability import service as availability_service
from app.core.config import get_config
from app.core.enums import PlanKind, PlanStatus, StopStatus
from app.core.geo import latlon
from app.core.time import hm_to_seconds, opening_windows, seconds_to_utc, utc_to_seconds
from app.orders.models import Order
from app.planning.distance_cache import DbDistanceCache
from app.planning.domain import (
    DAY_S,
    CompartmentD,
    CompartmentLoadD,
    DeliveryD,
    DepotD,
    DriverD,
    Matrix,
    OrderD,
    Params,
    PlanningProblem,
    ProductD,
    StationD,
    StopD,
    TripD,
    TruckD,
)
from app.planning.engine import distance_matrix
from app.planning.models import Plan, Stop, StopDelivery, Trip, TripCompartmentLoad
from app.referentials.models import Depot, Driver, Product, Station, Truck

# --------------------------------------------------------------------------- temps (RM-20)


def to_utc(day: date, seconds: int, tz_name: str) -> datetime:
    """Secondes depuis minuit local du jour J → horodatage UTC à stocker."""
    return seconds_to_utc(day, seconds, tz_name)


def to_seconds(day: date, moment: datetime | None, tz_name: str) -> int:
    """Horodatage UTC stocké → secondes depuis minuit local du jour J (0 si non renseigné)."""
    if moment is None:
        return 0
    return utc_to_seconds(day, moment, tz_name)


def liters(value: float) -> Decimal:
    return Decimal(str(round(float(value), 2)))


# --------------------------------------------------------------------------- base → domaine


def product_to_domain(row: Product) -> ProductD:
    return ProductD(id=str(row.id), code=row.code, label=row.label)


def depot_to_domain(row: Depot, day: date) -> DepotD:
    lat, lon = latlon(row.location)
    return DepotD(
        id=str(row.id),
        code=row.code,
        lat=lat,
        lon=lon,
        windows=opening_windows(row.opening_hours, day),
        avg_wait_min=row.avg_wait_min,
        max_loadings_per_truck_day=row.max_loadings_per_truck_day,
        name=row.name,
    )


def station_to_domain(row: Station, day: date) -> StationD:
    lat, lon = latlon(row.location)
    return StationD(
        id=str(row.id),
        code=row.code,
        lat=lat,
        lon=lon,
        windows=opening_windows(row.opening_hours, day),
        max_truck_size=row.max_truck_size,
        unload_time_min=row.unload_time_min,
        name=row.name,
    )


def truck_to_domain(row: Truck, available_today: bool = True) -> TruckD:
    compartments = tuple(
        CompartmentD(
            id=str(c.id),
            position=c.position,
            capacity_l=float(c.capacity_l),
            allowed_product_ids=(
                None if c.allowed_product_ids is None else frozenset(str(p) for p in c.allowed_product_ids)
            ),
        )
        for c in sorted(row.compartments, key=lambda c: c.position)
    )
    return TruckD(
        id=str(row.id),
        plate=row.plate,
        size=row.size,
        compartments=compartments,
        carrier_id=str(row.carrier_id) if row.carrier_id else None,
        avg_speed_kmh=float(row.avg_speed_kmh) if row.avg_speed_kmh is not None else None,
        status=row.status,
        available_today=available_today,
    )


def driver_to_domain(row: Driver, available_today: bool = True) -> DriverD:
    return DriverD(
        id=str(row.id),
        full_name=row.full_name,
        carrier_id=str(row.carrier_id) if row.carrier_id else None,
        license_expiry=row.license_expiry,
        hazmat_cert=row.hazmat_cert,
        hazmat_expiry=row.hazmat_expiry,
        status=str(row.status.value if hasattr(row.status, "value") else row.status),
        available_today=available_today,
        default_truck_id=str(row.default_truck_id) if row.default_truck_id else None,
    )


def order_to_domain(row: Order, requested_l: float | None = None) -> OrderD:
    window = None
    if row.window_start is not None or row.window_end is not None:
        start = hm_to_seconds(row.window_start) if row.window_start is not None else 0
        end = hm_to_seconds(row.window_end) if row.window_end is not None else DAY_S
        window = (start, end)
    return OrderD(
        id=str(row.id),
        station_id=str(row.station_id),
        product_id=str(row.product_id),
        requested_l=float(row.requested_l) if requested_l is None else requested_l,
        priority=row.priority,
        window=window,
    )


def trip_to_domain(row: Trip, day: date, tz_name: str) -> TripD:
    """Tournée persistée → domaine (`ref` = identifiants en base)."""
    stops = [
        StopD(
            seq=stop.seq,
            station_id=str(stop.station_id),
            arrival_s=to_seconds(day, stop.planned_arrival_at, tz_name),
            departure_s=to_seconds(day, stop.planned_departure_at, tz_name),
            distance_from_prev_m=stop.distance_from_prev_m,
            deliveries=[
                DeliveryD(
                    order_id=str(d.order_id), product_id=str(d.product_id), planned_l=float(d.planned_l)
                )
                for d in stop.deliveries
            ],
            status=str(StopStatus(stop.status).value),
            ref=str(stop.id),
        )
        for stop in sorted(row.stops, key=lambda s: s.seq)
    ]
    loads = [
        CompartmentLoadD(
            compartment_id=str(load.compartment_id),
            product_id=str(load.product_id),
            planned_l=float(load.planned_l),
        )
        for load in row.compartment_loads
    ]
    return TripD(
        seq=row.seq,
        truck_id=str(row.truck_id),
        depot_id=str(row.depot_id),
        driver_id=str(row.driver_id) if row.driver_id else None,
        start_s=to_seconds(day, row.planned_start_at, tz_name),
        depart_s=to_seconds(day, row.planned_depart_at, tz_name),
        return_s=to_seconds(day, row.planned_return_at, tz_name),
        distance_m=row.distance_m,
        duration_s=row.duration_s,
        stops=stops,
        loads=loads,
        locked=row.locked,
        ref=str(row.id),
    )


# --------------------------------------------------------------------------- domaine → base


def new_trip_row(trip: TripD, day: date, tz_name: str, *, seq: int | None = None) -> Trip:
    """Crée la tournée (arrêts, livraisons, chargement) à partir du domaine. À rattacher à un plan."""
    row = Trip(
        seq=trip.seq if seq is None else seq,
        truck_id=uuid.UUID(trip.truck_id),
        driver_id=uuid.UUID(trip.driver_id) if trip.driver_id else None,
        depot_id=uuid.UUID(trip.depot_id),
        planned_start_at=to_utc(day, trip.start_s, tz_name),
        planned_depart_at=to_utc(day, trip.depart_s, tz_name),
        planned_return_at=to_utc(day, trip.return_s, tz_name),
        distance_m=int(trip.distance_m),
        duration_s=int(trip.duration_s),
        locked=trip.locked,
    )
    for index, stop in enumerate(trip.stops, start=1):
        stop_row = Stop(
            seq=index,
            station_id=uuid.UUID(stop.station_id),
            planned_arrival_at=to_utc(day, stop.arrival_s, tz_name),
            planned_departure_at=to_utc(day, stop.departure_s, tz_name),
            distance_from_prev_m=int(stop.distance_from_prev_m),
            status=StopStatus(stop.status),
        )
        for delivery in stop.deliveries:
            stop_row.deliveries.append(
                StopDelivery(
                    order_id=uuid.UUID(delivery.order_id),
                    product_id=uuid.UUID(delivery.product_id),
                    planned_l=liters(delivery.planned_l),
                )
            )
        row.stops.append(stop_row)
    for load in trip.loads:
        row.compartment_loads.append(_load_row(load))
    return row


def _load_row(load: CompartmentLoadD) -> TripCompartmentLoad:
    return TripCompartmentLoad(
        compartment_id=uuid.UUID(load.compartment_id),
        product_id=uuid.UUID(load.product_id),
        planned_l=liters(load.planned_l),
    )


def apply_trip_schedule(row: Trip, trip: TripD, day: date, tz_name: str) -> None:
    """Reporte sur la tournée persistée les horaires, distances et le plan de chargement du domaine.

    Les arrêts sont appariés par `StopD.ref`. Seules les valeurs réellement différentes sont
    écrites (pas de bruit dans le journal d'audit)."""
    row.planned_start_at = to_utc(day, trip.start_s, tz_name)
    row.planned_depart_at = to_utc(day, trip.depart_s, tz_name)
    row.planned_return_at = to_utc(day, trip.return_s, tz_name)
    row.distance_m = int(trip.distance_m)
    row.duration_s = int(trip.duration_s)
    stops_by_id = {str(s.id): s for s in row.stops}
    for stop in trip.stops:
        stop_row = stops_by_id[stop.ref]
        stop_row.seq = stop.seq
        stop_row.planned_arrival_at = to_utc(day, stop.arrival_s, tz_name)
        stop_row.planned_departure_at = to_utc(day, stop.departure_s, tz_name)
        stop_row.distance_from_prev_m = int(stop.distance_from_prev_m)

    current = sorted(
        (str(x.compartment_id), str(x.product_id), liters(x.planned_l)) for x in row.compartment_loads
    )
    wanted = sorted((x.compartment_id, x.product_id, liters(x.planned_l)) for x in trip.loads)
    if current != wanted:
        row.compartment_loads.clear()
        for load in trip.loads:
            row.compartment_loads.append(_load_row(load))


# --------------------------------------------------------------------------- problème du jour


async def planned_elsewhere(
    session: AsyncSession,
    order_ids: Iterable[uuid.UUID],
    *,
    exclude_root_id: uuid.UUID | None = None,
) -> dict[uuid.UUID, float]:
    """Volume déjà planifié par commande dans les plans `published` (RM-16, reliquat), hors arrêts
    sautés (`skipped`).

    `exclude_root_id` : lignée de versions à ignorer (le plan en cours de modification)."""
    ids = list(order_ids)
    if not ids:
        return {}
    stmt = (
        select(StopDelivery.order_id, func.sum(StopDelivery.planned_l))
        .join(Stop, Stop.id == StopDelivery.stop_id)
        .join(Trip, Trip.id == Stop.trip_id)
        .join(Plan, Plan.id == Trip.plan_id)
        .where(
            StopDelivery.order_id.in_(ids),
            Plan.status == PlanStatus.PUBLISHED,
            Plan.kind == PlanKind.COMPUTED,
            # Un arrêt sauté ne livre rien : sa commande reste entièrement à planifier.
            Stop.status != StopStatus.SKIPPED,
        )
        .group_by(StopDelivery.order_id)
    )
    if exclude_root_id is not None:
        stmt = stmt.where(func.coalesce(Plan.root_plan_id, Plan.id) != exclude_root_id)
    return {order_id: float(total) for order_id, total in (await session.execute(stmt)).all()}


async def committed_depot_volumes(
    session: AsyncSession, day: date, *, exclude_root_id: uuid.UUID | None = None
) -> dict[tuple[str, str], float]:
    """Volume déjà engagé par (dépôt, produit) dans les plans `published` calculés du jour J
    (RM-08 : le stock saisi vaut pour tous les plans du jour). Les arrêts sautés comptent : le
    produit a quitté le dépôt. `exclude_root_id` : lignée à ignorer (le plan en cours de contrôle)."""
    stmt = (
        select(Trip.depot_id, StopDelivery.product_id, func.sum(StopDelivery.planned_l))
        .join(Stop, Stop.trip_id == Trip.id)
        .join(StopDelivery, StopDelivery.stop_id == Stop.id)
        .join(Plan, Plan.id == Trip.plan_id)
        .where(Plan.day == day, Plan.status == PlanStatus.PUBLISHED, Plan.kind == PlanKind.COMPUTED)
        .group_by(Trip.depot_id, StopDelivery.product_id)
    )
    if exclude_root_id is not None:
        stmt = stmt.where(func.coalesce(Plan.root_plan_id, Plan.id) != exclude_root_id)
    return {(str(d), str(p)): float(total) for d, p, total in (await session.execute(stmt)).all()}


def without_skipped(trips: list[TripD]) -> list[TripD]:
    """Retire (en place) les livraisons des arrêts sautés : vu des règles et du moteur, un arrêt
    sauté ne livre rien — sa commande reste à servir. L'arrêt lui-même reste dans la tournée."""
    for trip in trips:
        for stop in trip.stops:
            if stop.status == StopStatus.SKIPPED.value:
                stop.deliveries = []
    return trips


async def assemble_problem(
    session: AsyncSession,
    day: date,
    params: Params,
    orders: list[Order],
    *,
    requested: dict[uuid.UUID, float] | None = None,
    plan: Plan | None = None,
    extra_depot_ids: Iterable[uuid.UUID] = (),
    extra_truck_ids: Iterable[uuid.UUID] = (),
    extra_driver_ids: Iterable[uuid.UUID] = (),
    net_of_published: bool = False,
    exclude_root_id: uuid.UUID | None = None,
) -> PlanningProblem:
    """Assemble le problème du jour J : commandes données, toutes les ressources (avec statut et
    disponibilité du jour), affectation du jour, stock dépôt courant, fenêtres du jour.

    `net_of_published` : le stock dépôt est diminué des volumes des plans publiés calculés du jour
    (hors lignée `exclude_root_id`) — pour un calcul ou le contrôle d'un plan calculé, pas pour un rejeu.

    `plan` : les ressources, dépôts et stations qu'il référence sont inclus même s'ils ont été
    supprimés ou désactivés depuis (un plan existant doit toujours pouvoir être recontrôlé)."""
    requested = requested or {}
    # Ressources à inclure même désactivées ou supprimées depuis (rejeu, journée de référence).
    extra_trucks: set[uuid.UUID] = set(extra_truck_ids)
    extra_drivers: set[uuid.UUID] = set(extra_driver_ids)
    extra_depots: set[uuid.UUID] = set(extra_depot_ids)
    station_ids: set[uuid.UUID] = {o.station_id for o in orders}
    product_ids: set[uuid.UUID] = {o.product_id for o in orders}
    if plan is not None:
        for trip in plan.trips:
            extra_trucks.add(trip.truck_id)
            extra_depots.add(trip.depot_id)
            if trip.driver_id:
                extra_drivers.add(trip.driver_id)
            for stop in trip.stops:
                station_ids.add(stop.station_id)
                product_ids.update(d.product_id for d in stop.deliveries)

    products = (
        await session.execute(
            select(Product).where(or_(Product.deleted_at.is_(None), Product.id.in_(product_ids)))
        )
    ).scalars()
    depots = (
        await session.execute(
            select(Depot).where(
                or_((Depot.deleted_at.is_(None)) & (Depot.active.is_(True)), Depot.id.in_(extra_depots))
            )
        )
    ).scalars()
    stations = (await session.execute(select(Station).where(Station.id.in_(station_ids)))).scalars()
    # Disponibilité du jour, affectation effective chauffeur ↔ camion et stock courant : module
    # disponibilité (lot L4). S'y ajoutent les ressources supprimées que le plan référence encore.
    resources = await availability_service.load_day_resources(session, day)
    truck_rows = {t.truck.id: (t.truck, t.available_today) for t in resources.trucks}
    driver_rows = {d.driver.id: (d.driver, d.available_today) for d in resources.drivers}
    missing_trucks = extra_trucks - set(truck_rows)
    if missing_trucks:
        for truck in (await session.execute(select(Truck).where(Truck.id.in_(missing_trucks)))).scalars():
            truck_rows[truck.id] = (truck, True)
    missing_drivers = extra_drivers - set(driver_rows)
    if missing_drivers:
        for driver in (await session.execute(select(Driver).where(Driver.id.in_(missing_drivers)))).scalars():
            driver_rows[driver.id] = (driver, True)
    driver_by_truck = {str(truck_id): str(driver_id) for driver_id, truck_id in resources.assignments.items()}
    current = await availability_service.current_depot_stocks(session, day)
    stocks = {(str(depot), str(product)): float(row.available_l) for (depot, product), row in current.items()}
    if net_of_published:
        # Stock restant = stock saisi − volumes des autres plans publiés du jour (RM-08).
        committed = await committed_depot_volumes(session, day, exclude_root_id=exclude_root_id)
        for key, volume in committed.items():
            if key in stocks:
                stocks[key] = max(stocks[key] - volume, 0.0)

    return PlanningProblem(
        day=day,
        products=sorted((product_to_domain(p) for p in products), key=lambda p: p.code),
        depots=sorted((depot_to_domain(d, day) for d in depots), key=lambda d: d.code),
        stations=sorted((station_to_domain(s, day) for s in stations), key=lambda s: s.code),
        trucks=sorted((truck_to_domain(t, ok) for t, ok in truck_rows.values()), key=lambda t: t.plate),
        drivers=sorted(
            (driver_to_domain(d, ok) for d, ok in driver_rows.values()), key=lambda d: (d.full_name, d.id)
        ),
        orders=[order_to_domain(o, requested.get(o.id)) for o in sorted(orders, key=lambda o: str(o.id))],
        depot_stocks=stocks,
        driver_by_truck=driver_by_truck,
        params=params,
    )


# --------------------------------------------------------------------------- matrice


async def build_plan_matrix(session: AsyncSession, problem: PlanningProblem) -> Matrix:
    """Matrice entre tous les nœuds du problème (dépôts + stations), avec le cache en base.

    L'appel au moteur est déporté dans un fil d'exécution : il peut interroger OSRM (HTTP bloquant)."""
    nodes = [(d.id, d.lat, d.lon) for d in problem.depots] + [(s.id, s.lat, s.lon) for s in problem.stations]
    cache = DbDistanceCache()
    await cache.preload(session, [distance_matrix.coord_hash(lat, lon) for _, lat, lon in nodes])
    matrix = await asyncio.to_thread(
        distance_matrix.build_matrix,
        nodes,
        problem.params,
        osrm_url=get_config().osrm_url or None,
        cache=cache,
    )
    await cache.flush(session)
    return matrix
