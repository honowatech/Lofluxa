"""Journal de la journée (F6.4) : lecture de la table `events`, tous modules confondus — lot L10.

Chaque ligne porte un libellé de type en français, l'auteur, l'heure et un résumé lisible. Le
résumé vient de `payload.summary` quand le module qui a écrit l'événement l'a fourni (plans,
événements) ; sinon il est reconstruit ici à partir du `payload` (chargement, livraison).
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import Page, PageParams
from app.core.enums import EventType
from app.core.errors import NotFoundError
from app.events.models import Event
from app.events.schemas import EventOut
from app.planning.models import Plan, Trip
from app.referentials.models import Truck
from app.users.models import User

TYPE_LABELS: dict[EventType, str] = {
    EventType.TRUCK_BREAKDOWN: "Panne de camion",
    EventType.DRIVER_UNAVAILABLE: "Chauffeur indisponible",
    EventType.PRODUCT_SHORTAGE: "Produit indisponible au dépôt",
    EventType.MANUAL_EDIT: "Modification du plan",
    EventType.PUBLISH: "Publication du plan",
    EventType.REPLAN: "Recalcul du plan",
    EventType.LOADING_RECORDED: "Chargement enregistré",
    EventType.DELIVERY_RECORDED: "Livraison enregistrée",
}


def fmt_l(value: Any) -> str:
    """12 500 L (espace insécable fine omise : texte brut pour le journal)."""
    try:
        return f"{float(value):,.0f}".replace(",", " ") + " L"
    except (TypeError, ValueError):
        return "? L"


def _loading_summary(payload: dict[str, Any]) -> str:
    text = "Chargement corrigé" if payload.get("updated") else "Chargement enregistré"
    if payload.get("depot_ticket_no"):
        text += f" (bon {payload['depot_ticket_no']})"
    if payload.get("volume_15_total_l") is not None:
        text += f" : {fmt_l(payload['volume_15_total_l'])} à 15 °C"
        if payload.get("planned_total_l") is not None:
            text += f" pour {fmt_l(payload['planned_total_l'])} planifiés"
    gap = payload.get("gap_pct")
    if gap is not None:
        text += f" (écart {float(gap):+.2f} %)".replace(".", ",")
    if payload.get("out_of_tolerance"):
        text += " — hors tolérance (RM-13)"
    return text + "."


def _delivery_summary(payload: dict[str, Any]) -> str:
    where = f"Arrêt {payload.get('seq', '?')}"
    if payload.get("station_code"):
        where += f" ({payload['station_code']})"
    if payload.get("status") == "skipped":
        reason = payload.get("skip_reason")
        return f"{where} non livré" + (f" : {reason}" if reason else "") + "."
    lines = payload.get("deliveries") or []
    actual = sum(float(d.get("actual_l") or 0) for d in lines)
    planned = sum(float(d.get("planned_l") or 0) for d in lines)
    return f"{where} livré : {fmt_l(actual)} pour {fmt_l(planned)} planifiés."


def build_summary(event_type: EventType, payload: dict[str, Any]) -> str:
    if payload.get("summary"):
        return str(payload["summary"])
    if event_type == EventType.LOADING_RECORDED:
        return _loading_summary(payload)
    if event_type == EventType.DELIVERY_RECORDED:
        return _delivery_summary(payload)
    return TYPE_LABELS.get(event_type, str(event_type)) + "."


async def _by_id(session: AsyncSession, model: type, ids: set) -> dict:
    ids = {i for i in ids if i is not None}
    if not ids:
        return {}
    rows = await session.execute(select(model).where(model.id.in_(ids)))
    return {row.id: row for row in rows.scalars()}


async def events_out(session: AsyncSession, events: list[Event]) -> list[EventOut]:
    users = await _by_id(session, User, {e.actor_id for e in events})
    trips = await _by_id(session, Trip, {e.trip_id for e in events})
    trucks = await _by_id(session, Truck, {t.truck_id for t in trips.values()})
    versions = {}
    plan_ids = {e.plan_id for e in events if e.plan_id is not None}
    if plan_ids:
        rows = await session.execute(select(Plan.id, Plan.version).where(Plan.id.in_(plan_ids)))
        versions = dict(rows.all())
    out = []
    for event in events:
        payload = dict(event.payload or {})
        event_type = EventType(event.type)
        actor = users.get(event.actor_id)
        trip = trips.get(event.trip_id)
        truck = trucks.get(trip.truck_id) if trip is not None else None
        out.append(
            EventOut(
                id=event.id,
                day=event.day,
                type=event_type,
                type_label=TYPE_LABELS.get(event_type, event_type.value),
                action=payload.get("action"),
                summary=build_summary(event_type, payload),
                occurred_at=event.occurred_at,
                actor_id=event.actor_id,
                actor_name=actor.full_name if actor else None,
                plan_id=event.plan_id,
                plan_version=payload.get("plan_version") or versions.get(event.plan_id),
                trip_id=event.trip_id,
                trip_seq=trip.seq if trip is not None else None,
                truck_plate=truck.plate if truck is not None else None,
                payload=payload,
            )
        )
    return out


async def get_event(session: AsyncSession, event_id: uuid.UUID, *, lock: bool = False) -> Event:
    stmt = select(Event).where(Event.id == event_id).execution_options(populate_existing=True)
    if lock:
        stmt = stmt.with_for_update()
    event = (await session.execute(stmt)).scalar_one_or_none()
    if event is None:
        raise NotFoundError("Événement introuvable.")
    return event


async def list_events(
    session: AsyncSession,
    day: date,
    page: PageParams,
    *,
    types: list[EventType] | None = None,
    trip_id: uuid.UUID | None = None,
    plan_id: uuid.UUID | None = None,
    include_versions: bool = False,
) -> Page[EventOut]:
    """Événements du jour, du plus récent au plus ancien.

    `trip_id` : événements rattachés à la tournée, ou qui la citent (`payload.related_trip_ids` :
    une panne cite la tournée d'origine et la tournée de remplacement).
    `plan_id` : événements du plan ; avec `include_versions`, de toutes les versions de sa lignée."""
    conditions = [Event.day == day]
    if types:
        conditions.append(Event.type.in_(types))
    if trip_id is not None:
        conditions.append(
            or_(Event.trip_id == trip_id, Event.payload["related_trip_ids"].contains([str(trip_id)]))
        )
    if plan_id is not None:
        plan_ids = [plan_id]
        if include_versions:
            plan = await session.get(Plan, plan_id)
            if plan is not None:
                root = plan.root_plan_id or plan.id
                rows = await session.execute(
                    select(Plan.id).where(func.coalesce(Plan.root_plan_id, Plan.id) == root)
                )
                plan_ids = list(rows.scalars())
        conditions.append(Event.plan_id.in_(plan_ids))
    total = (await session.execute(select(func.count()).select_from(Event).where(*conditions))).scalar_one()
    rows = await session.execute(
        select(Event)
        .where(*conditions)
        .order_by(Event.occurred_at.desc(), Event.id.desc())
        .limit(page.limit)
        .offset(page.offset)
    )
    items = await events_out(session, list(rows.scalars()))
    return Page[EventOut](items=items, total=total, limit=page.limit, offset=page.offset)
