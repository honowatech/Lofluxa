"""Chargement au dépôt et livraisons (F7) : logique métier.

- Enregistrement du chargement réel (F7.1), conversion à 15 °C (RM-12) et écart au planifié (RM-13).
- Machine à états des tournées et des arrêts (F7.4), répercussion sur les commandes.
- Ces opérations ne valent que sur un plan `published`. Elles n'altèrent pas le plan lui-même
  (pas de nouvelle version RM-18) : ce sont des réalisations, pas des modifications du plan.
"""

import uuid
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.deps import Page, PageParams
from app.core.enums import EventType, OrderStatus, PlanStatus, Severity, StopStatus, TripStatus
from app.core.errors import ConflictError, NotFoundError, ValidationAppError
from app.core.settings_store import get_setting
from app.core.time import to_local, utcnow
from app.events.models import Event
from app.loading.conversion import ASTM_NOTE, to_decimal, volume_at_15
from app.loading.deviation import RULE_CODE, Gap, Rm13Result, evaluate_rm_13
from app.loading.models import Loading, LoadingLine
from app.loading.schemas import (
    LoadingIn,
    LoadingLineOut,
    LoadingOut,
    LoadingSummaryOut,
    StopDeliveryIn,
    StopDeliveryLineOut,
    StopOut,
    TripLoadingOut,
    TripStatusIn,
)
from app.orders.models import Order
from app.planning.models import ConstraintViolation, Plan, Stop, Trip
from app.referentials.models import Depot, Driver, Product, Station, Truck, TruckCompartment
from app.users.models import User

# Machine à états des tournées (F7.4) : uniquement un pas en avant.
TRIP_FLOW: tuple[TripStatus, ...] = (
    TripStatus.PLANNED,
    TripStatus.AT_DEPOT,
    TripStatus.LOADED,
    TripStatus.IN_PROGRESS,
    TripStatus.COMPLETED,
)
# Le chargement se saisit (ou se corrige) tant que le camion n'a pas quitté le dépôt.
LOADING_EDITABLE = (TripStatus.PLANNED, TripStatus.AT_DEPOT, TripStatus.LOADED)

TRIP_STATUS_LABELS = {
    TripStatus.PLANNED: "planifiée",
    TripStatus.AT_DEPOT: "au dépôt",
    TripStatus.LOADED: "chargée",
    TripStatus.IN_PROGRESS: "en cours",
    TripStatus.COMPLETED: "terminée",
}


@dataclass
class TripContext:
    """Une tournée et tout ce qu'il faut pour la contrôler, l'afficher ou l'imprimer."""

    trip: Trip
    plan: Plan
    truck: Truck | None
    driver: Driver | None
    depot: Depot | None
    compartments: dict[uuid.UUID, TruckCompartment]
    products: dict[uuid.UUID, Product]
    stations: dict[uuid.UUID, Station]
    loading: Loading | None
    tolerance_pct: Decimal

    @property
    def planned_by_compartment(self) -> dict[uuid.UUID, Decimal]:
        planned: dict[uuid.UUID, Decimal] = {}
        for load in self.trip.compartment_loads:
            planned[load.compartment_id] = planned.get(load.compartment_id, Decimal(0)) + load.planned_l
        return planned

    @property
    def planned_product_by_compartment(self) -> dict[uuid.UUID, uuid.UUID]:
        return {load.compartment_id: load.product_id for load in self.trip.compartment_loads}

    def compartment_label(self, compartment_id: uuid.UUID) -> str:
        compartment = self.compartments.get(compartment_id)
        return str(compartment.position) if compartment else str(compartment_id)

    def rm_13(self) -> Rm13Result:
        """RM-13 sur le chargement enregistré (tolérance : paramètre `loading_tolerance_pct`)."""
        loaded: dict[uuid.UUID, Decimal] = {}
        for line in self.loading.lines if self.loading else []:
            loaded[line.compartment_id] = loaded.get(line.compartment_id, Decimal(0)) + line.volume_15_l
        planned = self.planned_by_compartment
        labels = {key: self.compartment_label(key) for key in {*planned, *loaded}}
        return evaluate_rm_13(planned, loaded, self.tolerance_pct, labels)

    @property
    def all_stops_done(self) -> bool:
        return all(stop.status != StopStatus.PENDING for stop in self.trip.stops)


# ── Lecture ───────────────────────────────────────────────────────────────────


async def _tolerance(session: AsyncSession) -> Decimal:
    return to_decimal(await get_setting(session, "loading_tolerance_pct"))


async def load_trip_context(session: AsyncSession, trip_id: uuid.UUID, *, lock: bool = False) -> TripContext:
    stmt = (
        select(Trip)
        .where(Trip.id == trip_id)
        .options(
            selectinload(Trip.plan),
            selectinload(Trip.stops).selectinload(Stop.deliveries),
            selectinload(Trip.compartment_loads),
        )
    )
    if lock:
        # Sérialise les écritures concurrentes sur une même tournée (un seul chargement par tournée).
        stmt = stmt.with_for_update(of=Trip)
    trip = (await session.execute(stmt)).scalar_one_or_none()
    if trip is None:
        raise NotFoundError("Tournée introuvable.")
    compartments = (
        (await session.execute(select(TruckCompartment).where(TruckCompartment.truck_id == trip.truck_id)))
        .scalars()
        .all()
    )
    products = (await session.execute(select(Product))).scalars().all()
    station_ids = {stop.station_id for stop in trip.stops}
    stations = (
        (await session.execute(select(Station).where(Station.id.in_(station_ids)))).scalars().all()
        if station_ids
        else []
    )
    loading = (await session.execute(select(Loading).where(Loading.trip_id == trip.id))).scalar_one_or_none()
    return TripContext(
        trip=trip,
        plan=trip.plan,
        truck=await session.get(Truck, trip.truck_id),
        driver=await session.get(Driver, trip.driver_id) if trip.driver_id else None,
        depot=await session.get(Depot, trip.depot_id),
        compartments={c.id: c for c in compartments},
        products={p.id: p for p in products},
        stations={s.id: s for s in stations},
        loading=loading,
        tolerance_pct=await _tolerance(session),
    )


async def load_stop_context(
    session: AsyncSession, stop_id: uuid.UUID, *, lock: bool = False
) -> tuple[TripContext, Stop]:
    trip_id = (await session.execute(select(Stop.trip_id).where(Stop.id == stop_id))).scalar_one_or_none()
    if trip_id is None:
        raise NotFoundError("Arrêt introuvable.")
    ctx = await load_trip_context(session, trip_id, lock=lock)
    stop = next(s for s in ctx.trip.stops if s.id == stop_id)
    return ctx, stop


def ensure_published(plan: Plan) -> None:
    if plan.status != PlanStatus.PUBLISHED:
        raise ConflictError(
            "Cette opération n'est possible que sur un plan publié.",
            code="plan_not_published",
            details=[{"plan_id": str(plan.id), "plan_status": plan.status.value}],
        )


# ── Sorties ───────────────────────────────────────────────────────────────────


def _f(value: Decimal | None) -> float | None:
    return None if value is None else float(value)


def _line_out(ctx: TripContext, line: LoadingLine, gap: Gap | None) -> LoadingLineOut:
    compartment = ctx.compartments.get(line.compartment_id)
    product = ctx.products.get(line.product_id)
    return LoadingLineOut(
        id=line.id,
        compartment_id=line.compartment_id,
        compartment_position=compartment.position if compartment else None,
        product_id=line.product_id,
        product_code=product.code if product else None,
        product_label=product.label if product else None,
        observed_l=float(line.observed_l),
        observed_temp_c=float(line.observed_temp_c),
        observed_density=_f(line.observed_density),
        volume_15_l=float(line.volume_15_l),
        planned_l=_f(line.planned_l),
        gap_l=_f(gap.gap_l) if gap else None,
        gap_pct=_f(gap.gap_pct) if gap else None,
        out_of_tolerance=bool(gap and gap.out_of_tolerance),
    )


def _sorted_lines(ctx: TripContext) -> list[LoadingLine]:
    def position(line: LoadingLine) -> int:
        compartment = ctx.compartments.get(line.compartment_id)
        return compartment.position if compartment else 0

    return sorted(ctx.loading.lines, key=position) if ctx.loading else []


async def loading_out(session: AsyncSession, ctx: TripContext) -> LoadingOut:
    loading = ctx.loading
    assert loading is not None
    result = ctx.rm_13()
    author = await session.get(User, loading.entered_by) if loading.entered_by else None
    lines = _sorted_lines(ctx)
    return LoadingOut(
        id=loading.id,
        trip_id=loading.trip_id,
        depot_id=loading.depot_id,
        depot_code=ctx.depot.code if ctx.depot else None,
        arrived_at=loading.arrived_at,
        started_at=loading.started_at,
        finished_at=loading.finished_at,
        depot_ticket_no=loading.depot_ticket_no,
        entered_by=loading.entered_by,
        entered_by_name=author.full_name if author else None,
        lines=[_line_out(ctx, line, result.by_compartment.get(line.compartment_id)) for line in lines],
        observed_total_l=float(sum((line.observed_l for line in lines), Decimal(0))),
        volume_15_total_l=float(result.total.loaded_15_l),
        planned_total_l=float(result.total.planned_l),
        gap_l=float(result.total.gap_l),
        gap_pct=_f(result.total.gap_pct),
        tolerance_pct=float(result.tolerance_pct),
        out_of_tolerance=result.warning,
        warning_message=result.message,
        conversion_note=ASTM_NOTE,
    )


def trip_out(ctx: TripContext) -> TripLoadingOut:
    trip = ctx.trip
    summary = None
    if ctx.loading is not None:
        result = ctx.rm_13()
        summary = LoadingSummaryOut(
            id=ctx.loading.id,
            arrived_at=ctx.loading.arrived_at,
            started_at=ctx.loading.started_at,
            finished_at=ctx.loading.finished_at,
            depot_ticket_no=ctx.loading.depot_ticket_no,
            observed_total_l=float(sum((line.observed_l for line in ctx.loading.lines), Decimal(0))),
            volume_15_total_l=float(result.total.loaded_15_l),
            gap_l=float(result.total.gap_l),
            gap_pct=_f(result.total.gap_pct),
            out_of_tolerance=result.warning,
        )
    return TripLoadingOut(
        id=trip.id,
        plan_id=trip.plan_id,
        day=ctx.plan.day.isoformat(),
        seq=trip.seq,
        status=trip.status,
        truck_id=trip.truck_id,
        truck_plate=ctx.truck.plate if ctx.truck else None,
        driver_id=trip.driver_id,
        driver_name=ctx.driver.full_name if ctx.driver else None,
        depot_id=trip.depot_id,
        depot_code=ctx.depot.code if ctx.depot else None,
        depot_name=ctx.depot.name if ctx.depot else None,
        planned_start_at=trip.planned_start_at,
        planned_depart_at=trip.planned_depart_at,
        planned_return_at=trip.planned_return_at,
        actual_depart_at=trip.actual_depart_at,
        actual_return_at=trip.actual_return_at,
        distance_m=trip.distance_m,
        actual_distance_m=trip.actual_distance_m,
        planned_total_l=float(sum(ctx.planned_by_compartment.values(), Decimal(0))),
        stop_count=len(trip.stops),
        stops_done=sum(1 for stop in trip.stops if stop.status != StopStatus.PENDING),
        loading_recorded=ctx.loading is not None,
        loading=summary,
    )


async def stop_out(session: AsyncSession, ctx: TripContext, stop: Stop) -> StopOut:
    station = ctx.stations.get(stop.station_id)
    order_ids = {d.order_id for d in stop.deliveries}
    orders = await _orders_by_id(session, order_ids)
    return StopOut(
        id=stop.id,
        trip_id=stop.trip_id,
        trip_status=ctx.trip.status,
        seq=stop.seq,
        station_id=stop.station_id,
        station_code=station.code if station else None,
        station_name=station.name if station else None,
        status=stop.status,
        planned_arrival_at=stop.planned_arrival_at,
        planned_departure_at=stop.planned_departure_at,
        actual_arrival_at=stop.actual_arrival_at,
        actual_departure_at=stop.actual_departure_at,
        skip_reason=stop.skip_reason,
        deliveries=[
            StopDeliveryLineOut(
                id=d.id,
                order_id=d.order_id,
                order_status=orders[d.order_id].status.value if d.order_id in orders else None,
                product_id=d.product_id,
                product_code=ctx.products[d.product_id].code if d.product_id in ctx.products else None,
                planned_l=float(d.planned_l),
                actual_l=_f(d.actual_l),
            )
            for d in stop.deliveries
        ],
        trip_all_stops_done=ctx.all_stops_done,
    )


# ── Enregistrement du chargement (F7.1, F7.2) ─────────────────────────────────


def _check_ordered(moments: list[tuple[str, datetime | None]]) -> None:
    """Les heures renseignées doivent être ordonnées : arrivée ≤ début ≤ fin."""
    given = [(label, moment) for label, moment in moments if moment is not None]
    for (label_a, a), (label_b, b) in zip(given, given[1:], strict=False):
        if b < a:
            raise ValidationAppError(
                f"Heures incohérentes : {label_b} ne peut pas précéder {label_a}.", code="invalid_times"
            )


def _check_lines(ctx: TripContext, payload: LoadingIn) -> None:
    planned_products = ctx.planned_product_by_compartment
    errors: list[dict] = []
    seen: set[uuid.UUID] = set()
    for index, line in enumerate(payload.lines):
        field = f"lines.{index}"
        if line.compartment_id in seen:
            errors.append({"field": field, "message": "Compartiment saisi deux fois."})
            continue
        seen.add(line.compartment_id)
        if line.compartment_id not in ctx.compartments:
            errors.append(
                {"field": field, "message": "Ce compartiment n'appartient pas au camion de la tournée."}
            )
            continue
        label = ctx.compartment_label(line.compartment_id)
        expected = planned_products.get(line.compartment_id)
        if expected is None:
            errors.append(
                {"field": field, "message": f"Le compartiment {label} n'est pas prévu au plan de chargement."}
            )
        elif expected != line.product_id:
            product = ctx.products.get(expected)
            errors.append(
                {
                    "field": field,
                    "message": f"Produit inattendu dans le compartiment {label} : "
                    f"le plan de chargement prévoit {product.label if product else expected}.",
                }
            )
    if errors:
        raise ValidationAppError(
            "Chargement incohérent avec la tournée.", code="invalid_loading", details=errors
        )


async def _sync_rm_13(session: AsyncSession, ctx: TripContext) -> Rm13Result:
    """Remplace l'avertissement RM-13 de la tournée selon le chargement courant."""
    existing = (
        (
            await session.execute(
                select(ConstraintViolation).where(
                    ConstraintViolation.trip_id == ctx.trip.id, ConstraintViolation.rule_code == RULE_CODE
                )
            )
        )
        .scalars()
        .all()
    )
    for violation in existing:
        await session.delete(violation)
    result = ctx.rm_13()
    if result.warning:
        session.add(
            ConstraintViolation(
                plan_id=ctx.plan.id,
                trip_id=ctx.trip.id,
                rule_code=RULE_CODE,
                severity=Severity.WARNING,
                message=result.message,
            )
        )
    return result


def _event(ctx: TripContext, event_type: EventType, payload: dict, user: User) -> Event:
    return Event(
        day=ctx.plan.day,
        plan_id=ctx.plan.id,
        trip_id=ctx.trip.id,
        type=event_type,
        payload=payload,
        occurred_at=utcnow(),
        actor_id=user.id,
    )


async def record_loading(
    session: AsyncSession, trip_id: uuid.UUID, payload: LoadingIn, user: User
) -> LoadingOut:
    """Crée le chargement de la tournée, ou le remplace s'il existe déjà (un seul par tournée)."""
    ctx = await load_trip_context(session, trip_id, lock=True)
    ensure_published(ctx.plan)
    if ctx.trip.status not in LOADING_EDITABLE:
        raise ConflictError(
            f"Le chargement n'est plus modifiable : la tournée est {TRIP_STATUS_LABELS[ctx.trip.status]}.",
            code="loading_locked",
        )
    _check_ordered(
        [
            ("l'arrivée au dépôt", payload.arrived_at),
            ("le début du chargement", payload.started_at),
            ("la fin du chargement", payload.finished_at),
        ]
    )
    _check_lines(ctx, payload)

    planned = ctx.planned_by_compartment
    lines = [
        LoadingLine(
            compartment_id=line.compartment_id,
            product_id=line.product_id,
            observed_l=to_decimal(line.observed_l),
            observed_temp_c=to_decimal(line.observed_temp_c),
            observed_density=to_decimal(line.observed_density) if line.observed_density is not None else None,
            # RM-12 : coefficient lu dans le référentiel produit.
            volume_15_l=volume_at_15(
                line.observed_l, line.observed_temp_c, ctx.products[line.product_id].thermal_coeff
            ),
            planned_l=planned.get(line.compartment_id),
        )
        for line in payload.lines
    ]
    updated = ctx.loading is not None
    if ctx.loading is None:
        ctx.loading = Loading(trip_id=ctx.trip.id, lines=[])
        session.add(ctx.loading)
    loading = ctx.loading
    loading.depot_id = ctx.trip.depot_id
    loading.arrived_at = payload.arrived_at
    loading.started_at = payload.started_at
    loading.finished_at = payload.finished_at
    loading.depot_ticket_no = payload.depot_ticket_no
    loading.entered_by = user.id
    loading.lines = lines  # les anciennes lignes sont supprimées (delete-orphan)
    await session.flush()

    result = await _sync_rm_13(session, ctx)
    session.add(
        _event(
            ctx,
            EventType.LOADING_RECORDED,
            {
                "loading_id": str(loading.id),
                "updated": updated,
                "depot_ticket_no": loading.depot_ticket_no,
                "volume_15_total_l": float(result.total.loaded_15_l),
                "planned_total_l": float(result.total.planned_l),
                "gap_pct": _f(result.total.gap_pct),
                "out_of_tolerance": result.warning,
            },
            user,
        )
    )
    await session.flush()
    return await loading_out(session, ctx)


# ── Statuts de tournée (F7.4) ─────────────────────────────────────────────────


async def _orders_by_id(session: AsyncSession, order_ids: set[uuid.UUID]) -> dict[uuid.UUID, Order]:
    if not order_ids:
        return {}
    rows = (await session.execute(select(Order).where(Order.id.in_(order_ids)))).scalars().all()
    return {order.id: order for order in rows}


async def change_trip_status(
    session: AsyncSession, trip_id: uuid.UUID, payload: TripStatusIn, user: User
) -> TripLoadingOut:
    ctx = await load_trip_context(session, trip_id, lock=True)
    ensure_published(ctx.plan)
    trip = ctx.trip
    current, target = trip.status, payload.status
    index = TRIP_FLOW.index(current)
    expected = TRIP_FLOW[index + 1] if index + 1 < len(TRIP_FLOW) else None
    if target != expected:
        allowed = (
            f"seule transition possible : « {expected.value} »" if expected else "la tournée est terminée"
        )
        raise ConflictError(
            f"Transition de statut interdite : « {current.value} » → « {target.value} » ({allowed}).",
            code="invalid_transition",
            details=[
                {"from": current.value, "to": target.value, "allowed": expected.value if expected else None}
            ],
        )
    if payload.actual_depart_at is not None and target not in (TripStatus.IN_PROGRESS, TripStatus.COMPLETED):
        raise ValidationAppError("L'heure réelle de départ se saisit au départ du dépôt (« in_progress »).")
    if (payload.actual_return_at is not None or payload.actual_distance_m is not None) and (
        target != TripStatus.COMPLETED
    ):
        raise ValidationAppError(
            "L'heure de retour et les kilomètres réels se saisissent à la clôture (« completed »)."
        )

    if target == TripStatus.LOADED:
        if ctx.loading is None:
            raise ConflictError(
                "Le chargement doit être enregistré avant de passer la tournée à « chargée ».",
                code="loading_missing",
            )
        order_ids = {d.order_id for stop in trip.stops for d in stop.deliveries}
        for order in (await _orders_by_id(session, order_ids)).values():
            if order.status == OrderStatus.PLANNED:
                order.status = OrderStatus.LOADED
    elif target == TripStatus.IN_PROGRESS:
        trip.actual_depart_at = payload.actual_depart_at or utcnow()
    elif target == TripStatus.COMPLETED:
        pending = [stop for stop in trip.stops if stop.status == StopStatus.PENDING]
        if pending:
            raise ConflictError(
                f"La tournée ne peut pas être terminée : {len(pending)} arrêt(s) ni livré(s) ni sauté(s).",
                code="stops_pending",
                details=[{"stop_id": str(stop.id), "seq": stop.seq} for stop in pending],
            )
        if payload.actual_depart_at is not None:
            trip.actual_depart_at = payload.actual_depart_at
        actual_return = payload.actual_return_at or utcnow()
        if trip.actual_depart_at is not None and actual_return < trip.actual_depart_at:
            raise ValidationAppError(
                "Heures incohérentes : le retour ne peut pas précéder le départ du dépôt.",
                code="invalid_times",
            )
        trip.actual_return_at = actual_return
        if payload.actual_distance_m is not None:
            trip.actual_distance_m = payload.actual_distance_m
    trip.status = target
    await session.flush()
    return trip_out(ctx)


# ── Livraisons (F7.4) ─────────────────────────────────────────────────────────


async def record_delivery(
    session: AsyncSession, stop_id: uuid.UUID, payload: StopDeliveryIn, user: User
) -> StopOut:
    ctx, stop = await load_stop_context(session, stop_id, lock=True)
    ensure_published(ctx.plan)
    if ctx.trip.status != TripStatus.IN_PROGRESS:
        raise ConflictError(
            "Une livraison se saisit sur une tournée en cours "
            f"(la tournée est {TRIP_STATUS_LABELS[ctx.trip.status]}).",
            code="trip_not_in_progress",
        )
    orders = await _orders_by_id(session, {d.order_id for d in stop.deliveries})

    if payload.skip_reason is not None:
        stop.status = StopStatus.SKIPPED
        stop.skip_reason = payload.skip_reason
        stop.actual_arrival_at = payload.actual_arrival_at
        stop.actual_departure_at = payload.actual_departure_at
        for delivery in stop.deliveries:
            delivery.actual_l = None
            order = orders.get(delivery.order_id)
            if order is not None and order.status == OrderStatus.DELIVERED:
                order.status = OrderStatus.LOADED  # correction d'une saisie précédente
    else:
        if payload.actual_arrival_at is None:
            raise ValidationAppError("L'heure réelle d'arrivée est obligatoire pour un arrêt livré.")
        given: dict[uuid.UUID, Decimal] = {}
        for line in payload.deliveries or []:
            if line.order_id in given:
                raise ValidationAppError("Une commande figure deux fois dans les volumes livrés.")
            given[line.order_id] = to_decimal(line.actual_l)
        expected_ids = {d.order_id for d in stop.deliveries}
        if set(given) != expected_ids:
            details = [
                {"order_id": str(oid), "message": "Volume livré manquant pour cette commande de l'arrêt."}
                for oid in expected_ids - set(given)
            ] + [
                {"order_id": str(oid), "message": "Cette commande n'est pas prévue à cet arrêt."}
                for oid in set(given) - expected_ids
            ]
            raise ValidationAppError(
                "Les volumes livrés doivent couvrir exactement les commandes de l'arrêt.",
                code="invalid_deliveries",
                details=details,
            )
        stop.status = StopStatus.DELIVERED
        stop.skip_reason = None
        stop.actual_arrival_at = payload.actual_arrival_at
        stop.actual_departure_at = payload.actual_departure_at
        assigned: set[uuid.UUID] = set()
        for delivery in stop.deliveries:
            # Une ligne par commande et par arrêt ; en cas de doublon, le volume va sur la première.
            delivery.actual_l = given[delivery.order_id] if delivery.order_id not in assigned else Decimal(0)
            assigned.add(delivery.order_id)
        for order_id, actual in given.items():
            order = orders.get(order_id)
            if order is None:
                continue
            if actual > 0 and order.status in (OrderStatus.PLANNED, OrderStatus.LOADED):
                order.status = OrderStatus.DELIVERED
            elif actual == 0 and order.status == OrderStatus.DELIVERED:
                order.status = OrderStatus.LOADED  # correction : rien n'a finalement été livré

    station = ctx.stations.get(stop.station_id)
    session.add(
        _event(
            ctx,
            EventType.DELIVERY_RECORDED,
            {
                "stop_id": str(stop.id),
                "seq": stop.seq,
                "station_code": station.code if station else None,
                "status": stop.status.value,
                "skip_reason": stop.skip_reason,
                "deliveries": [
                    {"order_id": str(d.order_id), "planned_l": float(d.planned_l), "actual_l": _f(d.actual_l)}
                    for d in stop.deliveries
                ],
            },
            user,
        )
    )
    await session.flush()
    return await stop_out(session, ctx, stop)


# ── Vue Fleet ─────────────────────────────────────────────────────────────────


async def today_local(session: AsyncSession) -> date:
    return to_local(utcnow(), await get_setting(session, "timezone")).date()


async def list_trip_loadings(
    session: AsyncSession, day: date, depot_id: uuid.UUID | None, page: PageParams
) -> Page[TripLoadingOut]:
    """Tournées des plans publiés du jour (éventuellement d'un dépôt), avec leur état de chargement."""
    conditions = [Plan.day == day, Plan.status == PlanStatus.PUBLISHED]
    if depot_id is not None:
        conditions.append(Trip.depot_id == depot_id)
    base = select(Trip.id).join(Plan, Plan.id == Trip.plan_id).where(*conditions)
    total = (await session.execute(select(func.count()).select_from(base.subquery()))).scalar_one()
    ids = (
        (
            await session.execute(
                base.order_by(Trip.planned_start_at.asc().nulls_last(), Trip.seq, Trip.id)
                .limit(page.limit)
                .offset(page.offset)
            )
        )
        .scalars()
        .all()
    )
    items = [trip_out(await load_trip_context(session, trip_id)) for trip_id in ids]
    return Page[TripLoadingOut](items=items, total=total, limit=page.limit, offset=page.offset)
