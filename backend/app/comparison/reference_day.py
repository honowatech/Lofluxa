"""Import d'une journée de référence (F8.1) : fichier Excel → plan `manual_reference`.

Le fichier est lu par `app.imports.reference_day` (seul endroit où l'on lit de l'Excel). Ici :
résolution des codes dans les référentiels, rapport ligne par ligne, création des commandes, du
plan, de ses tournées, arrêts et livraisons, puis estimation des kilomètres et des horaires sur la
même matrice que le moteur (`build_matrix` + `timing.schedule_trip`) et contrôle par les règles.

Conventions adoptées (voir docs/questions/l7-comparaison.md) :
- la journée a réellement eu lieu : tournées `completed`, arrêts `delivered`, volume réel = volume
  du fichier ; commandes livrées `delivered`, commandes non livrées `postponed` et listées dans
  `unserved_orders` ; le plan reste `draft` (il n'est jamais publié) ;
- le fichier ne donne pas les compartiments : le plan de chargement est réparti par
  `assign_compartments`, comme pour un plan calculé ;
- les heures prévues sont calculées par `schedule_trip` ; si l'heure réelle de départ du dépôt est
  connue, le calcul part de cette heure, sinon les tournées d'un même camion ou chauffeur s'enchaînent.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, time
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.comparison import service as comparison_service
from app.core.config import get_config
from app.core.db import new_id
from app.core.enums import (
    ImportKind,
    ImportStatus,
    OrderPriority,
    OrderSource,
    OrderStatus,
    PlanKind,
    PlanStatus,
    StopStatus,
    TripStatus,
    UnservedReason,
)
from app.core.errors import ConflictError
from app.core.settings_store import get_setting
from app.core.time import seconds_to_utc, utcnow
from app.imports import reference_day as reader
from app.imports.models import ImportBatch
from app.imports.reference_day import SHEET_DAY, SHEET_ORDERS, SHEET_TRIPS, ReferenceDayData, RowIssue
from app.orders.models import Order
from app.planning import checking as plan_checking
from app.planning import service as plan_service
from app.planning import timing
from app.planning.distance_cache import DbDistanceCache
from app.planning.domain import DeliveryD, PlanningProblem, StopD, TripD, UnservedD
from app.planning.engine import compartments, distance_matrix
from app.planning.models import (
    ConstraintViolation,
    Plan,
    Stop,
    StopDelivery,
    Trip,
    TripCompartmentLoad,
    UnservedOrder,
)
from app.planning.violations import rules
from app.referentials.models import Depot, Driver, Product, Station, Truck

UNSERVED_TEXT = "Commande non livrée lors de la journée de référence."
DAY_S = 24 * 3600


@dataclass(slots=True)
class ImportOutcome:
    batch: ImportBatch
    plan: Plan | None
    day: date | None
    errors: list[RowIssue]
    warnings: list[RowIssue]
    summary: dict[str, Any] = field(default_factory=dict)

    @property
    def status(self) -> ImportStatus:
        return self.batch.status


@dataclass(slots=True)
class Checked:
    """Journée lue et contrôlée, prête à être créée s'il n'y a aucune erreur."""

    data: ReferenceDayData
    day: date | None
    prep_time_min: float | None
    label: str | None
    refs: _Referentials
    drivers: dict[int, Driver | None]
    existing: list[Plan]  # journées de référence déjà présentes pour cette date
    summary: dict[str, Any]


@dataclass(slots=True)
class _Referentials:
    stations: dict[str, Station]
    products: dict[str, Product]
    trucks: dict[str, Truck]
    depots: dict[str, Depot]
    drivers_by_license: dict[str, Driver]
    drivers_by_name: dict[str, list[Driver]]


async def _load_referentials(session: AsyncSession) -> _Referentials:
    async def _all(model: Any) -> list[Any]:
        return list((await session.execute(select(model).where(model.deleted_at.is_(None)))).scalars().all())

    key = reader.normalize_key
    products: dict[str, Product] = {}
    for product in await _all(Product):
        products[key(product.code)] = product
        products.setdefault(key(product.label), product)
    drivers = await _all(Driver)
    by_name: dict[str, list[Driver]] = {}
    for driver in drivers:
        by_name.setdefault(key(driver.full_name), []).append(driver)
    return _Referentials(
        stations={key(s.code): s for s in await _all(Station)},
        products=products,
        trucks={key(t.plate): t for t in await _all(Truck)},
        depots={key(d.code): d for d in await _all(Depot)},
        drivers_by_license={key(d.license_no): d for d in drivers if d.license_no},
        drivers_by_name=by_name,
    )


def _resolve(data: ReferenceDayData, refs: _Referentials) -> dict[int, Driver | None]:
    """Contrôle les codes du fichier ; ajoute les erreurs à `data` ; renvoie le chauffeur par tournée."""
    key = reader.normalize_key
    errors = data.errors

    for order in data.orders:
        if order.row is None:
            continue  # commande déduite d'une livraison : contrôlée avec la tournée
        if key(order.station_code) not in refs.stations:
            errors.append(
                RowIssue(SHEET_ORDERS, order.row, "Code station", f"Station inconnue : {order.station_code}.")
            )
        if key(order.product_code) not in refs.products:
            errors.append(
                RowIssue(SHEET_ORDERS, order.row, "Produit", f"Produit inconnu : {order.product_code}.")
            )

    drivers: dict[int, Driver | None] = {}
    for index, trip in enumerate(data.trips):
        drivers[index] = None
        if key(trip.truck_plate) not in refs.trucks:
            errors.append(RowIssue(SHEET_TRIPS, trip.row, "Camion", f"Camion inconnu : {trip.truck_plate}."))
        if key(trip.depot_code) not in refs.depots:
            errors.append(RowIssue(SHEET_TRIPS, trip.row, "Dépôt", f"Dépôt inconnu : {trip.depot_code}."))
        if trip.driver:
            driver = refs.drivers_by_license.get(key(trip.driver))
            if driver is None:
                matches = refs.drivers_by_name.get(key(trip.driver), [])
                if len(matches) == 1:
                    driver = matches[0]
                elif len(matches) > 1:
                    errors.append(
                        RowIssue(
                            SHEET_TRIPS,
                            trip.row,
                            "Chauffeur",
                            f"Plusieurs chauffeurs s'appellent « {trip.driver} » : "
                            "saisir le numéro de permis.",
                        )
                    )
                else:
                    errors.append(
                        RowIssue(SHEET_TRIPS, trip.row, "Chauffeur", f"Chauffeur inconnu : {trip.driver}.")
                    )
            drivers[index] = driver
        for stop in trip.stops:
            if key(stop.station_code) not in refs.stations:
                errors.append(
                    RowIssue(
                        SHEET_TRIPS, stop.row, "Code station", f"Station inconnue : {stop.station_code}."
                    )
                )
            for delivery in stop.deliveries:
                if key(delivery.product_code) not in refs.products:
                    errors.append(
                        RowIssue(
                            SHEET_TRIPS,
                            delivery.row,
                            "Produit",
                            f"Produit inconnu : {delivery.product_code}.",
                        )
                    )
    return drivers


def _issue_sort(issue: RowIssue) -> tuple:
    order = {SHEET_DAY: 0, SHEET_ORDERS: 1, SHEET_TRIPS: 2}
    return (order.get(issue.sheet, -1), issue.row or 0)


async def _existing_references(session: AsyncSession, day: date) -> list[Plan]:
    return list(
        (
            await session.execute(
                select(Plan).where(
                    Plan.day == day,
                    Plan.kind == PlanKind.MANUAL_REFERENCE,
                    Plan.status != PlanStatus.ARCHIVED,
                )
            )
        )
        .scalars()
        .all()
    )


async def _archive_reference(session: AsyncSession, plan: Plan) -> None:
    """Remplacement : l'ancien plan de référence est archivé, ses commandes importées annulées."""
    bundle = await comparison_service.load_bundle(session, plan.id)
    for order in bundle.orders.values():
        if order.source == OrderSource.IMPORT and order.import_batch_id is not None:
            order.status = OrderStatus.CANCELLED
    plan.status = PlanStatus.ARCHIVED


def _to_time(value: str | None) -> time | None:
    if value is None:
        return None
    hours, minutes = value.split(":")
    return time(int(hours), int(minutes))


class _Clock:
    """Heures réelles du fichier (secondes locales) → UTC, en passant minuit si l'heure recule."""

    def __init__(self, day: date, tz_name: str) -> None:
        self.day = day
        self.tz_name = tz_name
        self.floor = 0

    def at(self, seconds: int | None) -> datetime | None:
        if seconds is None:
            return None
        while seconds < self.floor:
            seconds += DAY_S
        self.floor = seconds
        return seconds_to_utc(self.day, seconds, self.tz_name)


def summarize(data: ReferenceDayData) -> dict[str, Any]:
    return {
        "orders": len(data.orders),
        "trips": len(data.trips),
        "stops": sum(len(t.stops) for t in data.trips),
        "volume_delivered_l": round(
            sum(d.volume_l for t in data.trips for s in t.stops for d in s.deliveries), 2
        ),
        "trips_with_actual_km": sum(1 for t in data.trips if t.actual_km is not None),
    }


async def check_reference_day(
    session: AsyncSession,
    data: ReferenceDayData,
    *,
    day: date | None = None,
    prep_time_min: float | None = None,
    label: str | None = None,
) -> Checked:
    """Contrôle en lecture seule d'une journée lue par `read_reference_day` : résolution des codes
    dans les référentiels (erreurs ajoutées à `data.errors`), journée de référence déjà présente.

    `day`, `prep_time_min` et `label` priment sur les valeurs de la feuille « Journée »."""
    day = day or data.day
    if prep_time_min is None:
        prep_time_min = data.prep_time_min
    if day is None and not any(issue.sheet == SHEET_DAY for issue in data.errors) and data.trips:
        data.errors.append(RowIssue(SHEET_DAY, None, "Date", "Date de la journée obligatoire."))

    refs = await _load_referentials(session)
    drivers = _resolve(data, refs)
    data.errors.sort(key=_issue_sort)
    data.warnings.sort(key=_issue_sort)
    return Checked(
        data=data,
        day=day,
        prep_time_min=prep_time_min,
        label=label or data.label,
        refs=refs,
        drivers=drivers,
        existing=await _existing_references(session, day) if day else [],
        summary=summarize(data),
    )


def existing_conflict(checked: Checked) -> ConflictError:
    return ConflictError(
        f"Une journée de référence existe déjà pour le {checked.day:%d/%m/%Y}. "
        "Relancer l'import en demandant son remplacement.",
        code="reference_day_exists",
        details=[{"plan_id": str(plan.id)} for plan in checked.existing],
    )


async def import_reference_day(
    session: AsyncSession,
    *,
    content: bytes,
    filename: str,
    day: date | None = None,
    prep_time_min: float | None = None,
    label: str | None = None,
    dry_run: bool = False,
    replace: bool = False,
) -> ImportOutcome:
    """Import en une étape (`POST /reference-days/import`, spec §9) : lit, contrôle et, s'il n'y a
    aucune erreur, crée le plan `manual_reference`. Le lot `import_batches` a le même format que
    ceux du cycle prévisualiser / appliquer (`/imports/reference_day/preview`, `/imports/{id}/apply`),
    qui passe par les mêmes fonctions.

    `dry_run` : contrôle seul (lot `previewed`, rien n'est créé, applicable ensuite par
    `/imports/{batch_id}/apply`). `replace` : remplace la journée de référence déjà importée pour
    cette date (ancien plan archivé). En cas d'erreur dans le fichier : lot `rejected`, aucun plan.
    """
    data = reader.read_reference_day(content)
    checked = await check_reference_day(session, data, day=day, prep_time_min=prep_time_min, label=label)

    if checked.existing and not data.errors:
        if not replace and not dry_run:
            raise existing_conflict(checked)
        if not replace:
            data.warnings.append(
                RowIssue(
                    SHEET_DAY,
                    None,
                    "Date",
                    "Une journée de référence existe déjà pour cette date : l'import devra la remplacer.",
                )
            )

    if data.errors:
        status = ImportStatus.REJECTED
    elif dry_run:
        status = ImportStatus.PREVIEWED
    else:
        status = ImportStatus.APPLIED
    options = reader.report_options(checked.day, checked.prep_time_min, checked.label, replace)
    batch = ImportBatch(
        kind=ImportKind.REFERENCE_DAY,
        filename=filename[:255],
        status=status,
        row_count=data.row_count,
        error_count=len(data.errors),
        report=reader.build_report(data, options),
    )
    session.add(batch)
    await session.flush()
    outcome = ImportOutcome(
        batch=batch,
        plan=None,
        day=checked.day,
        errors=data.errors,
        warnings=data.warnings,
        summary=checked.summary,
    )
    if status != ImportStatus.APPLIED:
        return outcome

    outcome.plan = await create_reference_plan(session, checked, batch, replace=replace)
    batch.report = {
        **batch.report,
        "applied": {"plan_id": str(outcome.plan.id), **checked.summary, "applied_at": utcnow().isoformat()},
    }
    await session.flush()
    return outcome


async def create_reference_plan(
    session: AsyncSession, checked: Checked, batch: ImportBatch, *, replace: bool = False
) -> Plan:
    """Crée les commandes, le plan `manual_reference`, ses tournées, arrêts et livraisons à partir
    d'une journée contrôlée sans erreur, puis en estime les kilomètres, horaires et violations.

    Lève `ConflictError` si une journée de référence existe déjà pour la date et que `replace` est faux."""
    data, day, refs = checked.data, checked.day, checked.refs
    if data.errors or day is None:
        raise ConflictError(
            "Le fichier contient des erreurs : aucune donnée créée.", code="import_has_errors"
        )
    if checked.existing and not replace:
        raise existing_conflict(checked)
    for old in checked.existing:
        await _archive_reference(session, old)

    tz_name = str(await get_setting(session, "timezone"))
    key = reader.normalize_key

    # ----- commandes
    delivered_keys = {
        (key(stop.station_code), key(delivery.product_code))
        for trip in data.trips
        for stop in trip.stops
        for delivery in stop.deliveries
    }
    orders: dict[tuple[str, str], Order] = {}
    for ref_order in data.orders:
        order_key = (key(ref_order.station_code), key(ref_order.product_code))
        order = Order(
            day=day,
            station_id=refs.stations[order_key[0]].id,
            product_id=refs.products[order_key[1]].id,
            requested_l=Decimal(str(ref_order.requested_l)),
            priority=OrderPriority(ref_order.priority),
            window_start=_to_time(ref_order.window_start),
            window_end=_to_time(ref_order.window_end),
            comment=ref_order.comment,
            status=OrderStatus.DELIVERED if order_key in delivered_keys else OrderStatus.POSTPONED,
            source=OrderSource.IMPORT,
            import_batch_id=batch.id,
        )
        orders[order_key] = order
        session.add(order)
    await session.flush()

    # ----- plan, tournées, arrêts, livraisons
    plan_id = new_id()
    plan = Plan(
        id=plan_id,
        root_plan_id=plan_id,  # version 1 de sa propre lignée, comme un plan calculé
        day=day,
        kind=PlanKind.MANUAL_REFERENCE,
        status=PlanStatus.DRAFT,
        version=1,
        label=(checked.label or f"Journée de référence du {day:%d/%m/%Y}")[:160],
        prep_time_s=round(checked.prep_time_min * 60) if checked.prep_time_min is not None else None,
        # Collections initialisées : pas de chargement paresseux (interdit en session asynchrone).
        trips=[],
        unserved=[],
    )
    for seq, ref_trip in enumerate(data.trips, start=1):
        clock = _Clock(day, tz_name)
        driver = checked.drivers[seq - 1]
        trip = Trip(
            seq=seq,
            truck_id=refs.trucks[key(ref_trip.truck_plate)].id,
            driver_id=driver.id if driver else None,
            depot_id=refs.depots[key(ref_trip.depot_code)].id,
            status=TripStatus.COMPLETED,
            actual_depart_at=clock.at(ref_trip.depart_s),
            actual_distance_m=round(ref_trip.actual_km * 1000) if ref_trip.actual_km is not None else None,
        )
        for stop_seq, ref_stop in enumerate(ref_trip.stops, start=1):
            stop = Stop(
                seq=stop_seq,
                station_id=refs.stations[key(ref_stop.station_code)].id,
                status=StopStatus.DELIVERED,
                actual_arrival_at=clock.at(ref_stop.arrival_s),
                actual_departure_at=clock.at(ref_stop.departure_s),
            )
            for ref_delivery in ref_stop.deliveries:
                order = orders[(key(ref_stop.station_code), key(ref_delivery.product_code))]
                volume = Decimal(str(ref_delivery.volume_l))
                stop.deliveries.append(
                    StopDelivery(
                        order_id=order.id, product_id=order.product_id, planned_l=volume, actual_l=volume
                    )
                )
            trip.stops.append(stop)
        trip.actual_return_at = clock.at(ref_trip.return_s)
        plan.trips.append(trip)
    for order_key, order in orders.items():
        if order_key not in delivered_keys:
            plan.unserved.append(
                UnservedOrder(order_id=order.id, reason_code=UnservedReason.OTHER, reason_text=UNSERVED_TEXT)
            )
    session.add(plan)
    await session.flush()

    await estimate_plan(session, plan, [order.id for order in orders.values()], tz_name)

    # Métriques du plan : même forme que celles des plans calculés (lot L5), complétées par les
    # indicateurs du tableau comparatif sous la clé `comparison`.
    bundle = await comparison_service.load_bundle(session, plan.id)
    comparison = comparison_service.plan_metrics(bundle).to_dict()
    await plan_checking.refresh_metrics(
        session, await plan_checking.load_plan(session, plan.id), extra={"comparison": comparison}
    )
    checked.summary["orders_unserved"] = len(plan.unserved)
    await session.flush()
    return plan


async def estimate_plan(session: AsyncSession, plan: Plan, order_ids: list[uuid.UUID], tz_name: str) -> None:
    """Kilomètres estimés, horaires prévus et violations d'un plan saisi à la main, calculés comme
    pour un plan du moteur : même problème (`build_problem`), même matrice (`build_matrix`), mêmes
    horaires (`schedule_trip`), même répartition par compartiment (`assign_compartments`), mêmes
    règles (`check_plan`) — comparaison à armes égales."""
    problem: PlanningProblem = await plan_service.build_problem(
        session,
        plan.day,
        order_ids=order_ids,
        # Ressources de la journée passée, même désactivées ou supprimées depuis (lot L5).
        extra_depot_ids={t.depot_id for t in plan.trips},
        extra_truck_ids={t.truck_id for t in plan.trips},
        extra_driver_ids={t.driver_id for t in plan.trips if t.driver_id},
    )

    depots = {d.id: d for d in problem.depots}
    stations = {s.id: s for s in problem.stations}
    nodes: dict[str, tuple[str, float, float]] = {}
    missing: set[str] = set()
    for trip in plan.trips:
        for node_id, known in [(str(trip.depot_id), depots)] + [
            (str(s.station_id), stations) for s in trip.stops
        ]:
            node = known.get(node_id)
            if node is None:
                missing.add(node_id)
            else:
                nodes[node_id] = (node_id, node.lat, node.lon)
    if missing:
        raise ConflictError(
            "Journée de référence inexploitable : un dépôt ou une station de ses tournées est absent du "
            "problème du jour (dépôt désactivé ou supprimé ?).",
            code="reference_day_inconsistent",
            details=[{"node_id": node_id} for node_id in sorted(missing)],
        )

    # Même matrice que le moteur, avec le cache de distances en base (lot L5).
    cache = DbDistanceCache()
    await cache.preload(session, [distance_matrix.coord_hash(lat, lon) for _, lat, lon in nodes.values()])
    matrix = await asyncio.to_thread(
        distance_matrix.build_matrix,
        list(nodes.values()),
        problem.params,
        osrm_url=get_config().osrm_url or None,
        cache=cache,
    )
    await cache.flush(session)

    trips_d: list[TripD] = []
    last_return: dict[str, int] = {}
    for trip in sorted(plan.trips, key=lambda t: t.seq):
        trip_d = TripD(
            seq=trip.seq,
            truck_id=str(trip.truck_id),
            depot_id=str(trip.depot_id),
            driver_id=str(trip.driver_id) if trip.driver_id else None,
            ref=str(trip.id),
            stops=[
                StopD(
                    seq=stop.seq,
                    station_id=str(stop.station_id),
                    status=StopStatus.DELIVERED.value,
                    ref=str(stop.id),
                    deliveries=[
                        DeliveryD(str(d.order_id), str(d.product_id), float(d.planned_l))
                        for d in stop.deliveries
                    ],
                )
                for stop in sorted(trip.stops, key=lambda s: s.seq)
            ],
        )
        resources = [f"truck:{trip_d.truck_id}"] + (
            [f"driver:{trip_d.driver_id}"] if trip_d.driver_id else []
        )
        if trip.actual_depart_at is not None:
            # Départ réel connu : l'arrivée au dépôt est reculée du temps d'attente et de chargement.
            depot = depots[trip_d.depot_id]
            depart_s = int((trip.actual_depart_at - seconds_to_utc(plan.day, 0, tz_name)).total_seconds())
            start_s = max(0, depart_s - problem.depot_wait_s(depot) - problem.loading_s())
        else:
            start_s = max((last_return.get(r, 0) for r in resources), default=0)
        timing.schedule_trip(trip_d, problem, matrix, start_s=start_s)
        for resource in resources:
            last_return[resource] = max(last_return.get(resource, 0), trip_d.return_s)
        trips_d.append(trip_d)

        # Plan de chargement : le fichier ne donne pas les compartiments, on les répartit comme le
        # fait le moteur. Sans répartition possible, la tournée reste sans plan de chargement et
        # les règles le signalent (RM-05).
        loads = compartments.assign_compartments(
            problem.truck(trip_d.truck_id),
            trip_d.volumes_by_product(),
            problem.params.compartment_safety_margin_pct,
        )
        trip_d.loads = list(loads or [])
        for load in trip_d.loads:
            session.add(
                TripCompartmentLoad(
                    trip_id=trip.id,
                    compartment_id=uuid.UUID(load.compartment_id),
                    product_id=uuid.UUID(load.product_id),
                    planned_l=Decimal(str(round(load.planned_l, 2))),
                )
            )

        trip.planned_start_at = seconds_to_utc(plan.day, trip_d.start_s, tz_name)
        trip.planned_depart_at = seconds_to_utc(plan.day, trip_d.depart_s, tz_name)
        trip.planned_return_at = seconds_to_utc(plan.day, trip_d.return_s, tz_name)
        trip.distance_m = trip_d.distance_m
        trip.duration_s = trip_d.duration_s
        for stop, stop_d in zip(sorted(trip.stops, key=lambda s: s.seq), trip_d.stops, strict=True):
            stop.planned_arrival_at = seconds_to_utc(plan.day, stop_d.arrival_s, tz_name)
            stop.planned_departure_at = seconds_to_utc(plan.day, stop_d.departure_s, tz_name)
            stop.distance_from_prev_m = stop_d.distance_from_prev_m

    unserved_d = [UnservedD(str(u.order_id), u.reason_code, u.reason_text or "") for u in plan.unserved]
    violations = rules.check_plan(problem, trips_d, unserved_d, matrix)
    trips_by_seq = {trip.seq: trip for trip in plan.trips}
    for violation in violations:
        trip = trips_by_seq.get(violation.trip_seq) if violation.trip_seq is not None else None
        stop = None
        if trip is not None and violation.stop_seq is not None:
            stop = next((s for s in trip.stops if s.seq == violation.stop_seq), None)
        session.add(
            ConstraintViolation(
                plan_id=plan.id,
                trip_id=trip.id if trip else None,
                stop_id=stop.id if stop else None,
                rule_code=violation.rule_code,
                severity=violation.severity,
                message=violation.message,
            )
        )
    plan.approximate = bool(matrix.approximate)
    plan.params_snapshot = asdict(problem.params)
    await session.flush()
