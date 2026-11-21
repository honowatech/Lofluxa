"""Lecture d'un plan pour l'API (lot L5) : plan complet avec tous les libellés utiles à l'écran
(immatriculation, chauffeur, codes et coordonnées des stations et du dépôt, produits, taux de
remplissage), pour que l'écran central n'ait qu'une requête à faire."""

from __future__ import annotations

import uuid
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import EventType, PlanKind, PlanStatus, Severity
from app.core.geo import latlon
from app.orders.models import Order
from app.planning import checking, versions
from app.planning.models import Plan, Trip
from app.planning.schemas import (
    DeliveryOut,
    LoadOut,
    PlanOut,
    PlanSummaryOut,
    StopOut,
    TripOut,
    UnservedOut,
    VersionChangeOut,
    VersionOut,
    ViolationOut,
)
from app.referentials.models import Depot, Driver, Product, Station, Truck
from app.users.models import User


@dataclass
class Labels:
    """Référentiels nécessaires à l'affichage d'un ou plusieurs plans, indexés par identifiant."""

    trucks: dict[uuid.UUID, Truck] = field(default_factory=dict)
    drivers: dict[uuid.UUID, Driver] = field(default_factory=dict)
    depots: dict[uuid.UUID, Depot] = field(default_factory=dict)
    stations: dict[uuid.UUID, Station] = field(default_factory=dict)
    products: dict[uuid.UUID, Product] = field(default_factory=dict)
    orders: dict[uuid.UUID, Order] = field(default_factory=dict)
    users: dict[uuid.UUID, User] = field(default_factory=dict)


async def _by_id(session: AsyncSession, model: type, ids: Iterable[uuid.UUID | None]) -> dict:
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    rows = await session.execute(select(model).where(model.id.in_(wanted)))
    return {row.id: row for row in rows.scalars()}


async def load_labels(session: AsyncSession, plan: Plan) -> Labels:
    orders = await _by_id(session, Order, checking.plan_order_ids(plan))
    station_ids = {s.station_id for t in plan.trips for s in t.stops} | {
        o.station_id for o in orders.values()
    }
    product_ids = (
        {d.product_id for t in plan.trips for s in t.stops for d in s.deliveries}
        | {x.product_id for t in plan.trips for x in t.compartment_loads}
        | {o.product_id for o in orders.values()}
    )
    return Labels(
        trucks=await _by_id(session, Truck, (t.truck_id for t in plan.trips)),
        drivers=await _by_id(session, Driver, (t.driver_id for t in plan.trips)),
        depots=await _by_id(session, Depot, (t.depot_id for t in plan.trips)),
        stations=await _by_id(session, Station, station_ids),
        products=await _by_id(session, Product, product_ids),
        orders=orders,
        users=await _by_id(session, User, [plan.created_by]),
    )


def _counts(plan: Plan) -> tuple[int, int]:
    blocking = sum(1 for v in plan.violations if v.severity == Severity.BLOCKING)
    return blocking, len(plan.violations) - blocking


def _summary_fields(plan: Plan, creator: User | None) -> dict:
    blocking, warning = _counts(plan)
    return dict(
        id=plan.id,
        day=plan.day,
        kind=plan.kind,
        status=plan.status,
        version=plan.version,
        root_plan_id=checking.root_id(plan),
        parent_plan_id=plan.parent_plan_id,
        label=plan.label,
        approximate=plan.approximate,
        engine_version=plan.engine_version,
        computed_at=plan.computed_at,
        computed_in_ms=plan.computed_in_ms,
        prep_time_s=plan.prep_time_s,
        metrics=plan.metrics,
        blocking_count=blocking,
        warning_count=warning,
        publishable=plan.status == PlanStatus.DRAFT and plan.kind == PlanKind.COMPUTED and blocking == 0,
        created_at=plan.created_at,
        updated_at=plan.updated_at,
        created_by=plan.created_by,
        created_by_name=creator.full_name if creator else None,
    )


def plan_summary(plan: Plan, creator: User | None = None) -> PlanSummaryOut:
    return PlanSummaryOut(**_summary_fields(plan, creator))


def trip_out(trip: Trip, labels: Labels, violations: Counter | None = None) -> TripOut:
    truck = labels.trucks.get(trip.truck_id)
    driver = labels.drivers.get(trip.driver_id) if trip.driver_id else None
    depot = labels.depots.get(trip.depot_id)
    depot_pos = latlon(depot.location) if depot is not None else None
    compartments = {c.id: c for c in truck.compartments} if truck is not None else {}
    capacity = float(sum(c.capacity_l for c in truck.compartments)) if truck is not None else None
    planned = checking.trip_planned_l(trip)

    stops = []
    for stop in sorted(trip.stops, key=lambda s: s.seq):
        station = labels.stations.get(stop.station_id)
        position = latlon(station.location) if station is not None else None
        deliveries = []
        for delivery in stop.deliveries:
            product = labels.products.get(delivery.product_id)
            order = labels.orders.get(delivery.order_id)
            deliveries.append(
                DeliveryOut(
                    id=delivery.id,
                    order_id=delivery.order_id,
                    product_id=delivery.product_id,
                    product_code=product.code if product else None,
                    product_label=product.label if product else None,
                    product_color=product.color if product else None,
                    planned_l=float(delivery.planned_l),
                    actual_l=float(delivery.actual_l) if delivery.actual_l is not None else None,
                    requested_l=float(order.requested_l) if order else None,
                    priority=order.priority if order else None,
                    order_status=order.status if order else None,
                )
            )
        deliveries.sort(key=lambda d: (d.product_code or "", str(d.order_id)))
        stops.append(
            StopOut(
                id=stop.id,
                seq=stop.seq,
                station_id=stop.station_id,
                station_code=station.code if station else None,
                station_name=station.name if station else None,
                station_city=station.city if station else None,
                contact_name=station.contact_name if station else None,
                contact_phone=station.contact_phone if station else None,
                lat=position[0] if position else None,
                lon=position[1] if position else None,
                planned_arrival_at=stop.planned_arrival_at,
                planned_departure_at=stop.planned_departure_at,
                distance_from_prev_m=stop.distance_from_prev_m,
                status=stop.status,
                actual_arrival_at=stop.actual_arrival_at,
                actual_departure_at=stop.actual_departure_at,
                skip_reason=stop.skip_reason,
                planned_l=float(sum(d.planned_l for d in stop.deliveries)),
                deliveries=deliveries,
            )
        )

    loads = []
    for load in trip.compartment_loads:
        product = labels.products.get(load.product_id)
        compartment = compartments.get(load.compartment_id)
        loads.append(
            LoadOut(
                id=load.id,
                compartment_id=load.compartment_id,
                compartment_position=compartment.position if compartment else None,
                capacity_l=float(compartment.capacity_l) if compartment else None,
                product_id=load.product_id,
                product_code=product.code if product else None,
                product_label=product.label if product else None,
                product_color=product.color if product else None,
                planned_l=float(load.planned_l),
            )
        )
    loads.sort(key=lambda x: x.compartment_position if x.compartment_position is not None else 0)

    violations = violations or Counter()
    return TripOut(
        id=trip.id,
        seq=trip.seq,
        truck_id=trip.truck_id,
        truck_plate=truck.plate if truck else None,
        truck_size=truck.size if truck else None,
        truck_capacity_l=capacity,
        driver_id=trip.driver_id,
        driver_name=driver.full_name if driver else None,
        driver_phone=driver.phone if driver else None,
        depot_id=trip.depot_id,
        depot_code=depot.code if depot else None,
        depot_name=depot.name if depot else None,
        depot_lat=depot_pos[0] if depot_pos else None,
        depot_lon=depot_pos[1] if depot_pos else None,
        planned_start_at=trip.planned_start_at,
        planned_depart_at=trip.planned_depart_at,
        planned_return_at=trip.planned_return_at,
        distance_m=trip.distance_m,
        duration_s=trip.duration_s,
        locked=trip.locked,
        status=trip.status,
        actual_depart_at=trip.actual_depart_at,
        actual_return_at=trip.actual_return_at,
        actual_distance_m=trip.actual_distance_m,
        planned_l=planned,
        fill_rate=checking.fill_rate(planned, capacity),
        blocking_count=violations[(trip.id, Severity.BLOCKING.value)],
        warning_count=violations[(trip.id, Severity.WARNING.value)],
        stops=stops,
        loads=loads,
    )


async def plan_out(session: AsyncSession, plan: Plan) -> PlanOut:
    """Plan complet (chargé par `checking.load_plan`) → réponse de l'API."""
    labels = await load_labels(session, plan)
    per_trip: Counter = Counter(
        (v.trip_id, Severity(v.severity).value) for v in plan.violations if v.trip_id is not None
    )
    trips = sorted(plan.trips, key=lambda t: t.seq)
    trip_seq = {t.id: t.seq for t in trips}
    stop_seq = {s.id: s.seq for t in trips for s in t.stops}

    unserved = []
    for row in plan.unserved:
        order = labels.orders.get(row.order_id)
        station = labels.stations.get(order.station_id) if order else None
        product = labels.products.get(order.product_id) if order else None
        position = latlon(station.location) if station is not None else None
        unserved.append(
            UnservedOut(
                id=row.id,
                order_id=row.order_id,
                reason_code=row.reason_code,
                reason_text=row.reason_text,
                station_id=order.station_id if order else None,
                station_code=station.code if station else None,
                station_name=station.name if station else None,
                lat=position[0] if position else None,
                lon=position[1] if position else None,
                product_id=order.product_id if order else None,
                product_code=product.code if product else None,
                product_label=product.label if product else None,
                requested_l=float(order.requested_l) if order else None,
                priority=order.priority if order else None,
                order_status=order.status if order else None,
            )
        )
    # RM-15 : les urgentes en tête.
    unserved.sort(key=lambda u: (u.priority != "urgent", u.station_code or "", str(u.order_id)))

    violations = [
        ViolationOut(
            id=v.id,
            rule_code=v.rule_code,
            severity=v.severity,
            message=v.message,
            trip_id=v.trip_id,
            trip_seq=trip_seq.get(v.trip_id),
            stop_id=v.stop_id,
            stop_seq=stop_seq.get(v.stop_id),
        )
        for v in plan.violations
    ]
    violations.sort(
        key=lambda v: (v.severity != Severity.BLOCKING, v.trip_seq or 0, v.stop_seq or 0, v.rule_code)
    )

    return PlanOut(
        **_summary_fields(plan, labels.users.get(plan.created_by)),
        params_snapshot=plan.params_snapshot,
        solver_log=plan.solver_log,
        trips=[trip_out(t, labels, per_trip) for t in trips],
        unserved=unserved,
        violations=violations,
    )


async def versions_out(session: AsyncSession, plan: Plan) -> list[VersionOut]:
    """Historique des versions de la lignée du plan (F5.5) : qui a changé quoi, quand."""
    plans = await versions.lineage(session, plan)
    events = await versions.version_events(session, [p.id for p in plans])
    user_ids = {p.created_by for p in plans} | {e.actor_id for rows in events.values() for e in rows}
    users = await _by_id(session, User, user_ids)
    published = next((p for p in plans if p.status == PlanStatus.PUBLISHED), None)
    draft = next((p for p in reversed(plans) if p.status == PlanStatus.DRAFT), None)
    current = published or draft

    out = []
    for item in plans:
        changes = []
        reason = None
        published_at = published_by = None
        for event in events[item.id]:
            payload = event.payload or {}
            actor = users.get(event.actor_id)
            if payload.get("action") in ("new_version", "restore") and reason is None:
                reason = payload.get("reason") or payload.get("summary")
            if event.type == EventType.PUBLISH:
                published_at = event.occurred_at
                published_by = actor.full_name if actor else None
            changes.append(
                VersionChangeOut(
                    id=event.id,
                    type=str(EventType(event.type).value),
                    action=payload.get("action"),
                    summary=payload.get("summary"),
                    occurred_at=event.occurred_at,
                    actor_id=event.actor_id,
                    actor_name=actor.full_name if actor else None,
                    trip_id=event.trip_id,
                    payload=payload,
                )
            )
        creator = users.get(item.created_by)
        out.append(
            VersionOut(
                plan_id=item.id,
                version=item.version,
                status=item.status,
                parent_plan_id=item.parent_plan_id,
                is_current=current is not None and item.id == current.id,
                reason=reason,
                created_at=item.created_at,
                created_by=item.created_by,
                created_by_name=creator.full_name if creator else None,
                published_at=published_at,
                published_by_name=published_by,
                metrics=item.metrics,
                changes=changes,
            )
        )
    return out
