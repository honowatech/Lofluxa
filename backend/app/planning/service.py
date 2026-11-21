"""Service de plans : pont entre la base, le moteur et les règles — LOT L5.

Les autres modules (événements, comparaison/rejeu) passent par ces fonctions et n'appellent
jamais le moteur directement. Fonctions du contrat (docs/CONTRATS.md §5) : `build_problem`,
`persist_result`, `load_plan_trips`, `launch_compute`, `new_version`, `recheck_plan`.

Le moteur et les règles sont toujours appelés par leur module (`engine.solve`,
`rules.check_plan`, `compartments.assign_compartments`, `distance_matrix.build_matrix`) : les
tests les remplacent par des doublures tant que les lots L1 et L2 ne sont pas intégrés.
"""

from __future__ import annotations

import uuid
from dataclasses import asdict, fields
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import new_id
from app.core.enums import EventType, OrderStatus, PlanKind, PlanStatus, Severity, TripStatus
from app.core.errors import ConflictError, RuleViolationError, ValidationAppError
from app.core.settings_store import load_params
from app.core.time import utcnow
from app.orders import service as orders_service
from app.orders.models import Order
from app.planning import checking, editing, engine, mapping, versions
from app.planning.checking import load_plan, log_event
from app.planning.domain import Params, PlanningProblem, PlanningResult, TripD, ViolationD
from app.planning.engine import ProgressCallback
from app.planning.models import Plan, Trip, UnservedOrder

_PARAM_NAMES = {f.name for f in fields(Params)}
_EPSILON_L = 0.01


def validate_params_override(override: dict[str, Any] | None) -> dict[str, Any]:
    """Surcharge ponctuelle des paramètres d'un calcul : seuls les paramètres du moteur sont admis."""
    override = override or {}
    unknown = sorted(set(override) - _PARAM_NAMES)
    if unknown:
        raise ValidationAppError(
            "Paramètres de calcul inconnus : " + ", ".join(unknown) + ".",
            details=[{"field": f"params.{name}", "message": "Paramètre inconnu."} for name in unknown],
        )
    return override


# --------------------------------------------------------------------------- base → domaine


async def build_problem(
    session: AsyncSession,
    day: date,
    *,
    params_override: dict[str, Any] | None = None,
    order_ids: list[uuid.UUID] | None = None,
) -> PlanningProblem:
    """Construit le problème du jour J depuis la base (commandes `confirmed` par défaut,
    ou `order_ids` imposés pour un rejeu), ressources, stocks dépôt et paramètres.

    Par défaut, le volume demandé d'une commande `confirmed` déjà planifiée en partie dans un plan
    publié est son reliquat (RM-16) ; avec `order_ids`, les volumes demandés sont pris tels quels."""
    params = await load_params(session, validate_params_override(params_override))
    if order_ids is not None:
        orders = list((await session.execute(select(Order).where(Order.id.in_(order_ids)))).scalars())
        return await mapping.assemble_problem(session, day, params, orders)

    rows = await session.execute(select(Order).where(Order.day == day, Order.status == OrderStatus.CONFIRMED))
    orders = list(rows.scalars())
    requested, orders = await _remainders(session, orders)
    return await mapping.assemble_problem(session, day, params, orders, requested=requested)


async def _remainders(
    session: AsyncSession, orders: list[Order], *, exclude_root_id: uuid.UUID | None = None
) -> tuple[dict[uuid.UUID, float], list[Order]]:
    """Reliquat à planifier par commande (RM-16) : demandé − déjà planifié dans les plans publiés.
    Les commandes sans reliquat sont écartées."""
    elsewhere = await mapping.planned_elsewhere(
        session, [o.id for o in orders], exclude_root_id=exclude_root_id
    )
    requested: dict[uuid.UUID, float] = {}
    kept = []
    for order in orders:
        remainder = float(order.requested_l) - elsewhere.get(order.id, 0.0)
        if remainder <= _EPSILON_L:
            continue
        requested[order.id] = remainder
        kept.append(order)
    return requested, kept


async def order_remainders(session: AsyncSession, order_ids: list[uuid.UUID]) -> dict[uuid.UUID, float]:
    """Reliquat restant à planifier par commande (RM-16) = volume demandé − volume planifié dans
    les plans publiés. Utile aux écrans de commandes pour afficher « reste X L à planifier »."""
    orders = list((await session.execute(select(Order).where(Order.id.in_(order_ids)))).scalars())
    elsewhere = await mapping.planned_elsewhere(session, order_ids)
    return {o.id: max(float(o.requested_l) - elsewhere.get(o.id, 0.0), 0.0) for o in orders}


async def load_plan_trips(session: AsyncSession, plan_id: uuid.UUID) -> list[TripD]:
    """Recharge les tournées d'un plan persisté sous forme de domaine (`TripD.ref` = trips.id)."""
    plan = await load_plan(session, plan_id)
    params = await load_params(session, checking.snapshot_override(plan))
    return [mapping.trip_to_domain(row, plan.day, params.timezone) for row in plan.trips]


# --------------------------------------------------------------------------- domaine → base


def _fill_from_result(plan: Plan, result: PlanningResult, tz_name: str) -> dict[int, Trip]:
    """Ajoute au plan les tournées et les non servies d'un résultat. Renvoie seq du résultat → tournée."""
    by_seq: dict[int, Trip] = {}
    for trip in result.trips:
        row = mapping.new_trip_row(trip, plan.day, tz_name)
        plan.trips.append(row)
        by_seq[trip.seq] = row
    _set_unserved(plan, result)
    return by_seq


def _set_unserved(plan: Plan, result: PlanningResult) -> None:
    plan.unserved.clear()
    for unserved in result.unserved:
        plan.unserved.append(
            UnservedOrder(
                order_id=uuid.UUID(unserved.order_id),
                reason_code=unserved.reason_code,
                reason_text=unserved.reason_text or None,
            )
        )


def _trace(plan: Plan, result: PlanningResult, params_snapshot: dict[str, Any] | None) -> None:
    """Trace de reproductibilité (F4.6) et journal de résolution (§7.4)."""
    plan.engine_version = result.engine_version or engine.ENGINE_VERSION
    plan.computed_at = utcnow()
    plan.computed_in_ms = int(result.computed_in_ms)
    plan.approximate = bool(result.approximate)
    plan.solver_log = result.solver_log or {}
    if params_snapshot is not None:
        plan.params_snapshot = params_snapshot


async def persist_result(
    session: AsyncSession,
    day: date,
    result: PlanningResult,
    *,
    kind: PlanKind = PlanKind.COMPUTED,
    parent_plan_id: uuid.UUID | None = None,
    params_snapshot: dict[str, Any] | None = None,
    label: str | None = None,
) -> Plan:
    """Enregistre un résultat du moteur comme plan `draft` (trips, stops, loads, unserved, violations).

    Le plan créé est la version 1 d'une nouvelle lignée ; `parent_plan_id` relie par exemple un
    rejeu à sa journée de référence, sans en faire une version."""
    plan_id = new_id()
    plan = Plan(
        id=plan_id,
        day=day,
        kind=kind,
        status=PlanStatus.DRAFT,
        version=1,
        parent_plan_id=parent_plan_id,
        root_plan_id=plan_id,
        label=label,
        trips=[],
        unserved=[],
        violations=[],
    )
    session.add(plan)
    await session.flush()
    tz_name = (params_snapshot or {}).get("timezone") or (await load_params(session)).timezone
    _trace(plan, result, params_snapshot)
    by_seq = _fill_from_result(plan, result, tz_name)
    await session.flush()
    checking.store_violations(plan, result.violations, by_seq)
    await checking.refresh_metrics(session, plan, extra=result.metrics)
    await session.flush()
    return await load_plan(session, plan.id)


# --------------------------------------------------------------------------- calcul (F4)


async def run_compute(
    session: AsyncSession,
    day: date,
    *,
    params_override: dict[str, Any] | None = None,
    kind: PlanKind = PlanKind.COMPUTED,
    order_ids: list[uuid.UUID] | None = None,
    parent_plan_id: uuid.UUID | None = None,
    label: str | None = None,
    progress: ProgressCallback | None = None,
) -> Plan:
    """Calcule et enregistre le plan du jour J. C'est la fonction exécutée par la tâche de fond ;
    elle reçoit sa session (testable sans Celery)."""
    notify = progress or (lambda pct, message: None)
    notify(2, "Lecture des commandes, des ressources et des stocks")
    problem = await build_problem(session, day, params_override=params_override, order_ids=order_ids)
    if not problem.orders:
        raise ConflictError(
            f"Aucune commande confirmée à planifier pour le {day:%d/%m/%Y}.", code="no_orders_to_plan"
        )
    notify(8, "Calcul des distances")
    matrix = await mapping.build_plan_matrix(session, problem)
    notify(15, "Calcul des tournées")
    result = engine.solve(problem, matrix, lambda pct, message: notify(15 + int(pct * 0.75), message))
    result.approximate = bool(result.approximate or matrix.approximate)
    notify(92, "Enregistrement du plan")
    plan = await persist_result(
        session,
        day,
        result,
        kind=kind,
        parent_plan_id=parent_plan_id,
        params_snapshot=asdict(problem.params),
        label=label,
    )
    notify(100, "Plan calculé")
    return plan


async def run_recompute(
    session: AsyncSession,
    plan_id: uuid.UUID,
    *,
    params_override: dict[str, Any] | None = None,
    progress: ProgressCallback | None = None,
) -> Plan:
    """F5.3 « Recalculer en conservant » : relance le moteur en figeant les tournées verrouillées
    (RM-17). Les tournées figées ne sont pas réécrites ; les autres sont remplacées.

    Sont figées : les tournées `locked`, et celles dont l'exécution a commencé (statut ≠ `planned`).
    Un plan publié n'est pas modifié : le recalcul produit une nouvelle version (RM-18)."""
    notify = progress or (lambda pct, message: None)
    override = validate_params_override(params_override)
    plan, _ = await editing.open_for_edit(
        session, plan_id, reason="Recalcul en conservant les tournées verrouillées"
    )
    frozen = [t for t in plan.trips if t.locked or t.status != TripStatus.PLANNED]
    frozen_ids = {str(t.id) for t in frozen}

    notify(2, "Lecture des commandes, des ressources et des stocks")
    extra: set[uuid.UUID] = set()
    plan_orders = checking.plan_order_ids(plan)
    if plan.kind == PlanKind.COMPUTED:
        # Commandes à (re)planifier : confirmées du jour + celles du plan encore confirmées ou planifiées.
        rows = await session.execute(
            select(Order.id).where(Order.day == plan.day, Order.status == OrderStatus.CONFIRMED)
        )
        extra = set(rows.scalars())
    problem = await checking.plan_problem(session, plan, params_override=override, extra_order_ids=extra)
    if plan.kind == PlanKind.COMPUTED:
        frozen_orders = {str(d.order_id) for t in frozen for s in t.stops for d in s.deliveries}
        statuses = dict(
            (
                await session.execute(select(Order.id, Order.status).where(Order.id.in_(plan_orders | extra)))
            ).all()
        )
        keep = (OrderStatus.CONFIRMED, OrderStatus.PLANNED)
        problem.orders = [
            o for o in problem.orders if o.id in frozen_orders or statuses.get(uuid.UUID(o.id)) in keep
        ]
    tz_name = problem.params.timezone
    problem.locked_trips = [mapping.trip_to_domain(t, plan.day, tz_name) for t in frozen]

    notify(8, "Calcul des distances")
    matrix = await mapping.build_plan_matrix(session, problem)
    notify(15, "Calcul des tournées")
    result = engine.solve(problem, matrix, lambda pct, message: notify(15 + int(pct * 0.75), message))
    result.approximate = bool(result.approximate or matrix.approximate)

    notify(92, "Enregistrement du plan")
    for row in [t for t in plan.trips if str(t.id) not in frozen_ids]:
        plan.trips.remove(row)
    await session.flush()
    # Les violations des tournées supprimées ont disparu en cascade : relire la collection.
    await session.refresh(plan, ["violations"])
    by_seq: dict[int, Trip] = {}
    used = {t.seq for t in frozen}
    frozen_by_id = {str(t.id): t for t in frozen}
    for trip in result.trips:
        if trip.ref in frozen_by_id:
            by_seq[trip.seq] = frozen_by_id[trip.ref]  # RM-17 : la tournée figée n'est pas réécrite
            continue
        seq = trip.seq
        while seq in used:
            seq += 1
        used.add(seq)
        row = mapping.new_trip_row(trip, plan.day, tz_name, seq=seq)
        plan.trips.append(row)
        by_seq[trip.seq] = row
    _set_unserved(plan, result)
    _trace(plan, result, asdict(problem.params))
    await session.flush()
    checking.store_violations(plan, result.violations, by_seq)
    await checking.refresh_metrics(session, plan, extra=result.metrics)
    log_event(
        session,
        plan,
        EventType.REPLAN,
        {
            "action": "recompute",
            "summary": (
                f"Plan recalculé en conservant {len(frozen)} tournée(s) figée(s) : "
                f"{len(plan.trips)} tournée(s), {len(result.unserved)} commande(s) non servie(s)."
            ),
            "kept_trip_ids": sorted(frozen_ids),
            "trips_count": len(plan.trips),
            "unserved_count": len(result.unserved),
        },
    )
    await session.flush()
    notify(100, "Plan recalculé")
    return await load_plan(session, plan.id)


async def launch_compute(
    session: AsyncSession,
    day: date,
    *,
    user_id: uuid.UUID | None,
    params_override: dict[str, Any] | None = None,
    kind: PlanKind = PlanKind.COMPUTED,
    order_ids: list[uuid.UUID] | None = None,
    parent_plan_id: uuid.UUID | None = None,
    label: str | None = None,
) -> str:
    """Lance le calcul en tâche de fond (Celery) et renvoie le `task_id` (suivi : GET /tasks/{id}).

    La tâche ouvre sa propre transaction : les données du jour doivent être validées (commit)
    avant qu'elle ne démarre — c'est le cas à la fin d'une requête d'API."""
    from app.planning import tasks

    validate_params_override(params_override)
    return tasks.dispatch_compute(
        day=day.isoformat(),
        user_id=str(user_id) if user_id else None,
        params_override=params_override or None,
        kind=PlanKind(kind).value,
        order_ids=[str(o) for o in order_ids] if order_ids is not None else None,
        parent_plan_id=str(parent_plan_id) if parent_plan_id else None,
        label=label,
    )


async def launch_recompute(
    session: AsyncSession,
    plan_id: uuid.UUID,
    *,
    user_id: uuid.UUID | None,
    params_override: dict[str, Any] | None = None,
) -> str:
    """Lance « Recalculer en conservant » en tâche de fond et renvoie le `task_id`."""
    from app.planning import tasks

    validate_params_override(params_override)
    return tasks.dispatch_recompute(
        plan_id=str(plan_id),
        user_id=str(user_id) if user_id else None,
        params_override=params_override or None,
    )


# --------------------------------------------------------------------------- versions, contrôle


async def new_version(session: AsyncSession, plan_id: uuid.UUID, *, reason: str) -> Plan:
    """RM-18 : copie un plan `published` en nouvelle version (brouillon), archive la précédente
    à la publication de la nouvelle. Renvoie la nouvelle version, prête à être modifiée.

    Les tournées et les arrêts de la copie ont de nouveaux identifiants ; pour retrouver une
    tournée de l'ancienne version, utiliser `new_version_with_ids`."""
    plan, _ = await new_version_with_ids(session, plan_id, reason=reason)
    return plan


async def new_version_with_ids(
    session: AsyncSession, plan_id: uuid.UUID, *, reason: str
) -> tuple[Plan, versions.IdMap]:
    """Comme `new_version`, et renvoie aussi la correspondance ancien → nouvel identifiant
    (`ids.trip(old_trip_id)`, `ids.stop(old_stop_id)`), utile aux événements (panne, F6.1)."""
    plan = await load_plan(session, plan_id, for_update=True)
    return await versions.create_version(session, plan, reason=reason)


async def recheck_plan(session: AsyncSession, plan_id: uuid.UUID) -> list[ViolationD]:
    """Recalcule horaires (timing.schedule_trip), plan de chargement et violations d'un plan
    après modification, et les enregistre (F5.2)."""
    plan = await load_plan(session, plan_id, for_update=True)
    return await checking.recheck(session, plan)


# --------------------------------------------------------------------------- publication (F5.4)


async def publish_plan(session: AsyncSession, plan_id: uuid.UUID) -> Plan:
    """Publie un brouillon : refus (409, `rule_code`) s'il reste une violation bloquante — y compris
    une commande urgente non servie et non reportée (RM-15) ; sinon le plan est figé, la version
    publiée précédente de la lignée est archivée (RM-18) et les commandes servies passent `planned`."""
    plan = await load_plan(session, plan_id, for_update=True)
    if plan.status == PlanStatus.PUBLISHED:
        raise ConflictError("Ce plan est déjà publié.", code="plan_already_published")
    if plan.status == PlanStatus.ARCHIVED:
        raise ConflictError(
            "Ce plan est archivé : restaurez cette version pour pouvoir la publier.", code="plan_archived"
        )
    if plan.kind != PlanKind.COMPUTED:
        raise ConflictError(
            "Seul un plan calculé se publie (pas une journée de référence ni un rejeu).",
            code="plan_kind_not_publishable",
        )

    await checking.recheck(session, plan)
    plan = await load_plan(session, plan.id)
    blocking = [v for v in plan.violations if v.severity == Severity.BLOCKING]
    if blocking:
        raise RuleViolationError(
            f"Publication impossible : {len(blocking)} violation(s) bloquante(s) à corriger.",
            [
                {
                    "rule_code": v.rule_code,
                    "message": v.message,
                    "severity": Severity(v.severity).value,
                    "trip_id": str(v.trip_id) if v.trip_id else None,
                    "stop_id": str(v.stop_id) if v.stop_id else None,
                }
                for v in blocking
            ],
        )

    archived = None
    previous_orders: set[uuid.UUID] = set()
    for other in await versions.lineage(session, plan):
        if other.id != plan.id and other.status == PlanStatus.PUBLISHED:
            previous = await load_plan(session, other.id)
            previous_orders |= checking.plan_order_ids(previous)
            previous.status = PlanStatus.ARCHIVED
            archived = previous
    plan.status = PlanStatus.PUBLISHED
    await session.flush()

    planned, back = await _sync_order_statuses(session, plan, previous_orders)
    log_event(
        session,
        plan,
        EventType.PUBLISH,
        {
            "action": "publish",
            "summary": f"Version {plan.version} publiée"
            + (f" (la version {archived.version} est archivée)." if archived else "."),
            "archived_plan_id": str(archived.id) if archived else None,
            "archived_version": archived.version if archived else None,
            "trips_count": len(plan.trips),
            "orders_planned": planned,
            "orders_back_to_confirmed": back,
        },
    )
    await session.flush()
    return await load_plan(session, plan.id)


async def _sync_order_statuses(
    session: AsyncSession, plan: Plan, previous_orders: set[uuid.UUID]
) -> tuple[int, int]:
    """Statut des commandes à la publication (F5.4, RM-16).

    - commande entièrement planifiée (tous plans publiés confondus) : `confirmed` → `planned` ;
    - commande planifiée en partie seulement, ou plus servie par la nouvelle version : elle reste
      (ou redevient) `confirmed` — son reliquat sera repris par le prochain calcul."""
    ids = checking.plan_order_ids(plan) | previous_orders
    if not ids:
        return 0, 0
    orders = list((await session.execute(select(Order).where(Order.id.in_(ids)))).scalars())
    total = await mapping.planned_elsewhere(session, ids)
    to_plan, to_release = [], []
    for order in orders:
        full = total.get(order.id, 0.0) >= float(order.requested_l) - _EPSILON_L
        if full and order.status == OrderStatus.CONFIRMED:
            to_plan.append(order.id)
        elif not full and order.status == OrderStatus.PLANNED:
            to_release.append(order.id)
    # Transitions de statut : machine à états du module commandes (lot L4).
    await orders_service.mark_planned(session, to_plan)
    await orders_service.release_to_confirmed(session, to_release)
    return len(to_plan), len(to_release)
