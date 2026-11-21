"""Fabrique de données et doublures du lot L7 (plans, tournées, commandes créés par l'ORM).

Les lots L2 (matrice), L1 (règles) et L5 (service de plans) ne sont pas livrés dans cette branche :
`fake_build_problem`, `fake_build_matrix` et `fake_check_plan` les remplacent dans les tests.
Les codes du monde de test sont ceux de l'exemple du fichier modèle `reference_day.xlsx`.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import (
    OrderStatus,
    PlanKind,
    PlanStatus,
    Severity,
    StopStatus,
    TripStatus,
    TruckSize,
    UnservedReason,
)
from app.core.geo import haversine_m, latlon, point
from app.core.settings_store import load_params
from app.core.time import opening_windows, seconds_to_utc
from app.orders.models import Order
from app.planning.domain import (
    CompartmentD,
    DepotD,
    DriverD,
    Matrix,
    OrderD,
    Params,
    PlanningProblem,
    ProductD,
    StationD,
    TruckD,
    ViolationD,
)
from app.planning.models import ConstraintViolation, Plan, Stop, StopDelivery, Trip, UnservedOrder
from app.referentials.models import Carrier, Depot, Driver, Product, Station, Truck, TruckCompartment

DAY = date(2027, 1, 12)  # un mardi
OTHER_DAY = date(2027, 1, 5)

DEPOT = ("SCDP-DLA", 4.0483, 9.7043)
STATIONS = {
    "ST-DLA-001": (4.0600, 9.7200),
    "ST-DLA-002": (4.0300, 9.7600),
    "ST-DLA-003": (4.0900, 9.7400),
    "ST-DLA-004": (4.0100, 9.6900),
}


@dataclass
class World:
    products: dict[str, Product]
    depot: Depot
    stations: dict[str, Station]
    trucks: dict[str, Truck]
    drivers: dict[str, Driver]
    orders: dict[tuple[str, str], Order] = field(default_factory=dict)


async def make_world(db: AsyncSession, products: dict[str, Product]) -> World:
    carrier = Carrier(name="Transports du Wouri")
    db.add(carrier)
    await db.flush()
    depot = Depot(code=DEPOT[0], name="SCDP Douala", location=point(DEPOT[1], DEPOT[2]))
    stations = {
        code: Station(code=code, name=f"Station {code[-3:]}", city="Douala", location=point(lat, lon))
        for code, (lat, lon) in STATIONS.items()
    }
    trucks = {
        "LT-123-AA": Truck(
            plate="LT-123-AA", carrier_id=carrier.id, size=TruckSize.LARGE, total_capacity_l=Decimal("40000")
        ),
        "LT-456-BB": Truck(
            plate="LT-456-BB", carrier_id=carrier.id, size=TruckSize.MEDIUM, total_capacity_l=Decimal("20000")
        ),
    }
    for truck in trucks.values():
        half = truck.total_capacity_l / 2
        truck.compartments = [
            TruckCompartment(position=1, capacity_l=half),
            TruckCompartment(position=2, capacity_l=half),
        ]
    drivers = {
        "Jean Mbarga": Driver(
            full_name="Jean Mbarga", license_no="P-001", hazmat_cert=True, carrier_id=carrier.id
        ),
        "Paul Etoa": Driver(
            full_name="Paul Etoa", license_no="P-002", hazmat_cert=True, carrier_id=carrier.id
        ),
    }
    db.add_all([depot, *stations.values(), *trucks.values(), *drivers.values()])
    await db.flush()
    return World(products=products, depot=depot, stations=stations, trucks=trucks, drivers=drivers)


async def make_order(
    db: AsyncSession, world: World, station: str, product: str, liters: float, day: date = DAY
) -> Order:
    order = Order(
        day=day,
        station_id=world.stations[station].id,
        product_id=world.products[product].id,
        requested_l=Decimal(str(liters)),
        status=OrderStatus.CONFIRMED,
    )
    db.add(order)
    await db.flush()
    world.orders[(station, product)] = order
    return order


def at(hm: str, day: date = DAY) -> datetime:
    """Heure locale Africa/Douala « HH:MM » du jour → UTC."""
    hours, minutes = hm.split(":")
    return seconds_to_utc(day, int(hours) * 3600 + int(minutes) * 60)


async def make_plan(
    db: AsyncSession,
    world: World,
    trips: list[dict],
    *,
    day: date = DAY,
    kind: PlanKind = PlanKind.COMPUTED,
    status: PlanStatus = PlanStatus.DRAFT,
    unserved: list[Order] = (),
    violations: list[tuple[str, Severity, str, int | None]] = (),
    **plan_fields,
) -> Plan:
    """Crée un plan par l'ORM.

    `trips` : [{"truck": plaque, "driver": nom | None, "distance_m": …, "duration_s": …,
                "depart": "HH:MM", "return": "HH:MM", "status": …, champs réels…,
                "stops": [{"station": code, "arrival": "HH:MM", "status": …, "actual_arrival": "HH:MM",
                           "deliveries": [(commande, litres prévus, litres réels | None)]}]}]
    `violations` : (code, sévérité, message, numéro de tournée | None).
    """
    plan = Plan(day=day, kind=kind, status=status, **plan_fields)
    for seq, spec in enumerate(trips, start=1):
        trip = Trip(
            seq=seq,
            truck_id=world.trucks[spec["truck"]].id,
            driver_id=world.drivers[spec["driver"]].id if spec.get("driver") else None,
            depot_id=world.depot.id,
            distance_m=spec.get("distance_m", 0),
            duration_s=spec.get("duration_s", 0),
            status=spec.get("status", TripStatus.PLANNED),
            planned_depart_at=at(spec["depart"], day) if spec.get("depart") else None,
            planned_return_at=at(spec["return"], day) if spec.get("return") else None,
            actual_depart_at=at(spec["actual_depart"], day) if spec.get("actual_depart") else None,
            actual_return_at=at(spec["actual_return"], day) if spec.get("actual_return") else None,
            actual_distance_m=spec.get("actual_distance_m"),
        )
        for stop_seq, stop_spec in enumerate(spec.get("stops", []), start=1):
            arrival = at(stop_spec["arrival"], day) if stop_spec.get("arrival") else None
            stop = Stop(
                seq=stop_seq,
                station_id=world.stations[stop_spec["station"]].id,
                status=stop_spec.get("status", StopStatus.PENDING),
                planned_arrival_at=arrival,
                planned_departure_at=arrival + timedelta(minutes=45) if arrival else None,
                actual_arrival_at=at(stop_spec["actual_arrival"], day)
                if stop_spec.get("actual_arrival")
                else None,
                distance_from_prev_m=stop_spec.get("distance_from_prev_m", 0),
            )
            for order, planned, actual in stop_spec.get("deliveries", []):
                stop.deliveries.append(
                    StopDelivery(
                        order_id=order.id,
                        product_id=order.product_id,
                        planned_l=Decimal(str(planned)),
                        actual_l=Decimal(str(actual)) if actual is not None else None,
                    )
                )
            trip.stops.append(stop)
        plan.trips.append(trip)
    for order in unserved:
        plan.unserved.append(
            UnservedOrder(
                order_id=order.id, reason_code=UnservedReason.NO_TRUCK, reason_text="Flotte épuisée."
            )
        )
    db.add(plan)
    await db.flush()
    for code, severity, message, trip_seq in violations:
        trip = next((t for t in plan.trips if t.seq == trip_seq), None)
        db.add(
            ConstraintViolation(
                plan_id=plan.id,
                rule_code=code,
                severity=severity,
                message=message,
                trip_id=trip.id if trip else None,
            )
        )
    await db.flush()
    return plan


# --------------------------------------------------------------------------- doublures L1 / L2 / L5


async def fake_build_problem(
    session: AsyncSession,
    day: date,
    *,
    params_override: dict | None = None,
    order_ids: list[uuid.UUID] | None = None,
) -> PlanningProblem:
    """Doublure de `app.planning.service.build_problem` (lot L5) : base → domaine, sans filtrage."""

    async def _all(model):
        return (await session.execute(select(model))).scalars().all()

    orders = [o for o in await _all(Order) if o.day == day and (order_ids is None or o.id in order_ids)]
    return PlanningProblem(
        day=day,
        products=[ProductD(str(p.id), p.code, p.label) for p in await _all(Product)],
        depots=[
            DepotD(str(d.id), d.code, *latlon(d.location), windows=opening_windows(d.opening_hours, day))
            for d in await _all(Depot)
        ],
        stations=[
            StationD(str(s.id), s.code, *latlon(s.location), windows=opening_windows(s.opening_hours, day))
            for s in await _all(Station)
        ],
        trucks=[
            TruckD(
                str(t.id),
                t.plate,
                t.size,
                tuple(CompartmentD(str(c.id), c.position, float(c.capacity_l)) for c in t.compartments),
            )
            for t in await _all(Truck)
        ],
        drivers=[DriverD(str(d.id), d.full_name) for d in await _all(Driver)],
        orders=[
            OrderD(str(o.id), str(o.station_id), str(o.product_id), float(o.requested_l)) for o in orders
        ],
        params=await load_params(session, params_override),
    )


def fake_build_matrix(nodes, params: Params, *, osrm_url=None, cache=None) -> Matrix:
    """Doublure de `build_matrix` (lot L2) : repli haversine × coefficient, vitesse par défaut."""
    speed_ms = params.default_avg_speed_kmh / 3.6
    distances = [
        [round(haversine_m(a[1], a[2], b[1], b[2]) * params.haversine_factor) for b in nodes] for a in nodes
    ]
    durations = [[round(d / speed_ms) for d in row] for row in distances]
    return Matrix(tuple(n[0] for n in nodes), distances, durations, approximate=True)


def fake_check_plan(problem, trips, unserved=None, matrix=None) -> list[ViolationD]:
    """Doublure de `rules.check_plan` (lot L1) : un avertissement sur le premier arrêt de la tournée 1."""
    if not trips:
        return []
    return [
        ViolationD(
            "RM-10", Severity.WARNING, "Arrivée hors fenêtre (doublure de test).", trip_seq=1, stop_seq=1
        )
    ]


def leg_m(a: tuple[float, float], b: tuple[float, float], factor: float = 1.3) -> int:
    return round(haversine_m(a[0], a[1], b[0], b[1]) * factor)
