"""Schémas de l'API des plans (lot L5). Conventions : docs/CONTRATS.md §7.

Volumes en litres (`float`), distances en mètres, durées en secondes, horodatages ISO 8601 UTC,
positions en `lat` / `lon`. Chaque ressource porte les libellés utiles à l'affichage.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from app.core.enums import (
    OrderPriority,
    OrderStatus,
    PlanKind,
    PlanStatus,
    Severity,
    StopStatus,
    TripStatus,
    TruckSize,
    UnservedReason,
)

# RM-20 : tout horodatage sort en UTC (`…Z`).
UtcDatetime = Annotated[datetime, AfterValidator(lambda value: value.astimezone(UTC))]

# --------------------------------------------------------------------------- entrées


class ComputeIn(BaseModel):
    day: date
    params: dict[str, Any] | None = Field(
        default=None, description="Surcharge ponctuelle de paramètres du moteur (clés de `settings`)."
    )


class RecomputeIn(BaseModel):
    params: dict[str, Any] | None = None


class MoveStopIn(BaseModel):
    stop_id: uuid.UUID
    to_trip_id: uuid.UUID
    to_seq: int = Field(ge=1, description="Position dans la tournée d'arrivée, à partir de 1.")


class ReorderIn(BaseModel):
    stop_ids: list[uuid.UUID] = Field(min_length=1)


class AssignIn(BaseModel):
    """Champs absents = inchangés. `driver_id: null` retire le chauffeur de la tournée."""

    truck_id: uuid.UUID | None = None
    driver_id: uuid.UUID | None = None


# --------------------------------------------------------------------------- tâches


class TaskAccepted(BaseModel):
    task_id: str


class TaskOut(BaseModel):
    task_id: str
    state: Literal["pending", "running", "succeeded", "failed"]
    progress: int = Field(description="Avancement de 0 à 100.")
    message: str | None = None
    plan_id: uuid.UUID | None = None
    error: str | None = None


# --------------------------------------------------------------------------- plan complet


class DeliveryOut(BaseModel):
    id: uuid.UUID
    order_id: uuid.UUID
    product_id: uuid.UUID
    product_code: str | None = None
    product_label: str | None = None
    product_color: str | None = None
    planned_l: float
    actual_l: float | None = None
    requested_l: float | None = Field(default=None, description="Volume demandé par la commande.")
    priority: OrderPriority | None = None
    order_status: OrderStatus | None = None


class StopOut(BaseModel):
    id: uuid.UUID
    seq: int
    station_id: uuid.UUID
    station_code: str | None = None
    station_name: str | None = None
    station_city: str | None = None
    contact_name: str | None = None
    contact_phone: str | None = None
    lat: float | None = None
    lon: float | None = None
    planned_arrival_at: UtcDatetime | None = None
    planned_departure_at: UtcDatetime | None = None
    distance_from_prev_m: int
    status: StopStatus
    actual_arrival_at: UtcDatetime | None = None
    actual_departure_at: UtcDatetime | None = None
    skip_reason: str | None = None
    planned_l: float
    deliveries: list[DeliveryOut]


class LoadOut(BaseModel):
    """Un compartiment chargé (plan de chargement de la tournée)."""

    id: uuid.UUID
    compartment_id: uuid.UUID
    compartment_position: int | None = None
    capacity_l: float | None = None
    product_id: uuid.UUID
    product_code: str | None = None
    product_label: str | None = None
    product_color: str | None = None
    planned_l: float


class TripCompartmentOut(BaseModel):
    """Un compartiment du camion de la tournée, chargé ou vide (`planned_l = 0`, `product_id = null`)."""

    compartment_id: uuid.UUID
    compartment_position: int
    capacity_l: float
    product_id: uuid.UUID | None = None
    product_code: str | None = None
    product_label: str | None = None
    product_color: str | None = None
    planned_l: float


class TripOut(BaseModel):
    id: uuid.UUID
    seq: int
    truck_id: uuid.UUID
    truck_plate: str | None = None
    truck_size: TruckSize | None = None
    truck_capacity_l: float | None = None
    driver_id: uuid.UUID | None = None
    driver_name: str | None = None
    driver_phone: str | None = None
    depot_id: uuid.UUID
    depot_code: str | None = None
    depot_name: str | None = None
    depot_lat: float | None = None
    depot_lon: float | None = None
    planned_start_at: UtcDatetime | None = None
    planned_depart_at: UtcDatetime | None = None
    planned_return_at: UtcDatetime | None = None
    distance_m: int
    duration_s: int
    locked: bool
    status: TripStatus
    actual_depart_at: UtcDatetime | None = None
    actual_return_at: UtcDatetime | None = None
    actual_distance_m: int | None = None
    planned_l: float
    fill_rate: float | None = Field(default=None, description="Taux de remplissage, de 0 à 1.")
    blocking_count: int = 0
    warning_count: int = 0
    stops: list[StopOut]
    loads: list[LoadOut]
    compartments: list[TripCompartmentOut] = Field(
        default_factory=list,
        description="Tous les compartiments du camion, vides compris, dans l'ordre des positions.",
    )


class UnservedOut(BaseModel):
    id: uuid.UUID
    order_id: uuid.UUID
    reason_code: UnservedReason
    reason_text: str | None = None
    station_id: uuid.UUID | None = None
    station_code: str | None = None
    station_name: str | None = None
    lat: float | None = None
    lon: float | None = None
    product_id: uuid.UUID | None = None
    product_code: str | None = None
    product_label: str | None = None
    requested_l: float | None = None
    priority: OrderPriority | None = None
    order_status: OrderStatus | None = Field(
        default=None,
        description="`postponed` = reportée explicitement : ne bloque plus la publication (RM-15).",
    )


class ViolationOut(BaseModel):
    id: uuid.UUID
    rule_code: str
    severity: Severity
    message: str
    trip_id: uuid.UUID | None = None
    trip_seq: int | None = None
    stop_id: uuid.UUID | None = None
    stop_seq: int | None = None


class PlanAggregatesOut(BaseModel):
    """Métriques agrégées d'un plan, recalculées à chaque modification. Mêmes clés dans la liste
    (`GET /plans`) et dans le plan complet. D'autres clés peuvent s'y ajouter (métriques du moteur
    au calcul, `comparison` pour une journée de référence)."""

    model_config = ConfigDict(extra="allow")

    total_distance_m: int = 0
    total_duration_s: int = 0
    trips_count: int = 0
    trucks_count: int = 0
    drivers_count: int = 0
    stops_count: int = 0
    stations_served: int = 0
    orders_total: int = 0
    orders_served: int = 0
    orders_partial: int = 0
    orders_unserved: int = 0
    requested_l: float = 0
    planned_l: float = 0
    avg_fill_rate: float | None = None
    blocking_count: int = 0
    warning_count: int = 0


class PlanSummaryOut(BaseModel):
    id: uuid.UUID
    day: date
    kind: PlanKind
    status: PlanStatus
    version: int
    root_plan_id: uuid.UUID | None = None
    parent_plan_id: uuid.UUID | None = None
    label: str | None = None
    approximate: bool
    engine_version: str | None = None
    computed_at: UtcDatetime | None = None
    computed_in_ms: int | None = None
    prep_time_s: int | None = None
    metrics: PlanAggregatesOut | None = None
    blocking_count: int = 0
    warning_count: int = 0
    publishable: bool = Field(description="Brouillon calculé sans violation bloquante.")
    created_at: UtcDatetime
    updated_at: UtcDatetime
    created_by: uuid.UUID | None = None
    created_by_name: str | None = None


class LastEditOut(BaseModel):
    """Ce que la modification qui vient d'être faite a changé (résumé journalisé dans `events`)."""

    action: str
    summary: str


class PlanOut(PlanSummaryOut):
    last_edit: LastEditOut | None = Field(
        default=None, description="Présent seulement dans la réponse d'une modification manuelle."
    )
    params_snapshot: dict[str, Any] | None = None
    solver_log: dict[str, Any] | None = None
    trips: list[TripOut]
    unserved: list[UnservedOut]
    violations: list[ViolationOut]


# --------------------------------------------------------------------------- versions


class VersionChangeOut(BaseModel):
    """Une ligne de l'historique : qui a changé quoi, quand."""

    id: uuid.UUID
    type: str
    action: str | None = None
    summary: str | None = None
    occurred_at: UtcDatetime
    actor_id: uuid.UUID | None = None
    actor_name: str | None = None
    trip_id: uuid.UUID | None = None
    payload: dict[str, Any]


class VersionOut(BaseModel):
    plan_id: uuid.UUID
    version: int
    status: PlanStatus
    parent_plan_id: uuid.UUID | None = None
    is_current: bool = Field(description="Version de référence : la version publiée, à défaut le brouillon.")
    reason: str | None = None
    created_at: UtcDatetime
    created_by: uuid.UUID | None = None
    created_by_name: str | None = None
    published_at: UtcDatetime | None = None
    published_by_name: str | None = None
    metrics: dict[str, Any] | None = None
    changes: list[VersionChangeOut]
