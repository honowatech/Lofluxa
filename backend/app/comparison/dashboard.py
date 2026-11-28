"""Tableau de bord du jour (F8.6) : avancement des tournées, retards estimés, alertes actives.

Le tableau de bord agrège tous les plans suivis par le terrain le jour J : la version publiée de
chaque plan calculé du jour (voir `followed_plans`). Le premier créé est le plan principal (`plan`) ;
`plans` les résume tous, et chaque tournée, retard ou alerte porte l'identifiant de son plan.
Volumes : par tournée et par plan, `volume_planned_l` est tout le volume planifié et
`volume_skipped_l` celui des arrêts sautés. Dans `summary`, le volume d'un arrêt sauté repris par un
autre plan suivi du jour (`volume_replanned_l`) n'est compté qu'une fois dans `volume_planned_l` et
sort de `volume_skipped_l`, qui devient « sauté et pas encore repris ».
Retard = heure réelle − heure prévue (positif = en retard) :
- par arrêt réalisé : `actual_arrival_at − planned_arrival_at` ;
- par tournée : écart du dernier fait connu (dernier arrêt réalisé, à défaut départ du dépôt, et
  retour au dépôt une fois la tournée terminée) ; `None` tant qu'aucune heure réelle n'est saisie.
Alertes : violations du plan publié + événements de panne, d'indisponibilité chauffeur et de
pénurie produit enregistrés ce jour-là dans `events`.

Version en attente (`pending_draft`) : quand un événement ou une modification a créé une nouvelle
version du plan publié et que celle-ci est restée en brouillon (par exemple parce qu'elle garde une
violation bloquante), le terrain continue de suivre la version publiée. Le tableau de bord le dit :
une entrée de `pending_drafts` par lignée concernée (`pending_draft` = la première) et une alerte
en tête de liste, tant que le brouillon n'est pas publié.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.comparison import service as comparison_service
from app.core.enums import EventType, PlanKind, PlanStatus, Severity, StopStatus, TripStatus
from app.core.time import utcnow
from app.events.models import Event
from app.planning.models import ConstraintViolation, Plan
from app.users.models import User

ALERT_EVENT_TYPES = (EventType.TRUCK_BREAKDOWN, EventType.DRIVER_UNAVAILABLE, EventType.PRODUCT_SHORTAGE)
SHORTAGE_INACTIVE = ("resolved", "no_impact")

EVENT_MESSAGES = {
    EventType.TRUCK_BREAKDOWN: "Panne de camion",
    EventType.DRIVER_UNAVAILABLE: "Chauffeur indisponible",
    EventType.PRODUCT_SHORTAGE: "Produit indisponible au dépôt",
}


def _delay(actual: datetime | None, planned: datetime | None) -> int | None:
    if actual is None or planned is None:
        return None
    return int((actual - planned).total_seconds())


async def followed_plans(session: AsyncSession, day: date) -> list[Plan]:
    """Plans suivis par le terrain le jour J : la version en vigueur (publiée) de chaque plan calculé
    du jour. Il peut y en avoir plusieurs (plan du matin, puis plan des reliquats ou des commandes
    d'un arrêt sauté) : un par lignée de versions, dans l'ordre de création des lignées — le premier
    est le plan principal."""
    rows = (
        (
            await session.execute(
                select(Plan)
                .where(Plan.day == day, Plan.status == PlanStatus.PUBLISHED, Plan.kind == PlanKind.COMPUTED)
                .order_by(Plan.version.desc(), Plan.created_at.desc(), Plan.id.desc())
            )
        )
        .scalars()
        .all()
    )
    by_root: dict[Any, Plan] = {}
    for plan in rows:
        by_root.setdefault(plan.root_plan_id or plan.id, plan)  # version la plus haute de la lignée
    return [by_root[root] for root in sorted(by_root, key=str)]  # UUID v7 : ordre de création


async def published_plan(session: AsyncSession, day: date) -> Plan | None:
    """Plan principal du jour (première lignée publiée), ou `None`."""
    plans = await followed_plans(session, day)
    return plans[0] if plans else None


def _plural(count: int, singular: str, plural: str) -> str:
    return f"{count} {singular if count == 1 else plural}"


async def pending_draft(session: AsyncSession, plan: Plan) -> dict[str, Any] | None:
    """Version brouillon la plus récente de la lignée du plan publié (lecture seule), ou `None`."""
    root = plan.root_plan_id or plan.id
    draft = (
        (
            await session.execute(
                select(Plan)
                .where(
                    Plan.status == PlanStatus.DRAFT,
                    Plan.id != plan.id,
                    func.coalesce(Plan.root_plan_id, Plan.id) == root,
                )
                .order_by(Plan.version.desc(), Plan.created_at.desc(), Plan.id.desc())
                .limit(1)
            )
        )
        .scalars()
        .first()
    )
    if draft is None:
        return None

    counts = dict(
        (
            await session.execute(
                select(ConstraintViolation.severity, func.count())
                .where(ConstraintViolation.plan_id == draft.id)
                .group_by(ConstraintViolation.severity)
            )
        ).all()
    )
    blocking = int(counts.get(Severity.BLOCKING, 0))
    warning = int(counts.get(Severity.WARNING, 0))

    # Raison : résumé de l'incident (panne, chauffeur, pénurie) rattaché à ce brouillon s'il y en a
    # un, sinon de la première modification qui l'a créé.
    events = (
        (
            await session.execute(
                select(Event).where(Event.plan_id == draft.id).order_by(Event.occurred_at, Event.id)
            )
        )
        .scalars()
        .all()
    )
    with_summary = [e for e in events if (e.payload or {}).get("summary")]
    origin = next((e for e in with_summary if e.type in ALERT_EVENT_TYPES), None) or next(
        iter(with_summary), None
    )
    author = await session.get(User, draft.created_by) if draft.created_by else None

    if blocking:
        state = _plural(blocking, "violation bloquante", "violations bloquantes") + " à corriger"
    elif warning:
        state = "aucune violation bloquante, " + _plural(warning, "avertissement", "avertissements")
    else:
        state = "aucune violation"
    return {
        "plan_id": draft.id,
        "version": draft.version,
        "published_plan_id": plan.id,
        "published_version": plan.version,
        "created_at": draft.created_at,
        "created_by_name": author.full_name if author else None,
        "blocking_count": blocking,
        "warning_count": warning,
        "reason": origin.payload["summary"] if origin else None,
        "message": f"Version {draft.version} en attente de publication : {state}.",
    }


def _plan_section(bundle: comparison_service.PlanBundle) -> dict[str, Any]:
    """Avancement, retards et violations d'un plan suivi."""
    plan = bundle.plan
    ref = {"plan_id": plan.id, "plan_version": plan.version, "plan_label": bundle.title}
    trips: list[dict[str, Any]] = []
    delays: list[dict[str, Any]] = []
    alerts: list[dict[str, Any]] = []
    trip_seq = {trip.id: trip.seq for trip in bundle.trips}
    # Volume planifié par commande : sur les arrêts sautés d'une part, sur les autres d'autre part.
    skipped_by_order: dict[Any, float] = {}
    served_by_order: dict[Any, float] = {}

    for route in comparison_service.plan_routes(bundle):
        stops = route["stops"]
        delivered = [s for s in stops if s["status"] == StopStatus.DELIVERED]
        skipped = [s for s in stops if s["status"] == StopStatus.SKIPPED]
        waiting = [s for s in stops if s["status"] == StopStatus.PENDING]
        volume_planned = sum(d["planned_l"] for s in stops for d in s["deliveries"])
        volume_skipped = sum(d["planned_l"] for s in skipped for d in s["deliveries"])
        for stop in stops:
            bucket = skipped_by_order if stop["status"] == StopStatus.SKIPPED else served_by_order
            for d in stop["deliveries"]:
                bucket[d["order_id"]] = bucket.get(d["order_id"], 0.0) + d["planned_l"]
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
                        **ref,
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

        next_stop = waiting[0] if waiting and route["status"] != TripStatus.COMPLETED else None
        trips.append(
            {
                **ref,
                "trip_id": route["trip_id"],
                "seq": route["seq"],
                "truck_plate": route["truck_plate"],
                "driver_name": route["driver_name"],
                "depot_code": route["depot_code"],
                "status": route["status"],
                "stops_total": len(stops),
                "stops_delivered": len(delivered),
                "stops_skipped": len(skipped),
                "stops_pending": len(waiting),
                "volume_planned_l": round(volume_planned, 2),
                "volume_delivered_l": round(volume_delivered, 2),
                "volume_skipped_l": round(volume_skipped, 2),
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

    for violation in sorted(
        plan.violations, key=lambda v: (v.severity != Severity.BLOCKING, v.rule_code, str(v.id))
    ):
        alerts.append(
            {
                "source": "violation",
                "severity": violation.severity,
                "code": violation.rule_code,
                "message": violation.message,
                "plan_id": plan.id,
                "trip_id": violation.trip_id,
                "trip_seq": trip_seq.get(violation.trip_id),
                "event_id": None,
                "event_type": None,
                "occurred_at": None,
                "payload": None,
            }
        )
    return {
        "trips": trips,
        "delays": delays,
        "alerts": alerts,
        "skipped_by_order": skipped_by_order,
        "served_by_order": served_by_order,
    }


def _replanned_l(sections: list[dict[str, Any]]) -> float:
    """Volume des arrêts sautés repris par un autre plan suivi du jour (par commande : au plus le
    volume sauté). Ce volume figure dans deux plans : il n'est compté qu'une fois dans le total."""
    total = 0.0
    for index, section in enumerate(sections):
        for order_id, skipped in section["skipped_by_order"].items():
            elsewhere = sum(
                other["served_by_order"].get(order_id, 0.0) for k, other in enumerate(sections) if k != index
            )
            total += min(skipped, elsewhere)
    return round(total, 2)


def _totals(trips: list[dict[str, Any]]) -> dict[str, Any]:
    keys = ("stops_total", "stops_delivered", "stops_skipped", "stops_pending")
    volumes = ("volume_planned_l", "volume_delivered_l", "volume_skipped_l")
    return {
        "trips_total": len(trips),
        **{key: sum(t[key] for t in trips) for key in keys},
        **{key: round(sum(t[key] for t in trips), 2) for key in volumes},
    }


async def build_dashboard(session: AsyncSession, day: date) -> dict[str, Any]:
    plans = await followed_plans(session, day)

    trips: list[dict[str, Any]] = []
    delays: list[dict[str, Any]] = []
    draft_alerts: list[dict[str, Any]] = []
    alerts: list[dict[str, Any]] = []
    plans_out: list[dict[str, Any]] = []
    pending_drafts: list[dict[str, Any]] = []
    sections: list[dict[str, Any]] = []

    for plan in plans:
        pending = await pending_draft(session, plan)
        if pending is not None:
            pending_drafts.append(pending)
            draft_alerts.append(
                {
                    "source": "plan",
                    "severity": Severity.BLOCKING if pending["blocking_count"] else Severity.WARNING,
                    "code": "pending_draft",
                    "message": pending["message"],
                    "plan_id": pending["plan_id"],
                    "trip_id": None,
                    "trip_seq": None,
                    "event_id": None,
                    "event_type": None,
                    "occurred_at": pending["created_at"],
                    "payload": {"plan_id": str(pending["plan_id"]), "version": pending["version"]},
                }
            )
        bundle = await comparison_service.load_bundle(session, plan.id)
        section = _plan_section(bundle)
        sections.append(section)
        trips += section["trips"]
        delays += section["delays"]
        alerts += section["alerts"]
        plans_out.append(
            {
                **comparison_service.plan_summary(bundle),
                **_totals(section["trips"]),
                "alerts_blocking": sum(1 for a in section["alerts"] if a["severity"] == Severity.BLOCKING),
                "alerts_total": len(section["alerts"]),
            }
        )
    # Versions en attente de publication en tête, puis violations des plans suivis, puis événements.
    alerts = draft_alerts + alerts

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
        payload = event.payload or {}
        # Une pénurie résolue, ou sans tournée impactée, n'est plus une alerte active (F8.6).
        if event.type == EventType.PRODUCT_SHORTAGE and payload.get("status") in SHORTAGE_INACTIVE:
            continue
        alerts.append(
            {
                "source": "event",
                "severity": Severity.WARNING,
                "code": event.type.value,
                # Résumé rédigé par le module des événements ; à défaut, libellé générique.
                "message": payload.get("summary") or EVENT_MESSAGES[event.type],
                "plan_id": event.plan_id,
                "trip_id": event.trip_id,
                "trip_seq": None,
                "event_id": event.id,
                "event_type": event.type,
                "occurred_at": event.occurred_at,
                "payload": event.payload,
            }
        )

    delays.sort(key=lambda d: -d["delay_s"])
    by_status = {status.value: 0 for status in TripStatus}
    for trip in trips:
        by_status[str(trip["status"])] = by_status.get(str(trip["status"]), 0) + 1
    trip_delays = [t["delay_s"] for t in trips if t["delay_s"] is not None and t["delay_s"] > 0]
    totals = _totals(trips)
    # Un arrêt sauté repris par un autre plan du jour n'est compté qu'une fois dans le prévu, et
    # n'est plus « à replanifier ».
    replanned = _replanned_l(sections)
    totals["volume_planned_l"] = round(totals["volume_planned_l"] - replanned, 2)
    totals["volume_skipped_l"] = round(totals["volume_skipped_l"] - replanned, 2)
    return {
        "day": day,
        "generated_at": utcnow(),
        "plan": plans_out[0] if plans_out else None,
        "plans": plans_out,
        "pending_draft": pending_drafts[0] if pending_drafts else None,
        "pending_drafts": pending_drafts,
        "summary": {
            "plans_total": len(plans_out),
            **totals,
            "volume_replanned_l": replanned,
            "trips_by_status": by_status,
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
