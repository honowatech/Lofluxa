"""Métriques agrégées d'un plan (spec §7.4) — reprises par le tableau de bord et la comparaison A/B."""

from __future__ import annotations

from typing import Any

from app.planning.domain import PlanningProblem, TripD, UnservedD
from app.planning.engine.compartments import total_capacity_l


def compute_metrics(
    problem: PlanningProblem, trips: list[TripD], unserved: list[UnservedD]
) -> dict[str, Any]:
    trucks = {t.id: t for t in problem.trucks}
    margin = problem.params.compartment_safety_margin_pct
    requested = {o.id: o.requested_l for o in problem.orders}
    planned: dict[str, float] = {}
    fill_rates: list[float] = []
    for trip in trips:
        loaded = 0.0
        for stop in trip.stops:
            for delivery in stop.deliveries:
                planned[delivery.order_id] = planned.get(delivery.order_id, 0.0) + delivery.planned_l
                loaded += delivery.planned_l
        truck = trucks.get(trip.truck_id)
        capacity = total_capacity_l(truck, margin) if truck is not None else 0.0
        if capacity > 0:
            fill_rates.append(loaded / capacity)

    served = [o for o in requested if planned.get(o, 0.0) > 0]
    partial = [o for o in served if planned[o] < requested[o] - 1e-6]
    total_distance_m = sum(t.distance_m for t in trips)
    volume_requested = sum(requested.values())
    volume_planned = sum(v for o, v in planned.items() if o in requested)
    return {
        "total_distance_km": round(total_distance_m / 1000, 3),
        "trips_count": len(trips),
        "trucks_used": len({t.truck_id for t in trips}),
        "drivers_used": len({t.driver_id for t in trips if t.driver_id}),
        "stops_count": sum(len(t.stops) for t in trips),
        "orders_total": len(requested),
        "orders_served": len(served),
        "orders_partial": len(partial),
        "orders_unserved": len(unserved),
        "volume_requested_l": round(volume_requested, 3),
        "volume_planned_l": round(volume_planned, 3),
        "service_rate_pct": round(100 * volume_planned / volume_requested, 2) if volume_requested else 100.0,
        "total_service_duration_s": sum(max(0, t.return_s - t.depart_s) for t in trips),
        "avg_fill_rate_pct": round(100 * sum(fill_rates) / len(fill_rates), 2) if fill_rates else 0.0,
        "locked_trips_count": sum(1 for t in trips if t.locked),
    }
