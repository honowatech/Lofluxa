"""Schémas de l'API des événements du jour (F6, lot L10). Conventions : docs/CONTRATS.md §7."""

from __future__ import annotations

import uuid
from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.core.enums import EventType, PlanStatus, Severity, TripStatus, TruckSize
from app.planning.schemas import PlanOut, UtcDatetime

# --------------------------------------------------------------------------- entrées


class TruckBreakdownIn(BaseModel):
    trip_id: uuid.UUID
    replacement_truck_id: uuid.UUID
    replacement_driver_id: uuid.UUID | None = None
    # Ajouts à la spec §9 (facultatifs) :
    occurred_at: UtcDatetime | None = Field(None, description="Heure de la panne (défaut : maintenant).")
    reason: str | None = Field(None, max_length=500)
    publish: bool | None = Field(
        None,
        description="Publier la nouvelle version si elle n'a aucune violation bloquante. Par défaut : "
        "oui si cet appel a créé la version, non si un brouillon était déjà en préparation.",
    )


class DriverUnavailableIn(BaseModel):
    trip_id: uuid.UUID
    replacement_driver_id: uuid.UUID
    occurred_at: UtcDatetime | None = Field(None, description="Heure du constat (défaut : maintenant).")
    reason: str | None = Field(None, max_length=500)
    publish: bool | None = None


class ProductShortageIn(BaseModel):
    depot_id: uuid.UUID
    product_id: uuid.UUID
    new_available_l: float = Field(ge=0)
    day: date | None = Field(None, description="Jour J (défaut : aujourd'hui, heure locale).")
    comment: str | None = Field(None, max_length=500)


class DeliveryVolumeIn(BaseModel):
    order_id: uuid.UUID
    planned_l: float = Field(gt=0)


class ShortageResolutionIn(BaseModel):
    """Décision du dispatcher pour une tournée impactée par une pénurie (F6.3)."""

    trip_id: uuid.UUID
    action: Literal["reduce", "postpone", "change_depot"]
    deliveries: list[DeliveryVolumeIn] | None = Field(
        None, description="`reduce` : nouveaux volumes par commande (défaut : réduction proportionnelle)."
    )
    order_ids: list[uuid.UUID] | None = Field(
        None, description="`postpone` : commandes à reporter (défaut : toutes celles du produit)."
    )
    depot_id: uuid.UUID | None = Field(None, description="`change_depot` : nouveau dépôt de chargement.")


class ResolveIn(BaseModel):
    resolutions: list[ShortageResolutionIn] = Field(min_length=1)
    publish: bool | None = None


# --------------------------------------------------------------------------- sorties


class EventOut(BaseModel):
    """Une ligne du journal de la journée (F6.4)."""

    id: uuid.UUID
    day: date
    type: EventType
    type_label: str
    action: str | None = None
    summary: str
    occurred_at: UtcDatetime
    actor_id: uuid.UUID | None = None
    actor_name: str | None = None
    plan_id: uuid.UUID | None = None
    plan_version: int | None = None
    trip_id: uuid.UUID | None = None
    trip_seq: int | None = None
    truck_plate: str | None = None
    payload: dict[str, Any]


class RuleIssueOut(BaseModel):
    rule_code: str
    severity: Severity
    message: str
    trip_id: uuid.UUID | None = None
    trip_seq: int | None = None


class PlanResultOut(BaseModel):
    """État de la version du plan après un événement (RM-18)."""

    plan_id: uuid.UUID
    plan_version: int
    plan_status: PlanStatus
    published: bool
    version_created: bool
    previous_plan_id: uuid.UUID | None = None
    previous_plan_version: int | None = None
    previous_plan_status: PlanStatus | None = None
    blocking_count: int
    warning_count: int
    violations: list[RuleIssueOut]
    plan: PlanOut


class OtherTripOut(BaseModel):
    trip_id: uuid.UUID
    seq: int
    status: TripStatus
    pending_stops: int


class EventResultOut(PlanResultOut):
    """Réponse des routes panne de camion et chauffeur indisponible."""

    event: EventOut
    source_trip_id: uuid.UUID
    origin_trip_id: uuid.UUID | None = None
    new_trip_id: uuid.UUID | None = None
    trip_id: uuid.UUID
    truck_id: uuid.UUID
    driver_id: uuid.UUID | None = None
    transferred_stop_ids: list[uuid.UUID] = []
    kept_stop_ids: list[uuid.UUID] = []
    other_impacted_trips: list[OtherTripOut] = []


class ReasonOut(BaseModel):
    rule_code: str | None = None
    message: str


class TripBriefOut(BaseModel):
    trip_id: uuid.UUID
    source_trip_id: uuid.UUID
    plan_id: uuid.UUID
    plan_version: int
    plan_status: PlanStatus
    seq: int
    status: TripStatus
    truck_id: uuid.UUID
    truck_plate: str | None = None
    driver_id: uuid.UUID | None = None
    driver_name: str | None = None
    depot_id: uuid.UUID
    depot_code: str | None = None
    pending_stops: int
    delivered_stops: int
    skipped_stops: int
    pending_l: float
    pending_station_codes: list[str]
    can_replace_truck: bool
    can_replace_driver: bool
    blocked_reason: str | None = None


class TruckOptionOut(BaseModel):
    truck_id: uuid.UUID
    plate: str
    size: TruckSize
    carrier_name: str | None = None
    total_capacity_l: float
    assigned_driver_id: uuid.UUID | None = None
    assigned_driver_name: str | None = None
    other_trip_seqs: list[int] = []
    eligible: bool
    reasons: list[ReasonOut] = []
    suggested_driver_id: uuid.UUID | None = None
    suggested_driver_name: str | None = None
    driver_required: bool = False


class DriverOptionOut(BaseModel):
    driver_id: uuid.UUID
    full_name: str
    phone: str | None = None
    carrier_name: str | None = None
    assigned_truck_id: uuid.UUID | None = None
    assigned_truck_plate: str | None = None
    other_trip_seqs: list[int] = []
    is_current: bool = False
    eligible: bool
    reasons: list[ReasonOut] = []


class ReplacementOptionsOut(BaseModel):
    """Assistant de réaffectation (écran 6)."""

    trip: TripBriefOut
    occurred_at: UtcDatetime
    drivers_evaluated_for_truck_id: uuid.UUID
    trucks: list[TruckOptionOut]
    drivers: list[DriverOptionOut]


class ShortageOrderOut(BaseModel):
    order_id: uuid.UUID
    stop_id: uuid.UUID
    station_code: str | None = None
    station_name: str | None = None
    planned_l: float
    requested_l: float | None = None
    priority: str | None = None


class AlternativeDepotOut(BaseModel):
    depot_id: uuid.UUID
    code: str
    name: str
    available_l: float | None = None
    planned_l: float
    remaining_l: float | None = None
    sufficient: bool | None = None


class ImpactedTripOut(BaseModel):
    plan_id: uuid.UUID
    plan_version: int
    plan_status: PlanStatus
    trip_id: uuid.UUID
    trip_seq: int
    status: TripStatus
    truck_plate: str | None = None
    driver_name: str | None = None
    planned_start_at: UtcDatetime | None = None
    planned_l: float
    covered_l: float
    shortfall_l: float
    options: list[Literal["reduce", "postpone", "change_depot"]]
    orders: list[ShortageOrderOut]
    alternative_depots: list[AlternativeDepotOut]
    resolution: dict[str, Any] | None = None


class ShortageOut(BaseModel):
    """Réponse de la déclaration d'une pénurie (F6.3)."""

    event: EventOut
    status: Literal["open", "resolved", "no_impact"]
    day: date
    depot_id: uuid.UUID
    depot_code: str
    product_id: uuid.UUID
    product_code: str
    previous_available_l: float | None = None
    new_available_l: float
    loaded_l: float
    remaining_l: float
    planned_unloaded_l: float
    shortfall_l: float
    impacted_trips: list[ImpactedTripOut]


class ResolveOut(ShortageOut):
    results: list[PlanResultOut]
