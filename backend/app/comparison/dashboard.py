"""Tableau de bord du jour (F8.6) : avancement des tournées, retards estimés, alertes actives.

Le tableau de bord porte sur le plan publié du jour (le plus récent s'il y en a plusieurs).
Retard = heure réelle − heure prévue (positif = en retard) :
- par arrêt réalisé : `actual_arrival_at − planned_arrival_at` ;
- par tournée : écart du dernier fait connu (dernier arrêt réalisé, à défaut départ du dépôt, et
  retour au dépôt une fois la tournée terminée) ; `None` tant qu'aucune heure réelle n'est saisie.
Alertes : violations du plan publié + événements de panne, d'indisponibilité chauffeur et de
pénurie produit enregistrés ce jour-là dans `events`.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.comparison import service as comparison_service
from app.core.enums import EventType, PlanStatus, Severity, StopStatus, TripStatus
from app.core.time import utcnow
from app.events.models import Event
from app.planning.models import Plan

ALERT_EVENT_TYPES = (EventType.TRUCK_BREAKDOWN, EventType.DRIVER_UNAVAILABLE, EventType.PRODUCT_SHORTAGE)

EVENT_MESSAGES = {
    EventType.TRUCK_BREAKDOWN: "Panne de camion",
    EventType.DRIVER_UNAVAILABLE: "Chauffeur indisponible",
    EventType.PRODUCT_SHORTAGE: "Produit indisponible au dépôt",
}


def _delay(actual: datetime | None, planned: datetime | None) -> int | None:
    if actual is None or planned is None:
        return None
    return int((actual - planned).total_seconds())


async def published_plan(session: AsyncSession, day: date) -> Plan | None:
    return (
        (
            await session.execute(
                select(Plan)
                .where(Plan.day == day, Plan.status == PlanStatus.PUBLISHED)
                .order_by(Plan.version.desc(), Plan.created_at.desc(), Plan.id.desc())
                .limit(1)
            )
        )
        .scalars()
        .first()
    )


async def build_dashboard(session: AsyncSession, day: date) -> dict[str, Any]:
    plan = await published_plan(session, day)

    trips: list[dict[str, Any]] = []
    delays: list[dict[str, Any]] = []
    alerts: list[dict[str, Any]] = []
    by_status = {status.value: 0 for status in TripStatus}
    totals = {
        "stops_total": 0,
        "stops_delivered": 0,
        "stops_skipped": 0,
        "stops_pending": 0,
        "volume_planned_l": 0.0,
        "volume_delivered_l": 0.0,
    }
    plan_out = None

    if plan is not None:
        bundle = await comparison_service.load_bundle(session, plan.id)
        plan_out = comparison_service.plan_summary(bundle)
        trip_seq = {trip.id: trip.seq for trip in bundle.trips}

        for route in comparison_service.plan_routes(bundle):
            stops = route["stops"]
            delivered = [s for s in stops if s["status"] == StopStatus.DELIVERED]
            skipped = [s for s in stops if s["status"] == StopStatus.SKIPPED]
            pending = [s for s in stops if s["status"] == StopStatus.PENDING]
            volume_planned = sum(d["planned_l"] for s in stops for d in s["deliveries"])
            volume_delivered = sum(d["actual_l"] or 0.0 for s in stops for d in s["deliveries"])

            # Retard de la tournée : dernier fait réel connu, dans l'ordre chronologique.
            trip_delay = _delay(route["actual_depart_at"], route["planned_depart_at"])
            for stop in stops:
                stop_delay = _delay(stop["actual_arrival_at"], stop["planned_arrival_at"])
                if stop_delay is None:
                    continue
                trip_delay = stop_delay
                if stop_delay > 0:
                    delays.append(
                        {
                            "trip_id": route["trip_id"],
                            "trip_seq": route["seq"],
                            "truck_plate": route["truck_plate"],
                            "stop_id": stop["stop_id"],
                            "stop_seq": stop["seq"],
                            "station_code": stop["station_code"],
                            "station_name": stop["station_name"],
                            "planned_at": stop["planned_arrival_at"],
                            "actual_at": stop["actual_arrival_at"],
                            "delay_s": stop_delay,
                        }
                    )
            return_delay = _delay(route["actual_return_at"], route["planned_return_at"])
            if return_delay is not None:
                trip_delay = return_delay

            next_stop = pending[0] if pending and route["status"] != TripStatus.COMPLETED else None
            trips.append(
                {
                    "trip_id": route["trip_id"],
                    "seq": route["seq"],
                    "truck_plate": route["truck_plate"],
                    "driver_name": route["driver_name"],
                    "depot_code": route["depot_code"],
                    "status": route["status"],
                    "stops_total": len(stops),
                    "stops_delivered": len(delivered),
                    "stops_skipped": len(skipped),
                    "stops_pending": len(pending),
                    "volume_planned_l": round(volume_planned, 2),
                    "volume_delivered_l": round(volume_delivered, 2),
                    "planned_depart_at": route["planned_depart_at"],
                    "planned_return_at": route["planned_return_at"],
                    "actual_depart_at": route["actual_depart_at"],
                    "actual_return_at": route["actual_return_at"],
                    "delay_s": trip_delay,
                    "next_station_code": next_stop["station_code"] if next_stop else None,
                    "next_station_name": next_stop["station_name"] if next_stop else None,
                    "next_planned_arrival_at": next_stop["planned_arrival_at"] if next_stop else None,
                    # Arrivée estimée au prochain arrêt : heure prévue décalée du retard constaté.
                    "next_estimated_arrival_at": (
                        _shift(next_stop["planned_arrival_at"], trip_delay) if next_stop else None
                    ),
                }
            )
            by_status[str(route["status"])] = by_status.get(str(route["status"]), 0) + 1
            totals["stops_total"] += len(stops)
            totals["stops_delivered"] += len(delivered)
            totals["stops_skipped"] += len(skipped)
            totals["stops_pending"] += len(pending)
            totals["volume_planned_l"] += volume_planned
            totals["volume_delivered_l"] += volume_delivered

        for violation in sorted(
            bundle.plan.violations, key=lambda v: (v.severity != Severity.BLOCKING, v.rule_code, str(v.id))
        ):
            alerts.append(
                {
                    "source": "violation",
                    "severity": violation.severity,
                    "code": violation.rule_code,
                    "message": violation.message,
                    "trip_id": violation.trip_id,
                    "trip_seq": trip_seq.get(violation.trip_id),
                    "event_id": None,
                    "event_type": None,
                    "occurred_at": None,
                    "payload": None,
                }
            )

    events = (
        (
            await session.execute(
                select(Event)
                .where(Event.day == day, Event.type.in_(ALERT_EVENT_TYPES))
                .order_by(Event.occurred_at.desc(), Event.id.desc())
            )
        )
        .scalars()
        .all()
    )
    for event in events:
        alerts.append(
            {
                "source": "event",
                "severity": Severity.WARNING,
                "code": event.type.value,
                "message": EVENT_MESSAGES[event.type],
                "trip_id": event.trip_id,
                "trip_seq": None,
                "event_id": event.id,
                "event_type": event.type,
                "occurred_at": event.occurred_at,
                "payload": event.payload,
            }
        )

    delays.sort(key=lambda d: -d["delay_s"])
    trip_delays = [t["delay_s"] for t in trips if t["delay_s"] is not None and t["delay_s"] > 0]
    return {
        "day": day,
        "generated_at": utcnow(),
        "plan": plan_out,
        "summary": {
            "trips_total": len(trips),
            "trips_by_status": by_status,
            **{k: round(v, 2) if isinstance(v, float) else v for k, v in totals.items()},
            "trips_late": len(trip_delays),
            "max_delay_s": max(trip_delays) if trip_delays else 0,
            "alerts_blocking": sum(1 for a in alerts if a["severity"] == Severity.BLOCKING),
            "alerts_total": len(alerts),
        },
        "trips": trips,
        "delays": delays,
        "alerts": alerts,
    }


def _shift(moment: datetime | None, delay_s: int | None) -> datetime | None:
    if moment is None:
        return None
    return moment + timedelta(seconds=max(delay_s or 0, 0))
