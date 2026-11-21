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
from app.core.enums import EventType, PlanKind, PlanStatus
from app.core.errors import ConflictError, NotFoundError
from app.events.models import Event
from app.planning.checking import load_plan, log_event, recheck, root_id
from app.planning.models import (
    ConstraintViolation,
    Plan,
    Stop,
    StopDelivery,
    Trip,
    TripCompartmentLoad,
    UnservedOrder,
)


@dataclass
class IdMap:
    """Correspondance des identifiants entre un plan et sa copie (tournées, arrêts)."""

    trips: dict[uuid.UUID, uuid.UUID] = field(default_factory=dict)
    stops: dict[uuid.UUID, uuid.UUID] = field(default_factory=dict)

    def trip(self, trip_id: uuid.UUID) -> uuid.UUID:
        return self.trips.get(trip_id, trip_id)

    def stop(self, stop_id: uuid.UUID) -> uuid.UUID:
        return self.stops.get(stop_id, stop_id)


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
    copy, _ = await copy_plan(session, source, version=max(p.version for p in versions) + 1)
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
