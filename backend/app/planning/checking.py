"""Chargement d'un plan, recontrôle après modification (F5.2), métriques et journal (lot L5).

`recheck` est le passage obligé après toute modification d'un plan : horaires et distances
(`timing.schedule_trip`), plan de chargement (`assign_compartments`), violations (`check_plan`),
métriques. Aucune règle métier n'est codée ici : tout vient de `violations/rules.py`.
"""

from __future__ import annotations

import re
import uuid
from collections import Counter, defaultdict
from dataclasses import fields, replace
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.context import current_user_id
from app.core.enums import EventType, OrderStatus, PlanKind, Severity, StopStatus
from app.core.errors import ConflictError, NotFoundError
from app.core.settings_store import load_params
from app.core.time import utcnow
from app.events.models import Event
from app.loading.models import Loading
from app.orders.models import Order
from app.planning import mapping, timing
from app.planning.domain import Matrix, Params, PlanningProblem, TripD, UnservedD, ViolationD
from app.planning.engine import compartments
from app.planning.models import ConstraintViolation, Plan, Stop, Trip
from app.planning.violations import rules
from app.referentials.models import Truck

PLAN_LOAD = (
    selectinload(Plan.trips).selectinload(Trip.stops).selectinload(Stop.deliveries),
    selectinload(Plan.trips).selectinload(Trip.compartment_loads),
    selectinload(Plan.unserved),
    selectinload(Plan.violations),
)

# Statuts de commande qui retirent une commande non servie du contrôle (RM-15 : « reportée explicitement »).
_OUT_OF_PLAN = (OrderStatus.POSTPONED, OrderStatus.CANCELLED)
_PARAM_NAMES = {f.name for f in fields(Params)}
# Violations enregistrées par d'autres modules que la planification : jamais effacées par un recontrôle.
EXTERNAL_RULE_CODES = frozenset({"RM-13"})


async def load_plan(session: AsyncSession, plan_id: uuid.UUID, *, for_update: bool = False) -> Plan:
    """Charge un plan complet (tournées, arrêts, livraisons, chargement, non servies, violations).

    Les modifications en attente doivent avoir été envoyées (`flush`) : l'état est relu en base."""
    stmt = (
        select(Plan).where(Plan.id == plan_id).options(*PLAN_LOAD).execution_options(populate_existing=True)
    )
    if for_update:
        stmt = stmt.with_for_update(of=Plan)
    plan = (await session.execute(stmt)).scalar_one_or_none()
    if plan is None:
        raise NotFoundError("Plan introuvable.")
    return plan


def ensure_not_reference(plan: Plan) -> None:
    """Une journée de référence (`manual_reference`) est le relevé de ce qui a réellement été fait,
    estimé une fois à l'import (lot L7) : elle n'est ni modifiée, ni recalculée, ni recontrôlée —
    ses horaires, violations et métriques ne sont jamais réécrits par le service de plans."""
    if plan.kind == PlanKind.MANUAL_REFERENCE:
        raise ConflictError(
            "Ce plan est une journée de référence importée : il ne peut être ni modifié ni recalculé.",
            code="plan_is_reference",
        )


async def loaded_trip_ids(session: AsyncSession, plan: Plan) -> set[uuid.UUID]:
    """Tournées du plan qui ont un chargement enregistré (lot L6)."""
    ids = [t.id for t in plan.trips]
    if not ids:
        return set()
    return set((await session.execute(select(Loading.trip_id).where(Loading.trip_id.in_(ids)))).scalars())


def root_id(plan: Plan) -> uuid.UUID:
    """Identifiant de la lignée de versions d'un plan (RM-18)."""
    return plan.root_plan_id or plan.id


def plan_order_ids(plan: Plan) -> set[uuid.UUID]:
    ids = {u.order_id for u in plan.unserved}
    for trip in plan.trips:
        for stop in trip.stops:
            ids.update(d.order_id for d in stop.deliveries)
    return ids


def delivered_order_ids(plan: Plan) -> set[uuid.UUID]:
    """Commandes livrées par un arrêt du plan qui n'a pas été sauté."""
    return {
        d.order_id
        for trip in plan.trips
        for stop in trip.stops
        if stop.status != StopStatus.SKIPPED
        for d in stop.deliveries
    }


def snapshot_override(plan: Plan, override: dict[str, Any] | None = None) -> dict[str, Any]:
    """Paramètres d'un plan existant : ceux de son calcul (`params_snapshot`, F4.6) priment sur les
    réglages courants, une surcharge explicite prime sur le tout."""
    merged = {k: v for k, v in (plan.params_snapshot or {}).items() if k in _PARAM_NAMES and v is not None}
    merged.update(override or {})
    return merged


async def plan_problem(
    session: AsyncSession,
    plan: Plan,
    *,
    params_override: dict[str, Any] | None = None,
    extra_order_ids: set[uuid.UUID] | None = None,
) -> PlanningProblem:
    """Problème correspondant à un plan existant : ses commandes (servies et non servies), plus
    `extra_order_ids`. Le volume demandé est le reliquat après les autres plans publiés (RM-16)."""
    problem, _ = await plan_context(
        session, plan, params_override=params_override, extra_order_ids=extra_order_ids
    )
    return problem


async def plan_context(
    session: AsyncSession,
    plan: Plan,
    *,
    params_override: dict[str, Any] | None = None,
    extra_order_ids: set[uuid.UUID] | None = None,
) -> tuple[PlanningProblem, mapping.ForeignTrips]:
    """Comme `plan_problem`, et renvoie aussi les tournées des autres plans publiés du jour, à
    soumettre au moteur et aux règles avec celles du plan (RM-02, RM-11, RM-14)."""
    params = await load_params(session, snapshot_override(plan, params_override))
    ids = plan_order_ids(plan) | (extra_order_ids or set())
    orders = list((await session.execute(select(Order).where(Order.id.in_(ids)))).scalars()) if ids else []
    delivered = delivered_order_ids(plan)
    # Une commande reportée ou annulée qui n'est livrée par aucune tournée sort du problème.
    orders = [o for o in orders if o.id in delivered or o.status not in _OUT_OF_PLAN]
    elsewhere = await mapping.planned_elsewhere(session, ids, exclude_root_id=root_id(plan))
    requested = {}
    for order in orders:
        remainder = float(order.requested_l) - elsewhere.get(order.id, 0.0)
        if 0 < remainder < float(order.requested_l):
            requested[order.id] = remainder
    computed = plan.kind == PlanKind.COMPUTED
    foreign = mapping.ForeignTrips()
    if computed:
        foreign = await mapping.foreign_trips(
            session, plan.day, params.timezone, exclude_root_id=root_id(plan)
        )
    problem = await mapping.assemble_problem(
        session,
        plan.day,
        params,
        orders,
        requested=requested,
        plan=plan,
        net_of_published=computed,
        exclude_root_id=root_id(plan),
        foreign=foreign,
    )
    return problem, foreign


_FOREIGN_SEQ = re.compile(rf"\b{mapping.FOREIGN_SEQ_BASE // 1000}\d{{3}}\b")


def check_with_foreign(
    problem: PlanningProblem,
    trips: list[TripD],
    unserved: list[UnservedD] | None,
    matrix: Matrix | None,
    foreign: mapping.ForeignTrips,
) -> list[ViolationD]:
    """`rules.check_plan` sur le plan **et** les tournées des autres plans publiés du jour.

    Les règles voient toutes les tournées du jour (chevauchements RM-02, chargements RM-14, cumul
    de service RM-11). Ne sont gardées que les violations qui concernent le plan contrôlé : celles
    que les autres plans présentent déjà à eux seuls sont écartées. Une violation que les règles
    rattachent à une tournée d'un autre plan est enregistrée au niveau du plan, et son message
    désigne cette tournée en clair (« tournée 2 du plan publié (version 3) »)."""
    if not foreign.trips:
        return list(rules.check_plan(problem, trips, unserved, matrix))

    combined = rules.check_plan(problem, [*trips, *foreign.trips], unserved, matrix)
    alone_problem = replace(problem, orders=[], locked_trips=[])
    alone = Counter(
        (v.rule_code, v.message)
        for v in rules.check_plan(alone_problem, list(foreign.trips), [], matrix)
        if v.trip_seq in foreign.seqs
    )
    kept: list[ViolationD] = []
    for violation in combined:
        if violation.trip_seq in foreign.seqs:
            key = (violation.rule_code, violation.message)
            if alone[key] > 0:
                alone[key] -= 1
                continue  # défaut propre à l'autre plan : il y est déjà signalé
            violation.trip_seq = None
            violation.stop_seq = None
        violation.message = _FOREIGN_SEQ.sub(
            lambda m: foreign.labels.get(int(m.group()), m.group()), violation.message
        )
        kept.append(violation)
    return kept


def schedule_all(trips: list[TripD], problem: PlanningProblem, matrix: Matrix) -> None:
    """Recalcule les horaires de toutes les tournées.

    Les tournées d'un même camion s'enchaînent : une tournée ne commence pas avant le retour de la
    précédente (elle garde sinon son heure de début). Les chevauchements restants (chauffeur
    partagé…) sont constatés par RM-02."""
    by_truck: dict[str, list[TripD]] = defaultdict(list)
    for trip in trips:
        by_truck[trip.truck_id].append(trip)
    for group in by_truck.values():
        group.sort(key=lambda t: (t.start_s, t.seq))
        previous_return: int | None = None
        for trip in group:
            start = trip.start_s if previous_return is None else max(trip.start_s, previous_return)
            timing.schedule_trip(trip, problem, matrix, start_s=start)
            previous_return = trip.return_s


def assign_loads(trips: list[TripD], problem: PlanningProblem) -> list[ViolationD]:
    """Recalcule le plan de chargement de chaque tournée. Renvoie une violation bloquante par
    tournée dont les volumes ne peuvent pas être répartis dans les compartiments."""
    failures: list[ViolationD] = []
    for trip in trips:
        volumes = {p: v for p, v in trip.volumes_by_product().items() if v > 0}
        if not volumes:
            trip.loads = []
            continue
        loads = compartments.assign_compartments(
            problem.truck(trip.truck_id), volumes, problem.params.compartment_safety_margin_pct
        )
        if loads is None:
            trip.loads = []
            failures.append(
                ViolationD(
                    rule_code="RM-05",
                    severity=Severity.BLOCKING,
                    message=(
                        f"Tournée {trip.seq} : plan de chargement impossible, les volumes ne tiennent pas "
                        "dans les compartiments du camion (RM-05, RM-06, RM-07)."
                    ),
                    trip_seq=trip.seq,
                )
            )
        else:
            trip.loads = loads
    return failures


def store_violations(plan: Plan, violations: list[ViolationD], trip_by_seq: dict[int, Trip]) -> None:
    """Remplace les violations de planification enregistrées (`trip_seq` / `stop_seq` → identifiants).

    Les violations écrites par d'autres modules (`EXTERNAL_RULE_CODES` : RM-13, posée par le
    chargement) ne viennent pas de `check_plan` et sont conservées."""
    for row in [v for v in plan.violations if v.rule_code not in EXTERNAL_RULE_CODES]:
        plan.violations.remove(row)
    for violation in violations:
        trip = trip_by_seq.get(violation.trip_seq) if violation.trip_seq is not None else None
        stop = None
        if trip is not None and violation.stop_seq is not None:
            stop = next((s for s in trip.stops if s.seq == violation.stop_seq), None)
        plan.violations.append(
            ConstraintViolation(
                trip_id=trip.id if trip is not None else None,
                stop_id=stop.id if stop is not None else None,
                rule_code=violation.rule_code,
                severity=Severity(violation.severity),
                message=violation.message,
            )
        )


async def checked_unserved(session: AsyncSession, plan: Plan) -> list[UnservedD]:
    """Commandes non servies à soumettre aux règles : celles qui n'ont pas été reportées ou annulées."""
    ids = [u.order_id for u in plan.unserved]
    if not ids:
        return []
    rows = await session.execute(select(Order.id, Order.status, Order.priority).where(Order.id.in_(ids)))
    info = {order_id: (status, priority) for order_id, status, priority in rows.all()}
    kept = [u for u in plan.unserved if info.get(u.order_id, (None, None))[0] not in _OUT_OF_PLAN]
    # Urgentes en tête (RM-15).
    kept.sort(key=lambda u: (str(info[u.order_id][1]) != "urgent", str(u.order_id)))
    return [
        UnservedD(order_id=str(u.order_id), reason_code=u.reason_code, reason_text=u.reason_text or "")
        for u in kept
    ]


async def recheck(
    session: AsyncSession,
    plan: Plan,
    *,
    problem: PlanningProblem | None = None,
    matrix: Matrix | None = None,
) -> list[ViolationD]:
    """Recalcule et enregistre horaires, distances, plan de chargement, violations et métriques
    d'un plan chargé par `load_plan` (F5.2). Un plan avec violations est enregistré tel quel."""
    ensure_not_reference(plan)
    await session.flush()
    foreign = mapping.ForeignTrips()
    if problem is None:
        problem, foreign = await plan_context(session, plan)
    if matrix is None:
        matrix = await mapping.build_plan_matrix(session, problem)
    tz_name = problem.params.timezone

    trips = [mapping.trip_to_domain(row, plan.day, tz_name) for row in plan.trips]
    schedule_all(trips, problem, matrix)
    failures = assign_loads(trips, problem)
    rows_by_id = {str(row.id): row for row in plan.trips}
    for trip in trips:
        mapping.apply_trip_schedule(rows_by_id[trip.ref], trip, plan.day, tz_name)

    unserved = await checked_unserved(session, plan)
    # Vu des règles, un arrêt sauté ne livre rien (RM-15, RM-16).
    violations = check_with_foreign(problem, mapping.without_skipped(trips), unserved, matrix, foreign)
    for failure in failures:
        already = any(
            v.trip_seq == failure.trip_seq
            and v.severity == Severity.BLOCKING
            and v.rule_code in ("RM-05", "RM-06", "RM-07")
            for v in violations
        )
        if not already:
            violations.append(failure)

    store_violations(plan, violations, {row.seq: row for row in plan.trips})
    plan.approximate = bool(plan.approximate or matrix.approximate) if plan.trips else plan.approximate
    await refresh_metrics(session, plan)
    await session.flush()
    return violations


# --------------------------------------------------------------------------- métriques


async def truck_capacities(session: AsyncSession, truck_ids: set[uuid.UUID]) -> dict[uuid.UUID, float]:
    """Capacité totale des compartiments par camion (base du taux de remplissage)."""
    if not truck_ids:
        return {}
    trucks = (await session.execute(select(Truck).where(Truck.id.in_(truck_ids)))).scalars()
    return {t.id: float(sum(c.capacity_l for c in t.compartments)) for t in trucks}


def trip_planned_l(trip: Trip) -> float:
    return float(sum(d.planned_l for stop in trip.stops for d in stop.deliveries))


def fill_rate(planned_l: float, capacity_l: float | None) -> float | None:
    """Taux de remplissage d'une tournée (0 à 1) : volume planifié / capacité des compartiments."""
    if not capacity_l:
        return None
    return round(planned_l / capacity_l, 4)


async def refresh_metrics(session: AsyncSession, plan: Plan, extra: dict[str, Any] | None = None) -> dict:
    """Recalcule les métriques agrégées du plan à partir de son contenu enregistré.

    `extra` : métriques du moteur, conservées telles quelles sauf pour les clés recalculées ici."""
    capacities = await truck_capacities(session, {t.truck_id for t in plan.trips})
    order_ids = plan_order_ids(plan)
    requested: dict[uuid.UUID, float] = {}
    if order_ids:
        rows = await session.execute(select(Order.id, Order.requested_l).where(Order.id.in_(order_ids)))
        requested = {order_id: float(value) for order_id, value in rows.all()}

    delivered: dict[uuid.UUID, float] = defaultdict(float)
    stations: set[uuid.UUID] = set()
    stops_count = 0
    rates = []
    for trip in plan.trips:
        rate = fill_rate(trip_planned_l(trip), capacities.get(trip.truck_id))
        if rate is not None:
            rates.append(rate)
        for stop in trip.stops:
            stops_count += 1
            if stop.status == StopStatus.SKIPPED:
                continue  # un arrêt sauté ne sert ni station ni commande
            stations.add(stop.station_id)
            for delivery in stop.deliveries:
                delivered[delivery.order_id] += float(delivery.planned_l)

    metrics = dict(extra or {})
    metrics.update(
        total_distance_m=sum(t.distance_m for t in plan.trips),
        total_duration_s=sum(t.duration_s for t in plan.trips),
        trips_count=len(plan.trips),
        trucks_count=len({t.truck_id for t in plan.trips}),
        drivers_count=len({t.driver_id for t in plan.trips if t.driver_id}),
        stops_count=stops_count,
        stations_served=len(stations),
        orders_total=len(order_ids),
        orders_served=len(delivered),
        orders_partial=sum(1 for o, v in delivered.items() if v < requested.get(o, v) - 0.01),
        orders_unserved=len(plan.unserved),
        requested_l=round(sum(requested.values()), 2),
        planned_l=round(sum(delivered.values()), 2),
        avg_fill_rate=round(sum(rates) / len(rates), 4) if rates else None,
        blocking_count=sum(1 for v in plan.violations if v.severity == Severity.BLOCKING),
        warning_count=sum(1 for v in plan.violations if v.severity == Severity.WARNING),
    )
    plan.metrics = metrics
    return metrics


# --------------------------------------------------------------------------- journal


def log_event(
    session: AsyncSession,
    plan: Plan,
    event_type: EventType,
    payload: dict[str, Any],
    *,
    trip_id: uuid.UUID | None = None,
    actor_id: uuid.UUID | None = None,
) -> Event:
    """Journalise un événement sur le plan (qui, quoi, quand) — visible dans le journal de la
    journée (F6.4) et dans l'historique des versions (F5.5)."""
    event = Event(
        day=plan.day,
        plan_id=plan.id,
        trip_id=trip_id,
        type=event_type,
        payload={"plan_version": plan.version, **payload},
        occurred_at=utcnow(),
        actor_id=actor_id or current_user_id.get(),
    )
    session.add(event)
    return event
