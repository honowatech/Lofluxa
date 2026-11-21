"""Produit indisponible au dépôt (F6.3) — lot L10.

Déroulé : Supply déclare le nouveau stock (`declare`) → le système historise la saisie, signale les
tournées impactées et leurs options → le dispatcher décide tournée par tournée (`resolve`) :
réduire les volumes, reporter des commandes (`postponed`) ou changer de dépôt. Chaque décision
modifie une nouvelle version du plan (RM-18), recontrôlée par les règles (RM-08 comprise).

Lecture du stock (voir docs/questions/l10-evenements.md) : `new_available_l` est le stock total du
jour pour (dépôt, produit), comme en F2.1 et dans RM-08. Ce qui est déjà chargé en est déduit :
stock restant = nouveau stock − volume des tournées déjà chargées. Les tournées non chargées sont
servies dans l'ordre de leur heure de départ ; celles que le stock restant ne couvre plus
entièrement sont « impactées ».
"""

from __future__ import annotations

import math
import uuid
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.availability import service as availability_service
from app.core.enums import EventType, PlanKind, PlanStatus, StopStatus, TripStatus, UnservedReason
from app.core.errors import ConflictError, NotFoundError, ValidationAppError
from app.core.settings_store import get_setting
from app.core.time import to_local, utcnow
from app.events import journal, service
from app.events.journal import fmt_l
from app.events.models import Event
from app.events.schemas import (
    ImpactedTripOut,
    PlanResultOut,
    ProductShortageIn,
    ResolveIn,
    ResolveOut,
    ShortageOut,
    ShortageResolutionIn,
)
from app.loading.models import Loading
from app.orders import service as orders_service
from app.orders.models import Order
from app.planning import service as planning_service
from app.planning.checking import load_plan, log_event
from app.planning.models import Plan, Trip, UnservedOrder
from app.referentials.models import Depot, Driver, Product, Station, Truck
from app.users.models import User

_EPSILON_L = 0.01
# Tournée dont le produit a déjà quitté le dépôt (ou y est en cours de chargement enregistré).
_LOADED = (TripStatus.LOADED, TripStatus.IN_PROGRESS, TripStatus.COMPLETED)


@dataclass
class Analysis:
    stock_total_l: float
    loaded_l: float = 0.0
    planned_unloaded_l: float = 0.0
    impacted: list[dict[str, Any]] = field(default_factory=list)

    @property
    def remaining_l(self) -> float:
        return round(max(self.stock_total_l - self.loaded_l, 0.0), 2)

    @property
    def shortfall_l(self) -> float:
        return round(sum(item["shortfall_l"] for item in self.impacted), 2)


def _volume(trip: Trip, product_id: uuid.UUID) -> float:
    return float(sum(d.planned_l for s in trip.stops for d in s.deliveries if d.product_id == product_id))


async def current_plans(session: AsyncSession, day: date, *, prefer_draft: bool) -> list[Plan]:
    """Plans de référence du jour : pour chaque lignée de plans calculés ayant une version publiée,
    cette version — ou, avec `prefer_draft`, la nouvelle version en préparation s'il y en a une."""
    rows = await session.execute(
        select(Plan.id, Plan.status, func.coalesce(Plan.root_plan_id, Plan.id))
        .where(Plan.day == day, Plan.kind == PlanKind.COMPUTED, Plan.status != PlanStatus.ARCHIVED)
        .order_by(Plan.version, Plan.id)
    )
    by_root: dict[uuid.UUID, dict[PlanStatus, uuid.UUID]] = {}
    for plan_id, status, root in rows.all():
        by_root.setdefault(root, {})[PlanStatus(status)] = plan_id
    plans = []
    for versions in by_root.values():
        if PlanStatus.PUBLISHED not in versions:
            continue
        chosen = versions[PlanStatus.PUBLISHED]
        if prefer_draft and PlanStatus.DRAFT in versions:
            chosen = versions[PlanStatus.DRAFT]
        plans.append(await load_plan(session, chosen))
    return plans


async def _loaded_trip_ids(session: AsyncSession, plans: list[Plan]) -> set[uuid.UUID]:
    trips = [t for p in plans for t in p.trips]
    loaded = {t.id for t in trips if t.status in _LOADED}
    ids = [t.id for t in trips if t.id not in loaded]
    if ids:
        rows = await session.execute(select(Loading.trip_id).where(Loading.trip_id.in_(ids)))
        loaded |= set(rows.scalars())
    return loaded


async def _labels(session: AsyncSession, model: type, ids: set) -> dict:
    ids = {i for i in ids if i is not None}
    if not ids:
        return {}
    rows = await session.execute(select(model).where(model.id.in_(ids)))
    return {row.id: row for row in rows.scalars()}


async def analyse(
    session: AsyncSession,
    plans: list[Plan],
    day: date,
    depot_id: uuid.UUID,
    product_id: uuid.UUID,
    stock_total_l: float,
) -> Analysis:
    """Tournées impactées : volume prévu > stock restant, compte tenu de ce qui est déjà chargé."""
    analysis = Analysis(stock_total_l=stock_total_l)
    loaded_ids = await _loaded_trip_ids(session, plans)
    waiting: list[tuple[Plan, Trip, float]] = []
    planned_by_depot: dict[uuid.UUID, float] = {}
    for plan in plans:
        for trip in plan.trips:
            volume = _volume(trip, product_id)
            if volume <= 0:
                continue
            planned_by_depot[trip.depot_id] = planned_by_depot.get(trip.depot_id, 0.0) + volume
            if trip.depot_id != depot_id:
                continue
            if trip.id in loaded_ids:
                analysis.loaded_l += volume
            else:
                waiting.append((plan, trip, volume))
    analysis.loaded_l = round(analysis.loaded_l, 2)
    analysis.planned_unloaded_l = round(sum(v for _, _, v in waiting), 2)

    waiting.sort(key=lambda x: (x[1].planned_start_at is None, x[1].planned_start_at, x[1].seq))
    short: list[tuple[Plan, Trip, float, float]] = []
    left = analysis.remaining_l
    for plan, trip, volume in waiting:
        covered = round(min(volume, max(left, 0.0)), 2)
        left -= volume
        if volume - covered > _EPSILON_L:
            short.append((plan, trip, volume, covered))
    if not short:
        return analysis

    trucks = await _labels(session, Truck, {t.truck_id for _, t, _, _ in short})
    drivers = await _labels(session, Driver, {t.driver_id for _, t, _, _ in short})
    stations = await _labels(session, Station, {s.station_id for _, t, _, _ in short for s in t.stops})
    orders = await _labels(
        session, Order, {d.order_id for _, t, _, _ in short for s in t.stops for d in s.deliveries}
    )
    depots = (
        (
            await session.execute(
                select(Depot)
                .where(Depot.deleted_at.is_(None), Depot.active.is_(True), Depot.id != depot_id)
                .order_by(Depot.code)
            )
        )
        .scalars()
        .all()
    )
    stocks = await availability_service.current_depot_stocks(session, day)
    for plan, trip, volume, covered in short:
        alternatives = []
        for depot in depots:
            entry = stocks.get((depot.id, product_id))
            available = float(entry.available_l) if entry is not None else None
            planned = round(planned_by_depot.get(depot.id, 0.0), 2)
            remaining = round(available - planned, 2) if available is not None else None
            alternatives.append(
                {
                    "depot_id": str(depot.id),
                    "code": depot.code,
                    "name": depot.name,
                    "available_l": available,
                    "planned_l": planned,
                    "remaining_l": remaining,
                    "sufficient": remaining >= volume - _EPSILON_L if remaining is not None else None,
                }
            )
        options = ["postpone"]
        if covered > _EPSILON_L:
            options.insert(0, "reduce")
        if alternatives:
            options.append("change_depot")
        truck = trucks.get(trip.truck_id)
        driver = drivers.get(trip.driver_id)
        lines = []
        for stop in sorted(trip.stops, key=lambda s: s.seq):
            station = stations.get(stop.station_id)
            for delivery in stop.deliveries:
                if delivery.product_id != product_id:
                    continue
                order = orders.get(delivery.order_id)
                lines.append(
                    {
                        "order_id": str(delivery.order_id),
                        "stop_id": str(stop.id),
                        "station_code": station.code if station else None,
                        "station_name": station.name if station else None,
                        "planned_l": float(delivery.planned_l),
                        "requested_l": float(order.requested_l) if order else None,
                        "priority": str(order.priority.value) if order else None,
                    }
                )
        analysis.impacted.append(
            {
                "plan_id": str(plan.id),
                "root_plan_id": str(plan.root_plan_id or plan.id),
                "plan_version": plan.version,
                "plan_status": PlanStatus(plan.status).value,
                "trip_id": str(trip.id),
                "trip_seq": trip.seq,
                "status": TripStatus(trip.status).value,
                "truck_plate": truck.plate if truck else None,
                "driver_name": driver.full_name if driver else None,
                "planned_start_at": trip.planned_start_at.isoformat() if trip.planned_start_at else None,
                "planned_l": round(volume, 2),
                "covered_l": covered,
                "shortfall_l": round(volume - covered, 2),
                "options": options,
                "orders": lines,
                "alternative_depots": alternatives,
                "resolution": None,
            }
        )
    return analysis


def _out(event_out, payload: dict[str, Any], analysis: Analysis, status: str, **extra) -> dict[str, Any]:
    return dict(
        event=event_out,
        status=status,
        day=date.fromisoformat(payload["day"]),
        depot_id=payload["depot_id"],
        depot_code=payload["depot_code"],
        product_id=payload["product_id"],
        product_code=payload["product_code"],
        previous_available_l=payload.get("previous_available_l"),
        new_available_l=analysis.stock_total_l,
        loaded_l=analysis.loaded_l,
        remaining_l=analysis.remaining_l,
        planned_unloaded_l=analysis.planned_unloaded_l,
        shortfall_l=analysis.shortfall_l,
        impacted_trips=[ImpactedTripOut(**item) for item in analysis.impacted],
        **extra,
    )


# --------------------------------------------------------------------------- déclaration (Supply)


async def declare(session: AsyncSession, payload: ProductShortageIn, user: User) -> ShortageOut:
    depot = await session.get(Depot, payload.depot_id)
    if depot is None or depot.deleted_at is not None:
        raise NotFoundError("Dépôt introuvable.", details=[{"depot_id": str(payload.depot_id)}])
    product = await session.get(Product, payload.product_id)
    if product is None or product.deleted_at is not None:
        raise NotFoundError("Produit introuvable.", details=[{"product_id": str(payload.product_id)}])
    day = payload.day or to_local(utcnow(), await get_setting(session, "timezone")).date()
    new_l = round(float(payload.new_available_l), 2)

    plans = await current_plans(session, day, prefer_draft=False)
    analysis = await analyse(session, plans, day, depot.id, product.id, new_l)
    if new_l < analysis.loaded_l - _EPSILON_L:
        raise ValidationAppError(
            f"Stock incohérent : {fmt_l(analysis.loaded_l)} de {product.code} ont déjà été chargés au "
            f"dépôt {depot.code} aujourd'hui. Saisissez le stock total du jour (déjà chargé + restant).",
            code="stock_below_loaded",
            details=[{"field": "new_available_l", "loaded_l": analysis.loaded_l}],
        )
    previous = (await availability_service.current_depot_stocks(session, day)).get((depot.id, product.id))
    previous_l = float(previous.available_l) if previous is not None else None
    await availability_service.record_depot_stock(
        session, depot_id=depot.id, product_id=product.id, day=day, available_l=new_l, user_id=user.id
    )

    status = "open" if analysis.impacted else "no_impact"
    before = fmt_l(previous_l) if previous_l is not None else "non renseigné"
    summary = (
        f"Stock de {product.code} au dépôt {depot.code} : {before} → {fmt_l(new_l)} "
        f"(déjà chargé {fmt_l(analysis.loaded_l)}, reste {fmt_l(analysis.remaining_l)} pour "
        f"{fmt_l(analysis.planned_unloaded_l)} encore à charger). "
    )
    if analysis.impacted:
        seqs = ", ".join(str(item["trip_seq"]) for item in analysis.impacted)
        summary += (
            f"{len(analysis.impacted)} tournée(s) impactée(s) (n° {seqs}), il manque "
            f"{fmt_l(analysis.shortfall_l)} : le dispatcher doit réduire, reporter ou changer de dépôt."
        )
    else:
        summary += "Aucune tournée impactée."
    impacted_plans = {item["plan_id"] for item in analysis.impacted} or {str(p.id) for p in plans}
    event = Event(
        day=day,
        plan_id=uuid.UUID(next(iter(impacted_plans))) if len(impacted_plans) == 1 else None,
        trip_id=None,
        type=EventType.PRODUCT_SHORTAGE,
        payload={
            "action": "declared",
            "summary": summary,
            "status": status,
            "comment": payload.comment,
            "day": day.isoformat(),
            "depot_id": str(depot.id),
            "depot_code": depot.code,
            "product_id": str(product.id),
            "product_code": product.code,
            "previous_available_l": previous_l,
            "new_available_l": new_l,
            "loaded_l": analysis.loaded_l,
            "remaining_l": analysis.remaining_l,
            "planned_unloaded_l": analysis.planned_unloaded_l,
            "shortfall_l": analysis.shortfall_l,
            "impacted_trips": analysis.impacted,
            "related_trip_ids": [item["trip_id"] for item in analysis.impacted],
            "resolutions": [],
        },
        occurred_at=payload.occurred_at or utcnow(),
        actor_id=user.id,
    )
    session.add(event)
    await session.flush()
    event_out = (await journal.events_out(session, [event]))[0]
    return ShortageOut(**_out(event_out, event.payload, analysis, status))


# --------------------------------------------------------------------------- suivi et résolution


async def _shortage_event(session: AsyncSession, event_id: uuid.UUID, *, lock: bool = False) -> Event:
    event = await journal.get_event(session, event_id, lock=lock)
    if event.type != EventType.PRODUCT_SHORTAGE or (event.payload or {}).get("action") != "declared":
        raise ConflictError(
            "Cet événement n'est pas une pénurie produit : il n'a rien à résoudre.",
            code="event_not_resolvable",
        )
    return event


async def _live(session: AsyncSession, payload: dict[str, Any]) -> Analysis:
    """État courant de la pénurie : stock qui fait foi maintenant, versions en préparation comprises."""
    day = date.fromisoformat(payload["day"])
    depot_id, product_id = uuid.UUID(payload["depot_id"]), uuid.UUID(payload["product_id"])
    entry = (await availability_service.current_depot_stocks(session, day)).get((depot_id, product_id))
    stock = float(entry.available_l) if entry is not None else float(payload["new_available_l"])
    plans = await current_plans(session, day, prefer_draft=True)
    return await analyse(session, plans, day, depot_id, product_id, stock)


async def impact(session: AsyncSession, event_id: uuid.UUID) -> ShortageOut:
    """Tournées encore impactées par une pénurie déclarée, avec leurs options (lecture seule)."""
    event = await _shortage_event(session, event_id)
    payload = event.payload
    analysis = await _live(session, payload)
    status = payload.get("status", "open")
    if status == "open" and not analysis.impacted:
        status = "resolved"
    event_out = (await journal.events_out(session, [event]))[0]
    return ShortageOut(**_out(event_out, payload, analysis, status))


def _liters(value: float) -> Decimal:
    return Decimal(str(round(float(value), 2)))


def _product_lines(trip: Trip, product_id: uuid.UUID) -> list[tuple[Any, Any]]:
    return [
        (stop, d)
        for stop in sorted(trip.stops, key=lambda s: s.seq)
        for d in list(stop.deliveries)
        if d.product_id == product_id
    ]


def _drop_empty(plan: Plan, trip: Trip) -> bool:
    """Retire les arrêts sans livraison ; une tournée sans arrêt est retirée du plan. Renvoie vrai
    si la tournée a été retirée."""
    for stop in [s for s in trip.stops if not s.deliveries]:
        trip.stops.remove(stop)
    for index, stop in enumerate(sorted(trip.stops, key=lambda s: s.seq), start=1):
        stop.seq = index
    if not trip.stops:
        plan.trips.remove(trip)
        return True
    return False


async def _reduce(
    session: AsyncSession,
    plan: Plan,
    trip: Trip,
    decision: ShortageResolutionIn,
    payload: dict[str, Any],
) -> dict[str, Any]:
    product_id = uuid.UUID(payload["product_id"])
    lines = _product_lines(trip, product_id)
    need = float(sum(d.planned_l for _, d in lines))
    changes = []
    if decision.deliveries:
        by_order = {d.order_id: d for _, d in lines}
        for item in decision.deliveries:
            delivery = by_order.get(item.order_id)
            if delivery is None:
                raise ValidationAppError(
                    f"La commande {item.order_id} n'est pas livrée en {payload['product_code']} par la "
                    f"tournée {trip.seq}.",
                    details=[{"field": "deliveries", "order_id": str(item.order_id)}],
                )
            if item.planned_l > float(delivery.planned_l) + _EPSILON_L:
                raise ValidationAppError(
                    "Une réduction ne peut pas augmenter le volume planifié "
                    f"({fmt_l(delivery.planned_l)} pour cette commande).",
                    details=[{"field": "deliveries", "order_id": str(item.order_id)}],
                )
            changes.append((delivery, float(delivery.planned_l), item.planned_l))
    else:
        # Même calcul que `GET /events/{id}/impact` : ce que l'analyse annonce comme couvert pour
        # cette tournée est ce que la réduction accorde, quel que soit l'ordre de traitement.
        live = await _live(session, payload)
        entry = next((item for item in live.impacted if item["trip_id"] == str(trip.id)), None)
        target = need if entry is None else float(entry["covered_l"])
        if target <= _EPSILON_L:
            raise ValidationAppError(
                f"Il ne reste plus de {payload['product_code']} pour la tournée {trip.seq} : la réduction "
                "est impossible, reportez les commandes ou changez de dépôt.",
                code="nothing_left_to_load",
            )
        if target >= need - _EPSILON_L:
            raise ConflictError(
                f"Le stock couvre déjà la tournée {trip.seq} : il n'y a rien à réduire.",
                code="trip_not_impacted",
            )
        factor = target / need
        # Réduction proportionnelle, arrondie au litre inférieur.
        changes = [(d, float(d.planned_l), float(math.floor(float(d.planned_l) * factor))) for _, d in lines]
    detail = []
    for delivery, before, after in changes:
        detail.append({"order_id": str(delivery.order_id), "from_l": before, "to_l": after})
        if after <= 0:
            stop = next(s for s in trip.stops if delivery in s.deliveries)
            stop.deliveries.remove(delivery)
        else:
            delivery.planned_l = _liters(after)
    removed = _drop_empty(plan, trip)
    after_total = round(need - sum(c[1] - c[2] for c in changes), 2)
    return {
        "deliveries": detail,
        "from_l": round(need, 2),
        "to_l": after_total,
        "trip_removed": removed,
        "text": f"volume de {payload['product_code']} réduit de {fmt_l(need)} à {fmt_l(after_total)}",
    }


async def _postpone(
    session: AsyncSession,
    plan: Plan,
    trip: Trip,
    decision: ShortageResolutionIn,
    payload: dict[str, Any],
) -> dict[str, Any]:
    product_id = uuid.UUID(payload["product_id"])
    lines = _product_lines(trip, product_id)
    on_trip = {d.order_id for _, d in lines}
    wanted = set(decision.order_ids) if decision.order_ids else on_trip
    unknown = wanted - on_trip
    if unknown:
        raise ValidationAppError(
            f"Seules les commandes de {payload['product_code']} de la tournée {trip.seq} peuvent être "
            "reportées au titre de cette pénurie.",
            details=[{"field": "order_ids", "order_id": str(o)} for o in sorted(unknown, key=str)],
        )
    volume = 0.0
    for stop, delivery in lines:
        if delivery.order_id in wanted:
            volume += float(delivery.planned_l)
            stop.deliveries.remove(delivery)
    removed = _drop_empty(plan, trip)
    # Report explicite (F6.3) : machine à états des commandes (lot L4).
    await orders_service.mark_postponed(session, sorted(wanted, key=str))
    listed = {u.order_id for u in plan.unserved}
    for order_id in sorted(wanted - listed, key=str):
        plan.unserved.append(
            UnservedOrder(
                order_id=order_id,
                reason_code=UnservedReason.DEPOT_STOCK,
                reason_text=f"Commande reportée : {payload['product_code']} indisponible au dépôt "
                f"{payload['depot_code']}.",
            )
        )
    return {
        "order_ids": [str(o) for o in sorted(wanted, key=str)],
        "postponed_l": round(volume, 2),
        "trip_removed": removed,
        "text": f"{len(wanted)} commande(s) de {payload['product_code']} reportée(s) ({fmt_l(volume)})"
        + (" ; la tournée, vide, est supprimée" if removed else ""),
    }


async def _change_depot(
    session: AsyncSession, trip: Trip, decision: ShortageResolutionIn, payload: dict[str, Any]
) -> dict[str, Any]:
    if decision.depot_id is None:
        raise ValidationAppError(
            "Indiquez le nouveau dépôt de chargement.",
            details=[{"field": "depot_id", "message": "Champ obligatoire pour « change_depot »."}],
        )
    depot = await session.get(Depot, decision.depot_id)
    if depot is None or depot.deleted_at is not None or not depot.active:
        raise NotFoundError("Dépôt introuvable ou inactif.", details=[{"depot_id": str(decision.depot_id)}])
    if depot.id == trip.depot_id:
        raise ValidationAppError(
            "Le nouveau dépôt doit être différent du dépôt en pénurie.",
            details=[{"field": "depot_id", "message": "Dépôt identique."}],
        )
    trip.depot_id = depot.id
    return {
        "from_depot_code": payload["depot_code"],
        "to_depot_id": str(depot.id),
        "to_depot_code": depot.code,
        "trip_removed": False,
        "text": f"chargement déplacé du dépôt {payload['depot_code']} au dépôt {depot.code}",
    }


async def resolve(session: AsyncSession, event_id: uuid.UUID, body: ResolveIn) -> ResolveOut:
    event = await _shortage_event(session, event_id, lock=True)
    payload = dict(event.payload)
    if payload.get("status") != "open":
        raise ConflictError(
            "Cette pénurie n'a pas (ou plus) de tournée à traiter.",
            code="shortage_not_open",
            details=[{"status": payload.get("status")}],
        )
    depot_id, product_id = uuid.UUID(payload["depot_id"]), uuid.UUID(payload["product_id"])
    if len({r.trip_id for r in body.resolutions}) != len(body.resolutions):
        raise ValidationAppError("Une tournée figure deux fois dans les décisions.")

    working: dict[uuid.UUID, service.Located] = {}
    records: dict[uuid.UUID, list[dict[str, Any]]] = {}
    for decision in body.resolutions:
        located = await service.locate(
            session, decision.trip_id, reason="Pénurie produit au dépôt", follow_archived=True
        )
        plan, trip = located.plan, located.trip
        working.setdefault(plan.id, located)
        if trip.depot_id != depot_id or _volume(trip, product_id) <= 0:
            raise ConflictError(
                f"La tournée {trip.seq} ne charge pas (ou plus) de {payload['product_code']} au dépôt "
                f"{payload['depot_code']}.",
                code="trip_not_concerned",
            )
        if trip.id in await _loaded_trip_ids(session, [plan]):
            raise ConflictError(
                f"La tournée {trip.seq} est déjà chargée : elle n'est pas concernée par la pénurie.",
                code="trip_already_loaded",
            )
        if any(s.status != StopStatus.PENDING for s in trip.stops):
            raise ConflictError(f"La tournée {trip.seq} a déjà des arrêts réalisés.", code="trip_started")
        trip_id, trip_seq = trip.id, trip.seq
        if decision.action == "reduce":
            detail = await _reduce(session, plan, trip, decision, payload)
        elif decision.action == "postpone":
            detail = await _postpone(session, plan, trip, decision, payload)
        else:
            detail = await _change_depot(session, trip, decision, payload)
        await session.flush()
        records.setdefault(plan.id, []).append(
            {
                "action": decision.action,
                "trip_seq": trip_seq,
                "trip_id": None if detail["trip_removed"] else str(trip_id),
                "source_trip_id": str(decision.trip_id),
                "root_plan_id": str(plan.root_plan_id or plan.id),
                "plan_id": str(plan.id),
                "plan_version": plan.version,
                "at": utcnow().isoformat(),
                **detail,
            }
        )

    # Commandes reportées : les autres brouillons qui les portent sont recontrôlés (lot L5).
    postponed = [uuid.UUID(o) for rows in records.values() for r in rows for o in r.get("order_ids", [])]
    await planning_service.recheck_drafts_for_orders(session, postponed)

    results: list[PlanResultOut] = []
    for plan_id, located in working.items():
        await planning_service.recheck_plan(session, plan_id)
        plan = await load_plan(session, plan_id)
        publish = service.will_publish(plan, body.publish, located.created)
        parts = "; ".join(f"tournée {r['trip_seq']} — {r['text']}" for r in records[plan_id])
        edit = log_event(
            session,
            plan,
            EventType.MANUAL_EDIT,
            {
                "action": "shortage_resolution",
                "summary": f"Pénurie de {payload['product_code']} au dépôt {payload['depot_code']} : "
                f"{parts}. " + service.status_sentence(plan, publish),
                "shortage_event_id": str(event.id),
                "depot_code": payload["depot_code"],
                "product_code": payload["product_code"],
                "resolutions": records[plan_id],
                "related_trip_ids": sorted(
                    {x for r in records[plan_id] for x in (r["trip_id"], r["source_trip_id"]) if x}
                ),
                "published": publish,
            },
        )
        if body.occurred_at is not None:
            edit.occurred_at = body.occurred_at
        await session.flush()
        results.append(
            await service.plan_result(
                session, plan_id, publish=publish, created=located.created, previous=located.previous
            )
        )

    # Mise à jour de l'alerte : décisions prises, tournées encore à traiter, statut.
    done = [r for rows in records.values() for r in rows]
    entries = [dict(item) for item in payload.get("impacted_trips", [])]
    for record in done:
        for entry in entries:
            same_trip = entry["trip_id"] == record["source_trip_id"] or entry.get("current_trip_id") in (
                record["source_trip_id"],
                record["trip_id"],
            )
            same_seq = (
                entry.get("root_plan_id") == record["root_plan_id"]
                and entry["trip_seq"] == record["trip_seq"]
            )
            if same_trip or same_seq:
                entry["resolution"] = {k: v for k, v in record.items() if k != "text"} | {
                    "summary": record["text"]
                }
                entry["current_trip_id"] = record["trip_id"]
    analysis = await _live(session, payload)
    status = "open" if analysis.impacted else "resolved"
    payload.update(
        impacted_trips=entries,
        resolutions=[*payload.get("resolutions", []), *done],
        open_trips=analysis.impacted,
        status=status,
        related_trip_ids=sorted(
            {*payload.get("related_trip_ids", []), *(r["trip_id"] for r in done if r["trip_id"])}
        ),
    )
    if status == "resolved":
        payload["resolved_at"] = utcnow().isoformat()
    event.payload = payload
    await session.flush()
    event_out = (await journal.events_out(session, [event]))[0]
    return ResolveOut(**_out(event_out, payload, analysis, status, results=results))
