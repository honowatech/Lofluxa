"""Comparaison de deux plans (F8.4) et rejeu d'une journée de référence (F8.2).

Lecture seule sur les plans : on charge un plan et ses référentiels (`PlanBundle`), on en tire la
vue pure attendue par `metrics.py` et les tracés des tournées pour les cartes de l'écran 9.
Le rejeu passe uniquement par `app.planning.service.launch_compute` (contrat du lot L5).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.comparison import metrics as m
from app.core.enums import PlanKind, Severity
from app.core.errors import ConflictError, NotFoundError
from app.core.geo import latlon
from app.core.settings_store import get_setting
from app.orders.models import Order
from app.planning import service as plan_service
from app.planning.models import Plan, Stop, Trip
from app.referentials.models import Depot, Driver, Product, Station, Truck

# Couleurs des tournées sur les cartes (présentation ; cyclique au-delà de dix tournées).
ROUTE_COLORS = (
    "#1f77b4",
    "#d62728",
    "#2ca02c",
    "#ff7f0e",
    "#9467bd",
    "#8c564b",
    "#e377c2",
    "#17becf",
    "#bcbd22",
    "#7f7f7f",
)

KIND_LABELS = {
    PlanKind.COMPUTED: "Plan calculé",
    PlanKind.MANUAL_REFERENCE: "Plan manuel de référence",
    PlanKind.REPLAY: "Rejeu calculé",
}


@dataclass(slots=True)
class PlanBundle:
    """Un plan et tout ce qu'il référence, chargés une fois."""

    plan: Plan
    trucks: dict[uuid.UUID, Truck] = field(default_factory=dict)
    drivers: dict[uuid.UUID, Driver] = field(default_factory=dict)
    depots: dict[uuid.UUID, Depot] = field(default_factory=dict)
    stations: dict[uuid.UUID, Station] = field(default_factory=dict)
    products: dict[uuid.UUID, Product] = field(default_factory=dict)
    orders: dict[uuid.UUID, Order] = field(default_factory=dict)

    @property
    def trips(self) -> list[Trip]:
        return sorted(self.plan.trips, key=lambda t: t.seq)

    @property
    def title(self) -> str:
        return self.plan.label or f"{KIND_LABELS.get(self.plan.kind, self.plan.kind)} v{self.plan.version}"


async def _by_id(session: AsyncSession, model: Any, ids: set[uuid.UUID]) -> dict[uuid.UUID, Any]:
    if not ids:
        return {}
    rows = (await session.execute(select(model).where(model.id.in_(ids)))).scalars().all()
    return {row.id: row for row in rows}


async def load_bundle(session: AsyncSession, plan_id: uuid.UUID) -> PlanBundle:
    plan = (
        await session.execute(
            select(Plan)
            .where(Plan.id == plan_id)
            .options(
                selectinload(Plan.trips).selectinload(Trip.stops).selectinload(Stop.deliveries),
                selectinload(Plan.unserved),
                selectinload(Plan.violations),
            )
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if plan is None:
        raise NotFoundError(f"Plan introuvable : {plan_id}.")

    stops = [stop for trip in plan.trips for stop in trip.stops]
    deliveries = [delivery for stop in stops for delivery in stop.deliveries]
    order_ids = {d.order_id for d in deliveries} | {u.order_id for u in plan.unserved}
    orders = await _by_id(session, Order, order_ids)
    return PlanBundle(
        plan=plan,
        trucks=await _by_id(session, Truck, {t.truck_id for t in plan.trips}),
        drivers=await _by_id(session, Driver, {t.driver_id for t in plan.trips if t.driver_id}),
        depots=await _by_id(session, Depot, {t.depot_id for t in plan.trips}),
        stations=await _by_id(
            session, Station, {s.station_id for s in stops} | {o.station_id for o in orders.values()}
        ),
        products=await _by_id(
            session, Product, {d.product_id for d in deliveries} | {o.product_id for o in orders.values()}
        ),
        orders=orders,
    )


# --------------------------------------------------------------------------- métriques


def truck_capacity_l(truck: Truck | None) -> float:
    """Capacité d'un camion pour le taux de remplissage : somme de ses compartiments (comme le
    service de plans), à défaut sa capacité totale déclarée."""
    if truck is None:
        return 0.0
    compartments = sum(float(c.capacity_l) for c in truck.compartments)
    return compartments or float(truck.total_capacity_l or 0)


def to_plan_m(bundle: PlanBundle) -> m.PlanM:
    """Vue pure du plan pour `metrics.compute_metrics`."""
    trips = []
    for trip in bundle.trips:
        truck = bundle.trucks.get(trip.truck_id)
        actual_duration = None
        if trip.actual_depart_at is not None and trip.actual_return_at is not None:
            actual_duration = int((trip.actual_return_at - trip.actual_depart_at).total_seconds())
        trips.append(
            m.TripM(
                truck_id=str(trip.truck_id),
                driver_id=str(trip.driver_id) if trip.driver_id else None,
                truck_capacity_l=truck_capacity_l(truck),
                distance_m=trip.distance_m or 0,
                duration_s=trip.duration_s or 0,
                actual_distance_m=trip.actual_distance_m,
                actual_duration_s=actual_duration,
                stops=tuple(
                    m.StopM(
                        station_id=str(stop.station_id),
                        status=str(stop.status),
                        deliveries=tuple(
                            m.DeliveryM(
                                order_id=str(d.order_id),
                                planned_l=float(d.planned_l),
                                actual_l=float(d.actual_l) if d.actual_l is not None else None,
                            )
                            for d in stop.deliveries
                        ),
                    )
                    for stop in sorted(trip.stops, key=lambda s: s.seq)
                ),
            )
        )
    plan = bundle.plan
    return m.PlanM(
        trips=tuple(trips),
        orders=tuple(
            m.OrderM(id=str(o.id), station_id=str(o.station_id), requested_l=float(o.requested_l))
            for o in bundle.orders.values()
        ),
        violations_blocking=sum(1 for v in plan.violations if v.severity == Severity.BLOCKING),
        violations_warning=sum(1 for v in plan.violations if v.severity == Severity.WARNING),
        prep_time_s=plan.prep_time_s,
        computed_in_ms=plan.computed_in_ms,
    )


def plan_metrics(bundle: PlanBundle) -> m.PlanMetrics:
    return m.compute_metrics(to_plan_m(bundle))


# --------------------------------------------------------------------------- tracés et annexes


def _name(driver: Driver | None) -> str | None:
    return driver.full_name if driver else None


def plan_summary(bundle: PlanBundle) -> dict[str, Any]:
    plan = bundle.plan
    return {
        "id": plan.id,
        "day": plan.day,
        "kind": plan.kind,
        "status": plan.status,
        "version": plan.version,
        "label": plan.label,
        "title": bundle.title,
        "approximate": plan.approximate,
        "parent_plan_id": plan.parent_plan_id,
        "engine_version": plan.engine_version,
        "computed_at": plan.computed_at,
    }


def plan_routes(bundle: PlanBundle) -> list[dict[str, Any]]:
    """Tracé de chaque tournée : dépôt → arrêts dans l'ordre → dépôt, en `lat` / `lon`.

    Détail par arrêt (livraisons, heures) inclus : il sert aussi aux annexes du rapport PDF."""
    routes = []
    for index, trip in enumerate(t for t in bundle.trips if t.stops):
        depot = bundle.depots.get(trip.depot_id)
        truck = bundle.trucks.get(trip.truck_id)
        depot_point = None
        if depot is not None:
            lat, lon = latlon(depot.location)
            depot_point = {
                "kind": "depot",
                "lat": lat,
                "lon": lon,
                "code": depot.code,
                "name": depot.name,
                "seq": None,
                "station_id": None,
            }
        points = [depot_point] if depot_point else []
        stops = []
        for stop in sorted(trip.stops, key=lambda s: s.seq):
            station = bundle.stations.get(stop.station_id)
            if station is not None:
                lat, lon = latlon(station.location)
                points.append(
                    {
                        "kind": "station",
                        "lat": lat,
                        "lon": lon,
                        "code": station.code,
                        "name": station.name,
                        "seq": stop.seq,
                        "station_id": station.id,
                    }
                )
            stops.append(
                {
                    "stop_id": stop.id,
                    "seq": stop.seq,
                    "station_id": stop.station_id,
                    "station_code": station.code if station else None,
                    "station_name": station.name if station else None,
                    "status": stop.status,
                    "planned_arrival_at": stop.planned_arrival_at,
                    "planned_departure_at": stop.planned_departure_at,
                    "actual_arrival_at": stop.actual_arrival_at,
                    "actual_departure_at": stop.actual_departure_at,
                    "distance_from_prev_m": stop.distance_from_prev_m,
                    "deliveries": [
                        {
                            "order_id": d.order_id,
                            "product_id": d.product_id,
                            "product_code": getattr(bundle.products.get(d.product_id), "code", None),
                            "planned_l": float(d.planned_l),
                            "actual_l": float(d.actual_l) if d.actual_l is not None else None,
                        }
                        for d in stop.deliveries
                    ],
                }
            )
        if depot_point:
            points.append(dict(depot_point))
        volume = sum(d["planned_l"] for s in stops for d in s["deliveries"])
        capacity = truck_capacity_l(truck)
        routes.append(
            {
                "trip_id": trip.id,
                "seq": trip.seq,
                "color": ROUTE_COLORS[index % len(ROUTE_COLORS)],
                "truck_id": trip.truck_id,
                "truck_plate": truck.plate if truck else None,
                "driver_id": trip.driver_id,
                "driver_name": _name(bundle.drivers.get(trip.driver_id)) if trip.driver_id else None,
                "depot_id": trip.depot_id,
                "depot_code": depot.code if depot else None,
                "status": trip.status,
                "planned_depart_at": trip.planned_depart_at,
                "planned_return_at": trip.planned_return_at,
                "actual_depart_at": trip.actual_depart_at,
                "actual_return_at": trip.actual_return_at,
                "distance_m": trip.distance_m,
                "actual_distance_m": trip.actual_distance_m,
                "duration_s": trip.duration_s,
                "volume_planned_l": round(volume, 2),
                "fill_rate_pct": round(volume / capacity * 100, 2) if capacity > 0 else None,
                "points": points,
                "stops": stops,
            }
        )
    return routes


def plan_unserved(bundle: PlanBundle) -> list[dict[str, Any]]:
    rows = []
    for unserved in bundle.plan.unserved:
        order = bundle.orders.get(unserved.order_id)
        station = bundle.stations.get(order.station_id) if order else None
        product = bundle.products.get(order.product_id) if order else None
        rows.append(
            {
                "order_id": unserved.order_id,
                "station_code": station.code if station else None,
                "station_name": station.name if station else None,
                "product_code": product.code if product else None,
                "requested_l": float(order.requested_l) if order else None,
                "reason_code": unserved.reason_code,
                "reason_text": unserved.reason_text,
            }
        )
    return sorted(rows, key=lambda r: (r["station_code"] or "", r["product_code"] or ""))


# --------------------------------------------------------------------------- comparaison


async def build_comparison(session: AsyncSession, plan_a: uuid.UUID, plan_b: uuid.UUID) -> dict[str, Any]:
    """Tableau comparatif A / B : métriques, écarts, verdict et tracés (F8.4)."""
    bundle_a = await load_bundle(session, plan_a)
    bundle_b = await load_bundle(session, plan_b)
    metrics_a = plan_metrics(bundle_a)
    metrics_b = plan_metrics(bundle_b)
    threshold = float(await get_setting(session, "ab_success_threshold_pct"))
    return {
        "plan_a": plan_summary(bundle_a),
        "plan_b": plan_summary(bundle_b),
        "metrics_a": metrics_a,
        "metrics_b": metrics_b,
        "deltas": m.compare(metrics_a, metrics_b),
        "verdict": m.verdict(metrics_a, metrics_b, threshold),
        "routes_a": plan_routes(bundle_a),
        "routes_b": plan_routes(bundle_b),
        "unserved_a": plan_unserved(bundle_a),
        "unserved_b": plan_unserved(bundle_b),
    }


# --------------------------------------------------------------------------- rejeu


async def replay_reference(session: AsyncSession, plan_id: uuid.UUID, *, user_id: uuid.UUID | None) -> str:
    """F8.2 : relance le moteur sur les commandes de la journée de référence → plan `replay`.

    Renvoie le `task_id` du calcul (suivi : `GET /tasks/{task_id}`)."""
    bundle = await load_bundle(session, plan_id)
    plan = bundle.plan
    if plan.kind != PlanKind.MANUAL_REFERENCE:
        raise ConflictError("Seul un plan manuel de référence peut être rejoué.", code="not_a_reference_plan")
    if not bundle.orders:
        raise ConflictError("Ce plan de référence ne contient aucune commande à rejouer.", code="no_orders")
    return await plan_service.launch_compute(
        session,
        plan.day,
        user_id=user_id,
        kind=PlanKind.REPLAY,
        order_ids=sorted(bundle.orders),
        parent_plan_id=plan.id,
        label=f"Rejeu — {bundle.title}",
    )
