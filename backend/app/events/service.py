"""Événements du jour : panne de camion (F6.1, RM-19) et chauffeur indisponible (F6.2) — lot L10.

Principes
---------
- Un événement porte sur une tournée d'un plan **publié**. Il ne modifie jamais ce plan : il
  travaille sur une nouvelle version brouillon (RM-18, `planning.service.new_version_with_ids`),
  ou sur la version déjà en préparation de la même lignée s'il y en a une.
- Aucune règle n'est codée ici. Le remplaçant est jugé par une **simulation** : on applique le
  changement sur une copie des tournées (domaine), on recalcule les horaires et le plan de
  chargement (`checking.schedule_all`, `checking.assign_loads`) et on passe le tout aux règles
  (`rules.check_plan`). Les violations bloquantes nouvelles qui tiennent au remplaçant
  (`TRUCK_CODES`, `DRIVER_CODES`) valent refus (409, `rule_code`). Les autres violations
  (fenêtres horaires dépassées, stock…) ne refusent pas l'événement : elles sont enregistrées sur
  la nouvelle version, qui reste alors en brouillon jusqu'à correction.
- RM-19 : seuls les arrêts `pending` partent sur la nouvelle tournée du camion de remplacement ;
  les arrêts livrés ou sautés, leurs heures et leurs volumes réels restent sur la tournée d'origine.
"""

from __future__ import annotations

import copy
import uuid
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.availability import service as availability_service
from app.availability.models import DailyResourceStatus
from app.core.enums import EventType, PlanKind, PlanStatus, Severity, StopStatus, TripStatus
from app.core.errors import ConflictError, NotFoundError, RuleViolationError, ValidationAppError
from app.core.time import format_local_hm, utc_to_seconds, utcnow
from app.events import journal
from app.events.schemas import (
    DriverOptionOut,
    DriverUnavailableIn,
    EventResultOut,
    OtherTripOut,
    PlanResultOut,
    ReasonOut,
    ReplacementOptionsOut,
    RuleIssueOut,
    TripBriefOut,
    TruckBreakdownIn,
    TruckOptionOut,
)
from app.planning import checking, mapping, versions, views
from app.planning import service as planning_service
from app.planning.checking import load_plan, log_event
from app.planning.domain import Matrix, PlanningProblem, TripD, UnservedD, ViolationD
from app.planning.models import Plan, Stop, Trip
from app.planning.violations import rules
from app.referentials.models import Depot, Driver, Station, Truck

# Règles qui jugent le camion de remplacement (RM-04 affectable, RM-05/06/07 compartiments,
# RM-09 gabarit, RM-14 chargements par jour) et le chauffeur remplaçant (RM-01, RM-02, RM-03, RM-11).
TRUCK_CODES = frozenset({"RM-04", "RM-05", "RM-06", "RM-07", "RM-09", "RM-14"})
DRIVER_CODES = frozenset({"RM-01", "RM-02", "RM-03", "RM-11"})


# --------------------------------------------------------------------------- version de travail


@dataclass
class Located:
    """Tournée visée par un événement, dans la version du plan sur laquelle on travaille."""

    plan: Plan
    trip: Trip
    source_trip_id: uuid.UUID  # identifiant reçu du client
    created: bool  # la version a été créée par cet appel
    previous: Plan | None  # version publiée de la lignée (référence du terrain)


def _not_published(plan: Plan) -> ConflictError:
    return ConflictError(
        "Un événement du jour ne se déclare que sur une tournée d'un plan publié.",
        code="plan_not_published",
        details=[{"plan_id": str(plan.id), "plan_status": PlanStatus(plan.status).value}],
    )


async def locate(
    session: AsyncSession, trip_id: uuid.UUID, *, reason: str | None = None, follow_archived: bool = False
) -> Located:
    """Trouve la tournée et la version à modifier.

    - tournée d'un plan publié sans brouillon en cours : nouvelle version (RM-18) si `reason` est
      donné, sinon le plan publié lui-même (lecture seule, simulation) ;
    - tournée d'un plan publié dont une nouvelle version est déjà en préparation : on poursuit sur
      ce brouillon (la tournée y est retrouvée par son numéro, stable d'une version à l'autre) ;
    - tournée de ce brouillon : le brouillon ;
    - plan jamais publié, archivé, journée de référence ou rejeu : refus (409 `plan_not_published`).

    `follow_archived` : une tournée d'une version archivée entre-temps est suivie, par son numéro,
    jusqu'à la version publiée de sa lignée (résolution d'une pénurie déclarée plus tôt).
    """
    row = await session.get(Trip, trip_id)
    if row is None:
        raise NotFoundError("Tournée introuvable.")
    seq, source_id = row.seq, trip_id
    write = reason is not None
    plan = await load_plan(session, row.plan_id, for_update=write)
    if plan.kind != PlanKind.COMPUTED:
        raise _not_published(plan)
    lineage = await versions.lineage(session, plan)
    published = next((p for p in lineage if p.status == PlanStatus.PUBLISHED), None)
    draft = next((p for p in lineage if p.status == PlanStatus.DRAFT), None)
    if published is None or (plan.status == PlanStatus.ARCHIVED and not follow_archived):
        raise _not_published(plan)
    if plan.status == PlanStatus.ARCHIVED:
        plan = await load_plan(session, published.id, for_update=write)
        match = next((t for t in plan.trips if t.seq == seq), None)
        if match is None:
            raise ConflictError(
                f"La tournée {seq} n'existe plus dans la version {plan.version} publiée.",
                code="trip_not_in_published",
            )
        trip_id = match.id

    created = False
    if plan.status == PlanStatus.DRAFT:
        working, target_id = plan, trip_id
    elif draft is not None:
        working = await load_plan(session, draft.id, for_update=write)
        match = next((t for t in working.trips if t.seq == seq), None)
        if match is None:
            raise ConflictError(
                f"La tournée {seq} n'existe plus dans la version {working.version} en préparation.",
                code="trip_not_in_draft",
                details=[{"draft_plan_id": str(working.id), "version": working.version}],
            )
        target_id = match.id
    elif not write:
        working, target_id = plan, trip_id
    else:
        working, ids = await planning_service.new_version_with_ids(session, plan.id, reason=reason)
        target_id = ids.trip(trip_id)
        created = True
    trip = next(t for t in working.trips if t.id == target_id)
    return Located(plan=working, trip=trip, source_trip_id=source_id, created=created, previous=published)


# --------------------------------------------------------------------------- simulation


@dataclass
class SimContext:
    plan: Plan
    problem: PlanningProblem
    matrix: Matrix
    trips: list[TripD]
    unserved: list[UnservedD]
    status: dict[str, TripStatus]
    baseline: set[tuple[str, int | None, str]]
    loaded: set[str] = field(default_factory=set)  # tournées ayant un chargement enregistré


@dataclass
class Simulation:
    trips: list[TripD]
    target: TripD
    violations: list[ViolationD]
    issues: list[ViolationD]  # violations bloquantes nouvelles qui tiennent au remplaçant

    def of(self, codes: frozenset[str]) -> list[ViolationD]:
        return [v for v in self.issues if v.rule_code in codes]


def _check(ctx: SimContext, trips: list[TripD]) -> list[ViolationD]:
    """Plan de chargement puis règles, comme `checking.recheck`, mais sans rien enregistrer."""
    failures = checking.assign_loads(trips, ctx.problem)
    violations = list(rules.check_plan(ctx.problem, trips, ctx.unserved, ctx.matrix))
    for failure in failures:
        if not any(
            v.trip_seq == failure.trip_seq
            and v.severity == Severity.BLOCKING
            and v.rule_code in ("RM-05", "RM-06", "RM-07")
            for v in violations
        ):
            violations.append(failure)
    return violations


def _key(violation: ViolationD) -> tuple[str, int | None, str]:
    return violation.rule_code, violation.trip_seq, violation.message


async def build_context(session: AsyncSession, plan: Plan) -> SimContext:
    problem = await checking.plan_problem(session, plan)
    matrix = await mapping.build_plan_matrix(session, problem)
    tz_name = problem.params.timezone
    trips = [mapping.trip_to_domain(row, plan.day, tz_name) for row in plan.trips]
    ctx = SimContext(
        plan=plan,
        problem=problem,
        matrix=matrix,
        trips=trips,
        unserved=await checking.checked_unserved(session, plan),
        status={str(row.id): TripStatus(row.status) for row in plan.trips},
        baseline=set(),
        loaded={str(i) for i in await checking.loaded_trip_ids(session, plan)},
    )
    current = copy.deepcopy(trips)
    checking.schedule_all(current, problem, matrix)
    ctx.baseline = {_key(v) for v in _check(ctx, current)}
    return ctx


def _issues(
    ctx: SimContext,
    trips: list[TripD],
    target: TripD,
    codes: frozenset[str],
    *,
    truck_id: str | None,
    driver_id: str | None,
) -> Simulation:
    violations = _check(ctx, trips)
    affected = {target.seq}
    for trip in trips:
        if (truck_id and trip.truck_id == truck_id) or (driver_id and trip.driver_id == driver_id):
            affected.add(trip.seq)
    issues = [
        v
        for v in violations
        if v.severity == Severity.BLOCKING
        and v.rule_code in codes
        and v.trip_seq in affected
        and _key(v) not in ctx.baseline
    ]
    return Simulation(trips=trips, target=target, violations=violations, issues=issues)


def event_seconds(ctx: SimContext, occurred_at: datetime) -> int:
    """Heure de l'événement en secondes locales du jour J, bornée par le début de journée."""
    seconds = utc_to_seconds(ctx.plan.day, occurred_at, ctx.problem.params.timezone)
    return max(seconds, ctx.problem.params.day_start_s)


def simulate_breakdown(
    ctx: SimContext, origin_ref: str, truck_id: str, driver_id: str | None, event_s: int
) -> Simulation:
    """RM-19 : les arrêts `pending` de la tournée d'origine partent sur une nouvelle tournée du
    camion de remplacement, qui recharge au dépôt à partir de l'heure de l'événement."""
    trips = copy.deepcopy(ctx.trips)
    origin = next(t for t in trips if t.ref == origin_ref)
    pending = [s for s in origin.stops if s.status == StopStatus.PENDING.value]
    origin.stops = [s for s in origin.stops if s.status != StopStatus.PENDING.value]
    for index, stop in enumerate(origin.stops, start=1):
        stop.seq = index
    keep_origin = origin_kept(bool(origin.stops), ctx.status[origin_ref], origin_ref in ctx.loaded)
    if not keep_origin:
        trips.remove(origin)

    start = event_s
    if keep_origin and driver_id and origin.driver_id == driver_id:
        # Le même chauffeur reprend la suite : pas avant son retour (prévu) au dépôt.
        checking.schedule_all(trips, ctx.problem, ctx.matrix)
        start = max(start, origin.return_s)
    target = TripD(
        seq=max(t.seq for t in ctx.trips) + 1,
        truck_id=truck_id,
        depot_id=origin.depot_id,
        driver_id=driver_id,
        start_s=start,
        stops=pending,
    )
    for index, stop in enumerate(target.stops, start=1):
        stop.seq = index
    trips.append(target)
    checking.schedule_all(trips, ctx.problem, ctx.matrix)
    return _issues(ctx, trips, target, TRUCK_CODES | DRIVER_CODES, truck_id=truck_id, driver_id=driver_id)


def simulate_driver_change(ctx: SimContext, trip_ref: str, driver_id: str, event_s: int) -> Simulation:
    """F6.2 : le remplaçant reprend la tournée (même camion, même chargement). Une tournée qui
    n'a pas encore commencé ne démarre pas avant l'heure de l'événement."""
    trips = copy.deepcopy(ctx.trips)
    target = next(t for t in trips if t.ref == trip_ref)
    target.driver_id = driver_id
    if ctx.status[trip_ref] == TripStatus.PLANNED:
        target.start_s = max(target.start_s, event_s)
    checking.schedule_all(trips, ctx.problem, ctx.matrix)
    return _issues(ctx, trips, target, DRIVER_CODES, truck_id=None, driver_id=driver_id)


def origin_kept(has_stops: bool, status: TripStatus, loaded: bool) -> bool:
    """La tournée d'origine reste au plan si elle porte des arrêts réalisés, si son exécution a
    commencé (statut ≠ `planned`) ou si elle a un chargement enregistré : ses réalisés (chargement,
    heures réelles) ne doivent pas disparaître avec elle."""
    return has_stops or status != TripStatus.PLANNED or loaded


def _rule_error(message: str, issues: list[ViolationD]) -> RuleViolationError:
    return RuleViolationError(
        message,
        [
            {
                "rule_code": v.rule_code,
                "message": v.message,
                "severity": Severity(v.severity).value,
                "trip_seq": v.trip_seq,
            }
            for v in issues
        ],
    )


# --------------------------------------------------------------------------- aides


def _pending(trip: Trip) -> list[Stop]:
    return [s for s in sorted(trip.stops, key=lambda s: s.seq) if s.status == StopStatus.PENDING]


def _ensure_replaceable(trip: Trip) -> None:
    reason = _blocked_reason(trip)
    if reason is not None:
        code = "trip_completed" if trip.status == TripStatus.COMPLETED else "no_pending_stops"
        raise ConflictError(reason, code=code)


def _blocked_reason(trip: Trip) -> str | None:
    if trip.status == TripStatus.COMPLETED:
        return f"La tournée {trip.seq} est terminée : il n'y a plus rien à réaffecter."
    if not _pending(trip):
        return f"La tournée {trip.seq} n'a plus aucun arrêt en attente de livraison."
    return None


async def _truck(session: AsyncSession, truck_id: uuid.UUID) -> Truck:
    truck = await session.get(Truck, truck_id)
    if truck is None or truck.deleted_at is not None:
        raise NotFoundError("Camion de remplacement introuvable.", details=[{"truck_id": str(truck_id)}])
    return truck


async def _driver(session: AsyncSession, driver_id: uuid.UUID) -> Driver:
    driver = await session.get(Driver, driver_id)
    if driver is None or driver.deleted_at is not None:
        raise NotFoundError("Chauffeur remplaçant introuvable.", details=[{"driver_id": str(driver_id)}])
    return driver


async def mark_unavailable(
    session: AsyncSession,
    plan: Plan,
    *,
    truck_id: uuid.UUID | None = None,
    driver_id: uuid.UUID | None = None,
    reason: str,
) -> None:
    """Marque un camion ou un chauffeur indisponible pour la journée du plan (F2.2, F2.3)."""
    column = DailyResourceStatus.truck_id if truck_id else DailyResourceStatus.driver_id
    mark = (
        await session.execute(
            select(DailyResourceStatus).where(
                DailyResourceStatus.day == plan.day, column == (truck_id or driver_id)
            )
        )
    ).scalar_one_or_none()
    if mark is None:
        session.add(
            DailyResourceStatus(
                day=plan.day, truck_id=truck_id, driver_id=driver_id, available=False, reason=reason
            )
        )
    else:
        mark.available, mark.reason = False, reason


def _issue_out(plan: Plan) -> list[RuleIssueOut]:
    seq = {t.id: t.seq for t in plan.trips}
    rows = sorted(
        plan.violations, key=lambda v: (v.severity != Severity.BLOCKING, seq.get(v.trip_id) or 0, v.rule_code)
    )
    return [
        RuleIssueOut(
            rule_code=v.rule_code,
            severity=v.severity,
            message=v.message,
            trip_id=v.trip_id,
            trip_seq=seq.get(v.trip_id),
        )
        for v in rows
    ]


def blocking_count(plan: Plan) -> int:
    return sum(1 for v in plan.violations if v.severity == Severity.BLOCKING)


def will_publish(plan: Plan, publish: bool | None, created: bool) -> bool:
    """Publication d'office de la nouvelle version : seulement sans violation bloquante, et par
    défaut seulement si la version vient d'être créée par l'événement (un brouillon déjà en
    préparation n'est publié que sur demande explicite)."""
    wanted = created if publish is None else publish
    return bool(wanted) and plan.status == PlanStatus.DRAFT and blocking_count(plan) == 0


async def plan_result(
    session: AsyncSession, plan_id: uuid.UUID, *, publish: bool, created: bool, previous: Plan | None
) -> PlanResultOut:
    """Publie la version si demandé (l'appelant a vérifié qu'elle n'a pas de violation bloquante :
    la version publiée précédente est alors archivée, RM-18) et renvoie son état."""
    if publish:
        await planning_service.publish_plan(session, plan_id)
    plan = await load_plan(session, plan_id)
    if previous is not None:
        await session.refresh(previous, ["status"])
    blocking = blocking_count(plan)
    return PlanResultOut(
        plan_id=plan.id,
        plan_version=plan.version,
        plan_status=plan.status,
        published=plan.status == PlanStatus.PUBLISHED,
        version_created=created,
        previous_plan_id=previous.id if previous is not None and previous.id != plan.id else None,
        previous_plan_version=previous.version if previous is not None and previous.id != plan.id else None,
        previous_plan_status=previous.status if previous is not None and previous.id != plan.id else None,
        blocking_count=blocking,
        warning_count=len(plan.violations) - blocking,
        violations=_issue_out(plan),
        plan=await views.plan_out(session, plan),
    )


def status_sentence(plan: Plan, publish: bool) -> str:
    if publish:
        return f"Version {plan.version} publiée."
    blocking = blocking_count(plan)
    if blocking:
        return (
            f"Version {plan.version} laissée en brouillon : {blocking} violation(s) bloquante(s) à corriger "
            "avant publication."
        )
    return f"Version {plan.version} en brouillon, à publier."


def _others(plan: Plan, exclude: set[uuid.UUID], *, truck_id=None, driver_id=None) -> list[OtherTripOut]:
    """Autres tournées non terminées de la ressource défaillante, encore à traiter."""
    out = []
    for trip in plan.trips:
        if trip.id in exclude or trip.status == TripStatus.COMPLETED or not _pending(trip):
            continue
        if (truck_id and trip.truck_id == truck_id) or (driver_id and trip.driver_id == driver_id):
            out.append(
                OtherTripOut(
                    trip_id=trip.id, seq=trip.seq, status=trip.status, pending_stops=len(_pending(trip))
                )
            )
    return sorted(out, key=lambda t: t.seq)


async def _station_codes(session: AsyncSession, stops: list[Stop]) -> dict[uuid.UUID, str]:
    ids = {s.station_id for s in stops}
    if not ids:
        return {}
    rows = await session.execute(select(Station.id, Station.code).where(Station.id.in_(ids)))
    return dict(rows.all())


# --------------------------------------------------------------------------- panne de camion (F6.1)


async def _driver_candidates(
    session: AsyncSession, plan: Plan, origin: Trip, truck: Truck, explicit: uuid.UUID | None
) -> list[uuid.UUID]:
    """Chauffeur de la nouvelle tournée : celui fourni ; sinon celui affecté au camion de
    remplacement pour la journée ; sinon le chauffeur de la tournée d'origine."""
    if explicit is not None:
        return [explicit]
    resources = await availability_service.load_day_resources(session, plan.day)
    candidates: list[uuid.UUID] = []
    assigned = next((t.driver for t in resources.trucks if t.truck.id == truck.id), None)
    if assigned is not None:
        candidates.append(assigned.id)
    if origin.driver_id is not None and origin.driver_id not in candidates:
        candidates.append(origin.driver_id)
    return candidates


def _pick_driver(
    ctx: SimContext, origin: Trip, truck: Truck, candidates: list[uuid.UUID], event_s: int
) -> tuple[Simulation | None, Simulation | None]:
    """Première simulation sans reproche, et à défaut la première simulation (pour ses motifs)."""
    first = None
    for driver_id in candidates:
        simulation = simulate_breakdown(ctx, str(origin.id), str(truck.id), str(driver_id), event_s)
        if not simulation.issues:
            return simulation, first or simulation
        first = first or simulation
    return None, first


async def truck_breakdown(session: AsyncSession, payload: TruckBreakdownIn) -> EventResultOut:
    occurred = payload.occurred_at or utcnow()
    truck = await _truck(session, payload.replacement_truck_id)
    if payload.replacement_driver_id is not None:
        await _driver(session, payload.replacement_driver_id)

    located = await locate(session, payload.trip_id, reason="Panne de camion")
    plan, origin = located.plan, located.trip
    _ensure_replaceable(origin)
    if truck.id == origin.truck_id:
        raise ValidationAppError(
            "Le camion de remplacement doit être différent du camion en panne.",
            details=[{"field": "replacement_truck_id", "message": "Camion identique à celui de la tournée."}],
        )
    broken = await session.get(Truck, origin.truck_id)
    previous_driver_id = origin.driver_id

    ctx = await build_context(session, plan)
    event_s = event_seconds(ctx, occurred)
    candidates = await _driver_candidates(session, plan, origin, truck, payload.replacement_driver_id)
    if not candidates:
        raise RuleViolationError(
            "Aucun chauffeur pour la tournée de remplacement : indiquez un chauffeur remplaçant.",
            [
                {
                    "rule_code": "RM-01",
                    "message": f"Le camion {truck.plate} n'a pas de chauffeur affecté pour la journée "
                    "et la tournée d'origine n'en a pas non plus.",
                    "severity": Severity.BLOCKING.value,
                }
            ],
        )
    simulation, first = _pick_driver(ctx, origin, truck, candidates, event_s)
    if simulation is None:
        truck_issues = first.of(TRUCK_CODES)
        raise _rule_error(
            f"Le camion {truck.plate} ne peut pas reprendre la tournée {origin.seq}."
            if truck_issues
            else "Aucun chauffeur affectable pour la tournée de remplacement.",
            first.issues,
        )

    # --- application sur la version de travail (RM-19) ---
    tz_name = ctx.problem.params.timezone
    target = simulation.target
    driver = await session.get(Driver, uuid.UUID(target.driver_id))
    pending = _pending(origin)
    kept = [s for s in origin.stops if s.status != StopStatus.PENDING]
    codes = await _station_codes(session, pending)
    transferred = [
        {
            "stop_id": str(s.id),
            "station_id": str(s.station_id),
            "station_code": codes.get(s.station_id),
            "planned_l": float(sum(d.planned_l for d in s.deliveries)),
        }
        for s in pending
    ]
    new_row = Trip(
        seq=target.seq,
        truck_id=truck.id,
        driver_id=driver.id,
        depot_id=origin.depot_id,
        planned_start_at=mapping.to_utc(plan.day, target.start_s, tz_name),
        planned_depart_at=mapping.to_utc(plan.day, target.depart_s, tz_name),
        planned_return_at=mapping.to_utc(plan.day, target.return_s, tz_name),
        distance_m=int(target.distance_m),
        duration_s=int(target.duration_s),
        status=TripStatus.PLANNED,
    )
    plan.trips.append(new_row)
    for index, stop in enumerate(pending, start=1):
        origin.stops.remove(stop)
        new_row.stops.append(stop)
        stop.seq = index
    for index, stop in enumerate(sorted(kept, key=lambda s: s.seq), start=1):
        stop.seq = index
    origin_seq, origin_id = origin.seq, origin.id
    kept_origin = origin_kept(bool(kept), TripStatus(origin.status), str(origin.id) in ctx.loaded)
    if kept_origin:
        # La tournée d'origine s'arrête là : ses arrêts réalisés et ses heures réelles sont conservés.
        origin.status = TripStatus.COMPLETED
    else:
        plan.trips.remove(origin)
    hm = format_local_hm(occurred, tz_name)
    await mark_unavailable(
        session,
        plan,
        truck_id=broken.id,
        reason=f"Panne déclarée à {hm} (tournée {origin_seq})"
        + (f" : {payload.reason.strip()}" if payload.reason and payload.reason.strip() else ""),
    )
    await session.flush()
    await planning_service.recheck_plan(session, plan.id)
    plan = await load_plan(session, plan.id)

    publish = will_publish(plan, payload.publish, located.created)
    transferred_l = sum(item["planned_l"] for item in transferred)
    summary = (
        f"Panne du camion {broken.plate} (tournée {origin_seq}) à {hm} : {len(pending)} arrêt(s) non "
        f"livré(s) transféré(s) sur le camion {truck.plate} (tournée {new_row.seq}, chauffeur "
        f"{driver.full_name}), à recharger au dépôt"
        + (
            f" ; {len(kept)} arrêt(s) déjà réalisé(s) conservé(s) sur la tournée d'origine. "
            if kept
            else ". "
        )
        + status_sentence(plan, publish)
    )
    event = log_event(
        session,
        plan,
        EventType.TRUCK_BREAKDOWN,
        {
            "action": "truck_breakdown",
            "summary": summary,
            "reason": payload.reason,
            "broken_truck_id": str(broken.id),
            "broken_truck_plate": broken.plate,
            "replacement_truck_id": str(truck.id),
            "replacement_truck_plate": truck.plate,
            "driver_id": str(driver.id),
            "driver_name": driver.full_name,
            "previous_driver_id": str(previous_driver_id) if previous_driver_id else None,
            "source_trip_id": str(located.source_trip_id),
            "origin_trip_id": str(origin_id) if kept_origin else None,
            "origin_trip_seq": origin_seq,
            "origin_trip_kept": kept_origin,
            "new_trip_id": str(new_row.id),
            "new_trip_seq": new_row.seq,
            "related_trip_ids": sorted({str(located.source_trip_id), str(origin_id), str(new_row.id)}),
            "transferred_stops": transferred,
            "transferred_l": transferred_l,
            "kept_stops": len(kept),
            "cargo": "reload_at_depot",
            "from_plan_id": str(located.previous.id) if located.previous else None,
            "from_version": located.previous.version if located.previous else None,
            "published": publish,
            "blocking_count": blocking_count(plan),
        },
        trip_id=new_row.id,
    )
    event.occurred_at = occurred
    await session.flush()

    result = await plan_result(
        session, plan.id, publish=publish, created=located.created, previous=located.previous
    )
    plan = await load_plan(session, plan.id)
    return EventResultOut(
        **result.model_dump(),
        event=(await journal.events_out(session, [event]))[0],
        source_trip_id=located.source_trip_id,
        origin_trip_id=origin_id if kept_origin else None,
        new_trip_id=new_row.id,
        trip_id=new_row.id,
        truck_id=truck.id,
        driver_id=driver.id,
        transferred_stop_ids=[uuid.UUID(item["stop_id"]) for item in transferred],
        kept_stop_ids=[s.id for s in kept],
        other_impacted_trips=_others(plan, {new_row.id, origin_id}, truck_id=broken.id),
    )


# --------------------------------------------------------------------------- chauffeur (F6.2)


async def driver_unavailable(session: AsyncSession, payload: DriverUnavailableIn) -> EventResultOut:
    occurred = payload.occurred_at or utcnow()
    driver = await _driver(session, payload.replacement_driver_id)

    located = await locate(session, payload.trip_id, reason="Chauffeur indisponible")
    plan, trip = located.plan, located.trip
    _ensure_replaceable(trip)
    if driver.id == trip.driver_id:
        raise ValidationAppError(
            "Le chauffeur remplaçant doit être différent du chauffeur indisponible.",
            details=[{"field": "replacement_driver_id", "message": "Chauffeur déjà affecté à la tournée."}],
        )
    previous_driver = await session.get(Driver, trip.driver_id) if trip.driver_id else None
    truck = await session.get(Truck, trip.truck_id)

    ctx = await build_context(session, plan)
    simulation = simulate_driver_change(ctx, str(trip.id), str(driver.id), event_seconds(ctx, occurred))
    if simulation.issues:
        raise _rule_error(
            f"Le chauffeur {driver.full_name} ne peut pas reprendre la tournée {trip.seq}.",
            simulation.issues,
        )

    tz_name = ctx.problem.params.timezone
    trip.driver_id = driver.id
    trip.planned_start_at = mapping.to_utc(plan.day, simulation.target.start_s, tz_name)
    hm = format_local_hm(occurred, tz_name)
    note = f" : {payload.reason.strip()}" if payload.reason and payload.reason.strip() else ""
    if previous_driver is not None:
        await mark_unavailable(
            session,
            plan,
            driver_id=previous_driver.id,
            reason=f"Indisponibilité déclarée à {hm} (tournée {trip.seq}){note}",
        )
    await session.flush()
    await planning_service.recheck_plan(session, plan.id)
    plan = await load_plan(session, plan.id)
    trip = next(t for t in plan.trips if t.id == trip.id)

    publish = will_publish(plan, payload.publish, located.created)
    pending = _pending(trip)
    done = [s for s in trip.stops if s.status != StopStatus.PENDING]
    former = previous_driver.full_name if previous_driver else "non affecté"
    summary = (
        f"Chauffeur {former} indisponible à {hm} : la tournée {trip.seq} (camion "
        f"{truck.plate if truck else '?'}) est reprise par {driver.full_name} pour {len(pending)} "
        f"arrêt(s) restant(s)" + (f" ; {len(done)} arrêt(s) déjà réalisé(s). " if done else ". ")
    ) + status_sentence(plan, publish)
    event = log_event(
        session,
        plan,
        EventType.DRIVER_UNAVAILABLE,
        {
            "action": "driver_unavailable",
            "summary": summary,
            "reason": payload.reason,
            "unavailable_driver_id": str(previous_driver.id) if previous_driver else None,
            "unavailable_driver_name": previous_driver.full_name if previous_driver else None,
            "replacement_driver_id": str(driver.id),
            "replacement_driver_name": driver.full_name,
            "truck_id": str(trip.truck_id),
            "truck_plate": truck.plate if truck else None,
            "source_trip_id": str(located.source_trip_id),
            "trip_seq": trip.seq,
            "related_trip_ids": sorted({str(located.source_trip_id), str(trip.id)}),
            "pending_stops": len(pending),
            "done_stops": len(done),
            "from_plan_id": str(located.previous.id) if located.previous else None,
            "from_version": located.previous.version if located.previous else None,
            "published": publish,
            "blocking_count": blocking_count(plan),
        },
        trip_id=trip.id,
    )
    event.occurred_at = occurred
    await session.flush()

    trip_id, truck_id = trip.id, trip.truck_id
    pending_ids, done_ids = [s.id for s in pending], [s.id for s in done]
    result = await plan_result(
        session, plan.id, publish=publish, created=located.created, previous=located.previous
    )
    plan = await load_plan(session, plan.id)
    return EventResultOut(
        **result.model_dump(),
        event=(await journal.events_out(session, [event]))[0],
        source_trip_id=located.source_trip_id,
        origin_trip_id=trip_id,
        new_trip_id=None,
        trip_id=trip_id,
        truck_id=truck_id,
        driver_id=driver.id,
        transferred_stop_ids=pending_ids,
        kept_stop_ids=done_ids,
        other_impacted_trips=(
            _others(plan, {trip_id}, driver_id=previous_driver.id) if previous_driver else []
        ),
    )


# --------------------------------------------------------------------------- assistant (écran 6)


def _reasons(issues: list[ViolationD]) -> list[ReasonOut]:
    seen: list[ReasonOut] = []
    for issue in issues:
        reason = ReasonOut(rule_code=issue.rule_code, message=issue.message)
        if reason not in seen:
            seen.append(reason)
    return seen


async def replacement_options(
    session: AsyncSession,
    trip_id: uuid.UUID,
    *,
    replacement_truck_id: uuid.UUID | None = None,
    occurred_at: datetime | None = None,
) -> ReplacementOptionsOut:
    """Camions et chauffeurs de remplacement possibles pour une tournée, chacun avec le motif
    (`rule_code`) s'il n'est pas éligible. Lecture seule : rien n'est créé ni modifié.

    Les chauffeurs sont évalués pour une reprise de la tournée telle quelle (F6.2), ou, si
    `replacement_truck_id` est donné, pour la tournée de remplacement de ce camion (F6.1)."""
    occurred = occurred_at or utcnow()
    located = await locate(session, trip_id)
    plan, trip = located.plan, located.trip
    if replacement_truck_id is not None:
        await _truck(session, replacement_truck_id)
        if replacement_truck_id == trip.truck_id:
            replacement_truck_id = None
    resources = await availability_service.load_day_resources(session, plan.day)
    driver_days = {d.driver.id: d for d in resources.drivers}
    current_truck = await session.get(Truck, trip.truck_id)
    current_driver = await session.get(Driver, trip.driver_id) if trip.driver_id else None
    depot = await session.get(Depot, trip.depot_id)
    pending = _pending(trip)
    codes = await _station_codes(session, pending)
    blocked = _blocked_reason(trip)
    brief = TripBriefOut(
        trip_id=trip.id,
        source_trip_id=trip_id,
        plan_id=plan.id,
        plan_version=plan.version,
        plan_status=plan.status,
        seq=trip.seq,
        status=trip.status,
        truck_id=trip.truck_id,
        truck_plate=current_truck.plate if current_truck else None,
        driver_id=trip.driver_id,
        driver_name=current_driver.full_name if current_driver else None,
        depot_id=trip.depot_id,
        depot_code=depot.code if depot else None,
        pending_stops=len(pending),
        delivered_stops=sum(1 for s in trip.stops if s.status == StopStatus.DELIVERED),
        skipped_stops=sum(1 for s in trip.stops if s.status == StopStatus.SKIPPED),
        pending_l=float(sum(d.planned_l for s in pending for d in s.deliveries)),
        pending_station_codes=[codes.get(s.station_id, "") for s in pending],
        can_replace_truck=blocked is None,
        can_replace_driver=blocked is None,
        blocked_reason=blocked,
    )
    target_truck_id = replacement_truck_id or trip.truck_id
    if blocked is not None:
        return ReplacementOptionsOut(
            trip=brief,
            occurred_at=occurred,
            drivers_evaluated_for_truck_id=target_truck_id,
            trucks=[],
            drivers=[],
        )

    ctx = await build_context(session, plan)
    event_s = event_seconds(ctx, occurred)
    ref = str(trip.id)
    seqs_by_truck: dict[uuid.UUID, list[int]] = {}
    seqs_by_driver: dict[uuid.UUID, list[int]] = {}
    for other in plan.trips:
        if other.id == trip.id or other.status == TripStatus.COMPLETED:
            continue
        seqs_by_truck.setdefault(other.truck_id, []).append(other.seq)
        if other.driver_id:
            seqs_by_driver.setdefault(other.driver_id, []).append(other.seq)

    trucks: list[TruckOptionOut] = []
    for item in resources.trucks:
        truck = item.truck
        if truck.id == trip.truck_id:
            continue
        option = TruckOptionOut(
            truck_id=truck.id,
            plate=truck.plate,
            size=truck.size,
            carrier_name=item.carrier_name,
            total_capacity_l=float(sum(c.capacity_l for c in truck.compartments)),
            assigned_driver_id=item.driver.id if item.driver else None,
            assigned_driver_name=item.driver.full_name if item.driver else None,
            other_trip_seqs=sorted(seqs_by_truck.get(truck.id, [])),
            eligible=False,
        )
        if item.block_reason:
            option.reasons = [ReasonOut(rule_code="RM-04", message=item.block_reason)]
        else:
            candidates = [d for d in (item.driver.id if item.driver else None, trip.driver_id) if d]
            candidates = list(dict.fromkeys(candidates))
            chosen, first = _pick_driver(ctx, trip, truck, candidates, event_s)
            if first is None:
                first = simulate_breakdown(ctx, ref, str(truck.id), None, event_s)
            truck_issues = first.of(TRUCK_CODES)
            option.eligible = not truck_issues
            option.reasons = _reasons(truck_issues)
            if chosen is not None:
                option.suggested_driver_id = uuid.UUID(chosen.target.driver_id)
                option.suggested_driver_name = driver_days[option.suggested_driver_id].driver.full_name
            option.driver_required = option.eligible and chosen is None
        trucks.append(option)
    trucks.sort(key=lambda t: (not t.eligible, t.driver_required, bool(t.other_trip_seqs), t.plate))

    drivers: list[DriverOptionOut] = []
    for item in resources.drivers:
        driver = item.driver
        is_current = driver.id == trip.driver_id
        option = DriverOptionOut(
            driver_id=driver.id,
            full_name=driver.full_name,
            phone=driver.phone,
            carrier_name=item.carrier_name,
            assigned_truck_id=item.truck.id if item.truck else None,
            assigned_truck_plate=item.truck.plate if item.truck else None,
            other_trip_seqs=sorted(seqs_by_driver.get(driver.id, [])),
            is_current=is_current,
            eligible=False,
        )
        if is_current and replacement_truck_id is None:
            option.reasons = [ReasonOut(message="Chauffeur actuel de la tournée.")]
        elif item.block_reason:
            option.reasons = [ReasonOut(rule_code="RM-03", message=item.block_reason)]
        else:
            if replacement_truck_id is None:
                simulation = simulate_driver_change(ctx, ref, str(driver.id), event_s)
            else:
                simulation = simulate_breakdown(ctx, ref, str(replacement_truck_id), str(driver.id), event_s)
            issues = simulation.of(DRIVER_CODES)
            option.eligible = not issues
            option.reasons = _reasons(issues)
        drivers.append(option)
    drivers.sort(key=lambda d: (not d.eligible, bool(d.other_trip_seqs), d.full_name))
    return ReplacementOptionsOut(
        trip=brief,
        occurred_at=occurred,
        drivers_evaluated_for_truck_id=target_truck_id,
        trucks=trucks,
        drivers=drivers,
    )
