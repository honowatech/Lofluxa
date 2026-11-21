"""Schémas de l'API comparaison / journée de référence / tableau de bord (conventions CONTRATS §7)."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, PlainSerializer

from app.core.enums import EventType, ImportStatus, PlanKind, PlanStatus, Severity, StopStatus, TripStatus

# Horodatage ISO 8601 en UTC, suffixe Z (RM-20).
UtcDatetime = Annotated[
    datetime,
    PlainSerializer(lambda v: v.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), return_type=str),
]


class _Out(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --------------------------------------------------------------------------- comparaison


class PlanSummaryOut(_Out):
    id: uuid.UUID
    day: date
    kind: PlanKind
    status: PlanStatus
    version: int
    label: str | None
    title: str
    approximate: bool
    parent_plan_id: uuid.UUID | None
    engine_version: str | None
    computed_at: UtcDatetime | None


class PlanMetricsOut(_Out):
    """Indicateurs d'un plan — définitions dans `app.comparison.metrics`."""

    distance_estimated_m: int
    distance_actual_m: int | None
    distance_actual_trips: int
    trucks_used: int
    drivers_used: int
    trips_count: int
    stations_requested: int
    stations_served: int
    stations_delivered: int | None
    orders_requested: int
    orders_served: int
    volume_requested_l: float
    volume_planned_l: float
    volume_delivered_l: float | None
    service_duration_s: int
    service_duration_actual_s: int | None
    fill_rate_avg_pct: float | None
    violations_blocking: int
    violations_warning: int
    violations_total: int
    prep_time_s: int | None
    prep_time_source: str | None


class MetricDeltaOut(_Out):
    key: str
    label: str
    unit: str  # m | s | l | pct | count
    a: float | None
    b: float | None
    delta: float | None  # B − A
    delta_pct: float | None  # (B − A) ÷ A × 100
    better: str | None  # a | b | equal


class VerdictOut(_Out):
    threshold_pct: float
    distance_a_m: int
    distance_b_m: int
    gain_m: int
    gain_pct: float | None
    success: bool | None
    gain_vs_actual_pct: float | None
    no_blocking_violation: bool
    orders_served_ok: bool
    message: str


class RoutePointOut(_Out):
    kind: str  # depot | station
    lat: float
    lon: float
    code: str
    name: str
    seq: int | None  # rang de l'arrêt dans la tournée (None pour le dépôt)
    station_id: uuid.UUID | None


class RouteDeliveryOut(_Out):
    order_id: uuid.UUID
    product_id: uuid.UUID
    product_code: str | None
    planned_l: float
    actual_l: float | None


class RouteStopOut(_Out):
    stop_id: uuid.UUID
    seq: int
    station_id: uuid.UUID
    station_code: str | None
    station_name: str | None
    status: StopStatus
    planned_arrival_at: UtcDatetime | None
    planned_departure_at: UtcDatetime | None
    actual_arrival_at: UtcDatetime | None
    actual_departure_at: UtcDatetime | None
    distance_from_prev_m: int
    deliveries: list[RouteDeliveryOut]


class TripRouteOut(_Out):
    trip_id: uuid.UUID
    seq: int
    color: str
    truck_id: uuid.UUID
    truck_plate: str | None
    driver_id: uuid.UUID | None
    driver_name: str | None
    depot_id: uuid.UUID
    depot_code: str | None
    status: TripStatus
    planned_depart_at: UtcDatetime | None
    planned_return_at: UtcDatetime | None
    actual_depart_at: UtcDatetime | None
    actual_return_at: UtcDatetime | None
    distance_m: int
    actual_distance_m: int | None
    duration_s: int
    volume_planned_l: float
    fill_rate_pct: float | None
    points: list[RoutePointOut]  # dépôt → arrêts dans l'ordre → dépôt
    stops: list[RouteStopOut]


class UnservedOut(_Out):
    order_id: uuid.UUID
    station_code: str | None
    station_name: str | None
    product_code: str | None
    requested_l: float | None
    reason_code: str
    reason_text: str | None


class ComparisonOut(_Out):
    plan_a: PlanSummaryOut
    plan_b: PlanSummaryOut
    metrics_a: PlanMetricsOut
    metrics_b: PlanMetricsOut
    deltas: list[MetricDeltaOut]
    verdict: VerdictOut
    routes_a: list[TripRouteOut]
    routes_b: list[TripRouteOut]
    unserved_a: list[UnservedOut]
    unserved_b: list[UnservedOut]


# --------------------------------------------------------------------------- journée de référence


class ImportIssueOut(_Out):
    sheet: str
    row: int | None
    column: str | None
    message: str


class ReferenceDayImportOut(_Out):
    batch_id: uuid.UUID
    status: ImportStatus  # applied | previewed (dry_run) | rejected
    plan_id: uuid.UUID | None
    day: date | None
    row_count: int
    error_count: int
    errors: list[ImportIssueOut]
    warnings: list[ImportIssueOut]
    summary: dict[str, Any]


class ReplayOut(_Out):
    task_id: str


# --------------------------------------------------------------------------- tableau de bord


class DashboardSummaryOut(_Out):
    trips_total: int
    trips_by_status: dict[str, int]
    stops_total: int
    stops_delivered: int
    stops_skipped: int
    stops_pending: int
    volume_planned_l: float
    volume_delivered_l: float
    trips_late: int
    max_delay_s: int
    alerts_blocking: int
    alerts_total: int


class DashboardTripOut(_Out):
    trip_id: uuid.UUID
    seq: int
    truck_plate: str | None
    driver_name: str | None
    depot_code: str | None
    status: TripStatus
    stops_total: int
    stops_delivered: int
    stops_skipped: int
    stops_pending: int
    volume_planned_l: float
    volume_delivered_l: float
    planned_depart_at: UtcDatetime | None
    planned_return_at: UtcDatetime | None
    actual_depart_at: UtcDatetime | None
    actual_return_at: UtcDatetime | None
    delay_s: int | None  # heure réelle − heure prévue du dernier fait connu ; positif = en retard
    next_station_code: str | None
    next_station_name: str | None
    next_planned_arrival_at: UtcDatetime | None
    next_estimated_arrival_at: UtcDatetime | None


class DashboardDelayOut(_Out):
    trip_id: uuid.UUID
    trip_seq: int
    truck_plate: str | None
    stop_id: uuid.UUID
    stop_seq: int
    station_code: str | None
    station_name: str | None
    planned_at: UtcDatetime
    actual_at: UtcDatetime
    delay_s: int


class DashboardAlertOut(_Out):
    source: str  # plan (version en attente, toujours en tête) | violation | event
    severity: Severity
    code: str  # RM-xx, type d'événement, ou `pending_draft`
    message: str
    trip_id: uuid.UUID | None
    trip_seq: int | None
    event_id: uuid.UUID | None
    event_type: EventType | None
    occurred_at: UtcDatetime | None
    payload: dict[str, Any] | None


class PendingDraftOut(_Out):
    """Version brouillon en attente de publication dans la lignée du plan publié du jour."""

    plan_id: uuid.UUID
    version: int
    created_at: UtcDatetime
    created_by_name: str | None
    blocking_count: int
    warning_count: int
    reason: str | None  # résumé de l'événement ou de la modification qui a créé cette version
    message: str  # phrase prête à afficher (c'est aussi le message de l'alerte)


class DashboardOut(_Out):
    day: date
    generated_at: UtcDatetime
    plan: PlanSummaryOut | None  # plan publié du jour, None s'il n'y en a pas
    pending_draft: PendingDraftOut | None  # None le plus souvent
    summary: DashboardSummaryOut
    trips: list[DashboardTripOut]
    delays: list[DashboardDelayOut]
    alerts: list[DashboardAlertOut]
