"""Versions d'un plan (F5.5, RM-18) — lot L5.

Modèle retenu :
- un plan = une version ; les versions d'une même lignée partagent `root_plan_id` (identifiant de
  la version 1) et portent `version` = 1, 2, 3… ; `parent_plan_id` = version dont elle est copiée ;
- un **brouillon** se modifie sur place : chaque modification est journalisée (`events`, type
  `manual_edit` ou `replan` : qui, quoi, quand) mais ne crée pas de version ;
- un plan **publié** n'est jamais modifié : toute modification le copie intégralement dans une
  nouvelle version brouillon (`create_version`), sur laquelle la modification est appliquée ;
- à la publication de la nouvelle version, la version publiée précédente passe `archived` ;
- restaurer la version *v* crée une nouvelle version brouillon, copie de *v* ; le brouillon en
  cours de la lignée, s'il existe, est archivé (abandonné, jamais supprimé).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import new_id
from app.core.enums import EventType, PlanKind, PlanStatus, StopStatus, TripStatus
from app.core.errors import ConflictError, NotFoundError
from app.events.models import Event
from app.loading.models import Loading, LoadingLine
from app.planning.checking import EXTERNAL_RULE_CODES, load_plan, log_event, recheck, root_id
from app.planning.models import (
    ConstraintViolation,
    Plan,
    Stop,
    StopDelivery,
    Trip,
    TripCompartmentLoad,
    UnservedOrder,
)

_TRIP_RANK = {status: rank for rank, status in enumerate(TripStatus)}


@dataclass
class IdMap:
    """Correspondance des identifiants entre un plan et sa copie (tournées, arrêts)."""

    trips: dict[uuid.UUID, uuid.UUID] = field(default_factory=dict)
    stops: dict[uuid.UUID, uuid.UUID] = field(default_factory=dict)

    def trip(self, trip_id: uuid.UUID) -> uuid.UUID:
        return self.trips.get(trip_id, trip_id)

    def stop(self, stop_id: uuid.UUID) -> uuid.UUID:
        return self.stops.get(stop_id, stop_id)

    def payload(self) -> dict[str, dict[str, str]]:
        """Forme journalisée avec l'événement de création de la version : c'est elle qui permet,
        plus tard, de retrouver la tournée d'origine d'une tournée copiée."""
        return {
            "trip_ids": {str(old): str(new) for old, new in self.trips.items()},
            "stop_ids": {str(old): str(new) for old, new in self.stops.items()},
        }


async def lineage(session: AsyncSession, plan: Plan) -> list[Plan]:
    """Toutes les versions de la lignée du plan, de la plus ancienne à la plus récente."""
    root = root_id(plan)
    rows = await session.execute(
        select(Plan).where(func.coalesce(Plan.root_plan_id, Plan.id) == root).order_by(Plan.version, Plan.id)
    )
    return list(rows.scalars())


async def copy_plan(session: AsyncSession, source: Plan, *, version: int) -> tuple[Plan, IdMap]:
    """Copie intégrale d'un plan (chargé par `load_plan`) en brouillon de la même lignée.

    L'état d'exécution (statuts, heures et volumes réels) est conservé : une nouvelle version
    d'un plan en cours d'exécution ne perd pas ce qui a déjà été fait (RM-19)."""
    ids = IdMap()
    copy = Plan(
        id=new_id(),
        day=source.day,
        kind=source.kind,
        status=PlanStatus.DRAFT,
        version=version,
        parent_plan_id=source.id,
        root_plan_id=root_id(source),
        label=source.label,
        approximate=source.approximate,
        metrics=dict(source.metrics) if source.metrics else source.metrics,
        solver_log=source.solver_log,
        prep_time_s=source.prep_time_s,
        engine_version=source.engine_version,
        params_snapshot=source.params_snapshot,
        computed_at=source.computed_at,
        computed_in_ms=source.computed_in_ms,
        violations=[],
    )
    for trip in source.trips:
        trip_copy = Trip(
            id=new_id(),
            seq=trip.seq,
            truck_id=trip.truck_id,
            driver_id=trip.driver_id,
            depot_id=trip.depot_id,
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
        )
        ids.trips[trip.id] = trip_copy.id
        for stop in trip.stops:
            stop_copy = Stop(
                id=new_id(),
                seq=stop.seq,
                station_id=stop.station_id,
                planned_arrival_at=stop.planned_arrival_at,
                planned_departure_at=stop.planned_departure_at,
                distance_from_prev_m=stop.distance_from_prev_m,
                status=stop.status,
                actual_arrival_at=stop.actual_arrival_at,
                actual_departure_at=stop.actual_departure_at,
                skip_reason=stop.skip_reason,
            )
            ids.stops[stop.id] = stop_copy.id
            for delivery in stop.deliveries:
                stop_copy.deliveries.append(
                    StopDelivery(
                        order_id=delivery.order_id,
                        product_id=delivery.product_id,
                        planned_l=delivery.planned_l,
                        actual_l=delivery.actual_l,
                    )
                )
            trip_copy.stops.append(stop_copy)
        for load in trip.compartment_loads:
            trip_copy.compartment_loads.append(
                TripCompartmentLoad(
                    compartment_id=load.compartment_id, product_id=load.product_id, planned_l=load.planned_l
                )
            )
        copy.trips.append(trip_copy)
    for unserved in source.unserved:
        copy.unserved.append(
            UnservedOrder(
                order_id=unserved.order_id, reason_code=unserved.reason_code, reason_text=unserved.reason_text
            )
        )
    session.add(copy)
    # Les violations désignent tournées et arrêts par simple identifiant : ceux-ci doivent exister.
    await session.flush()
    await _copy_loadings(session, ids)
    for violation in source.violations:
        copy.violations.append(
            ConstraintViolation(
                trip_id=ids.trips.get(violation.trip_id) if violation.trip_id else None,
                stop_id=ids.stops.get(violation.stop_id) if violation.stop_id else None,
                rule_code=violation.rule_code,
                severity=violation.severity,
                message=violation.message,
            )
        )
    return copy, ids


def _clone_loading(loading: Loading, trip_id: uuid.UUID) -> Loading:
    return Loading(
        trip_id=trip_id,
        depot_id=loading.depot_id,
        arrived_at=loading.arrived_at,
        started_at=loading.started_at,
        finished_at=loading.finished_at,
        depot_ticket_no=loading.depot_ticket_no,
        entered_by=loading.entered_by,
        lines=[
            LoadingLine(
                compartment_id=line.compartment_id,
                product_id=line.product_id,
                observed_l=line.observed_l,
                observed_temp_c=line.observed_temp_c,
                observed_density=line.observed_density,
                volume_15_l=line.volume_15_l,
                planned_l=line.planned_l,
            )
            for line in loading.lines
        ],
    )


async def _copy_loadings(session: AsyncSession, ids: IdMap) -> None:
    """Recopie le chargement réel (lot L6) de chaque tournée sur sa copie : la nouvelle version
    garde ce qui a déjà été chargé (RM-19), l'ancienne version garde son relevé (jamais écrasée)."""
    if not ids.trips:
        return
    rows = await session.execute(select(Loading).where(Loading.trip_id.in_(ids.trips)))
    for loading in rows.scalars():
        session.add(_clone_loading(loading, ids.trips[loading.trip_id]))
    await session.flush()


async def _origins(session: AsyncSession, plans: list[Plan]) -> dict[str, str]:
    """Identifiant d'origine de chaque tournée et de chaque arrêt copié dans la lignée : on remonte
    les correspondances journalisées à chaque création de version (`trip_ids`, `stop_ids`)."""
    parent: dict[str, str] = {}
    events = await version_events(session, [p.id for p in plans])
    for rows in events.values():
        for event in rows:
            payload = event.payload or {}
            for key in ("trip_ids", "stop_ids"):
                for old, new in (payload.get(key) or {}).items():
                    parent[new] = old

    def origin(item: str) -> str:
        while item in parent:
            item = parent[item]
        return item

    return {item: origin(item) for item in parent}


async def sync_execution_from_published(session: AsyncSession, plan: Plan) -> int:
    """Avant de publier `plan` : reprend l'état d'exécution de la version en vigueur de la lignée.

    Tant qu'un brouillon est en préparation, le terrain continue d'écrire sur la version publiée
    (statuts, heures et volumes réels, chargement, RM-13). Rien de ce qui a été réalisé ne doit
    régresser à la publication : pour chaque tournée et chaque arrêt du brouillon issus d'une
    tournée / d'un arrêt de la version en vigueur, l'état le plus avancé des deux est retenu.
    Renvoie le nombre de tournées resynchronisées."""
    plans = await lineage(session, plan)
    current = next((p for p in plans if p.status == PlanStatus.PUBLISHED and p.id != plan.id), None)
    if current is None:
        return 0
    current = await load_plan(session, current.id)
    plan = await load_plan(session, plan.id)
    origins = await _origins(session, plans)

    def origin(item: uuid.UUID) -> str:
        return origins.get(str(item), str(item))

    old_trips = {origin(t.id): t for t in current.trips}
    old_stops = {origin(s.id): s for t in current.trips for s in t.stops}
    pairs: dict[uuid.UUID, Trip] = {}  # ancienne tournée → nouvelle
    for trip in plan.trips:
        old = old_trips.get(origin(trip.id))
        if old is None:
            continue
        pairs[old.id] = trip
        # Le plus avancé des deux états l'emporte : le brouillon peut lui-même avoir fait avancer
        # la tournée (panne : tournée d'origine close dans la nouvelle version, F6.1).
        if _TRIP_RANK[TripStatus(old.status)] > _TRIP_RANK[TripStatus(trip.status)]:
            trip.status = old.status
        for name in ("actual_depart_at", "actual_return_at", "actual_distance_m"):
            if getattr(trip, name) is None and getattr(old, name) is not None:
                setattr(trip, name, getattr(old, name))
        for stop in trip.stops:
            old_stop = old_stops.get(origin(stop.id))
            if old_stop is None:
                continue
            if stop.status == StopStatus.PENDING and old_stop.status != StopStatus.PENDING:
                stop.status = old_stop.status
                stop.skip_reason = old_stop.skip_reason
            for name in ("actual_arrival_at", "actual_departure_at"):
                if getattr(stop, name) is None and getattr(old_stop, name) is not None:
                    setattr(stop, name, getattr(old_stop, name))
            actual = {(d.order_id, d.product_id): d.actual_l for d in old_stop.deliveries}
            for delivery in stop.deliveries:
                if delivery.actual_l is None:
                    delivery.actual_l = actual.get((delivery.order_id, delivery.product_id))
    if not pairs:
        return 0

    # Chargements : celui de la version en vigueur est repris s'il manque au brouillon, ou s'il a
    # été saisi ou corrigé après la copie.
    new_ids = [t.id for t in pairs.values()]
    mine = {
        x.trip_id: x
        for x in (await session.execute(select(Loading).where(Loading.trip_id.in_(new_ids)))).scalars()
    }
    theirs = (await session.execute(select(Loading).where(Loading.trip_id.in_(pairs)))).scalars().all()
    refreshed: dict[uuid.UUID, Loading] = {}
    for loading in theirs:
        target = pairs[loading.trip_id].id
        existing = mine.get(target)
        if existing is None or loading.updated_at > existing.created_at:
            refreshed[target] = loading
            if existing is not None:
                await session.delete(existing)
    await session.flush()
    for target, loading in refreshed.items():
        session.add(_clone_loading(loading, target))

    # Violations du chargement (RM-13) des tournées dont le chargement vient d'être repris.
    for row in [v for v in plan.violations if v.rule_code in EXTERNAL_RULE_CODES and v.trip_id in refreshed]:
        plan.violations.remove(row)
    for row in current.violations:
        if (
            row.rule_code in EXTERNAL_RULE_CODES
            and row.trip_id in pairs
            and pairs[row.trip_id].id in refreshed
        ):
            plan.violations.append(
                ConstraintViolation(
                    trip_id=pairs[row.trip_id].id,
                    rule_code=row.rule_code,
                    severity=row.severity,
                    message=row.message,
                )
            )
    await session.flush()
    return len(pairs)


async def create_version(session: AsyncSession, plan: Plan, *, reason: str) -> tuple[Plan, IdMap]:
    """RM-18 : copie un plan `published` en nouvelle version brouillon. Le plan publié reste intact
    (et reste la référence) jusqu'à la publication de la nouvelle version, qui l'archive."""
    if plan.status != PlanStatus.PUBLISHED:
        raise ConflictError(
            "Seul un plan publié donne lieu à une nouvelle version.", code="plan_not_published"
        )
    versions = await lineage(session, plan)
    draft = next((p for p in versions if p.status == PlanStatus.DRAFT), None)
    if draft is not None:
        raise ConflictError(
            f"Une version {draft.version} est déjà en préparation pour ce plan : modifiez-la, "
            "publiez-la, ou restaurez une version publiée.",
            code="draft_version_exists",
            details=[{"draft_plan_id": str(draft.id), "version": draft.version}],
        )
    copy, ids = await copy_plan(session, plan, version=max(p.version for p in versions) + 1)
    await session.flush()
    log_event(
        session,
        copy,
        EventType.MANUAL_EDIT,
        {
            "action": "new_version",
            "summary": f"Version {copy.version} créée depuis la version {plan.version} publiée : {reason}",
            "reason": reason,
            "from_plan_id": str(plan.id),
            "from_version": plan.version,
            **ids.payload(),
        },
    )
    await session.flush()
    return await load_plan(session, copy.id), ids


async def restore_version(session: AsyncSession, plan_id: uuid.UUID, version: int) -> Plan:
    """F5.5 : restaure la version `version` de la lignée du plan → nouvelle version brouillon,
    recontrôlée avec les données du moment (à publier pour qu'elle prenne effet)."""
    plan = await load_plan(session, plan_id, for_update=True)
    if plan.kind == PlanKind.MANUAL_REFERENCE:
        raise ConflictError(
            "Ce plan est une journée de référence importée : il n'a pas de version à restaurer.",
            code="plan_is_reference",
        )
    versions = await lineage(session, plan)
    target = next((p for p in versions if p.version == version), None)
    if target is None:
        raise NotFoundError(f"Version {version} introuvable pour ce plan.")
    if target.status == PlanStatus.DRAFT:
        raise ConflictError(
            f"La version {version} est le brouillon en cours : il n'y a rien à restaurer.",
            code="version_is_current_draft",
        )
    abandoned = []
    for other in versions:
        if other.status == PlanStatus.DRAFT:
            other.status = PlanStatus.ARCHIVED  # brouillon abandonné : conservé, jamais supprimé
            abandoned.append(other.version)
    source = await load_plan(session, target.id)
    copy, ids = await copy_plan(session, source, version=max(p.version for p in versions) + 1)
    await session.flush()
    log_event(
        session,
        copy,
        EventType.MANUAL_EDIT,
        {
            "action": "restore",
            "summary": f"Version {copy.version} créée par restauration de la version {version}.",
            "restored_version": version,
            "from_plan_id": str(target.id),
            "abandoned_draft_versions": abandoned,
            **ids.payload(),
        },
    )
    await session.flush()
    copy = await load_plan(session, copy.id)
    await recheck(session, copy)
    return await load_plan(session, copy.id)


async def version_events(session: AsyncSession, plan_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[Event]]:
    """Événements journalisés par version (ordre chronologique)."""
    result: dict[uuid.UUID, list[Event]] = {plan_id: [] for plan_id in plan_ids}
    if not plan_ids:
        return result
    rows = await session.execute(
        select(Event).where(Event.plan_id.in_(plan_ids)).order_by(Event.occurred_at, Event.id)
    )
    for event in rows.scalars():
        result[event.plan_id].append(event)
    return result
