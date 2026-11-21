"""Schémas de l'API chargement et livraisons (F7). Volumes en litres (`float`), heures ISO 8601 en UTC."""

import uuid
from datetime import UTC, datetime
from typing import Annotated

from pydantic import AwareDatetime, BaseModel, EmailStr, Field, PlainSerializer, model_validator

from app.core.enums import StopStatus, TripStatus


def _iso_utc(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


# Horodatage de sortie : toujours en UTC, suffixe `Z` (CONTRATS §7).
UtcDatetime = Annotated[datetime, PlainSerializer(_iso_utc, return_type=str, when_used="json")]


# ── Chargement ────────────────────────────────────────────────────────────────


class LoadingLineIn(BaseModel):
    compartment_id: uuid.UUID
    product_id: uuid.UUID
    observed_l: float = Field(gt=0, lt=1e9, description="Volume observé (L)")
    # Bornes techniques (colonne numeric(5,2)), pas une règle métier.
    observed_temp_c: float = Field(ge=-50, le=100, description="Température observée (°C)")
    observed_density: float | None = Field(default=None, gt=0, lt=10, description="Densité observée (kg/L)")


class LoadingIn(BaseModel):
    arrived_at: AwareDatetime | None = None
    started_at: AwareDatetime | None = None
    finished_at: AwareDatetime | None = None
    depot_ticket_no: str | None = Field(default=None, max_length=64)
    lines: list[LoadingLineIn] = Field(min_length=1)


class LoadingLineOut(BaseModel):
    id: uuid.UUID
    compartment_id: uuid.UUID
    compartment_position: int | None
    product_id: uuid.UUID
    product_code: str | None
    product_label: str | None
    observed_l: float
    observed_temp_c: float
    observed_density: float | None
    volume_15_l: float
    planned_l: float | None
    gap_l: float | None
    gap_pct: float | None
    out_of_tolerance: bool


class LoadingOut(BaseModel):
    id: uuid.UUID
    trip_id: uuid.UUID
    depot_id: uuid.UUID
    depot_code: str | None
    arrived_at: UtcDatetime | None
    started_at: UtcDatetime | None
    finished_at: UtcDatetime | None
    depot_ticket_no: str | None
    entered_by: uuid.UUID | None
    entered_by_name: str | None
    lines: list[LoadingLineOut]
    observed_total_l: float
    volume_15_total_l: float
    planned_total_l: float
    gap_l: float
    gap_pct: float | None
    tolerance_pct: float
    # RM-13 : vrai si un compartiment ou le total sort de la tolérance.
    out_of_tolerance: bool
    warning_message: str | None
    # Mention à afficher dans l'interface (RM-12).
    conversion_note: str


# ── Tournées (vue Fleet, statuts) ─────────────────────────────────────────────


class LoadingSummaryOut(BaseModel):
    id: uuid.UUID
    arrived_at: UtcDatetime | None
    started_at: UtcDatetime | None
    finished_at: UtcDatetime | None
    depot_ticket_no: str | None
    observed_total_l: float
    volume_15_total_l: float
    gap_l: float
    gap_pct: float | None
    out_of_tolerance: bool


class TripLoadingOut(BaseModel):
    """Une tournée vue du dépôt : libellés, heures, état de chargement, avancement des arrêts."""

    id: uuid.UUID
    plan_id: uuid.UUID
    day: str
    seq: int
    status: TripStatus
    truck_id: uuid.UUID
    truck_plate: str | None
    driver_id: uuid.UUID | None
    driver_name: str | None
    depot_id: uuid.UUID
    depot_code: str | None
    depot_name: str | None
    planned_start_at: UtcDatetime | None
    planned_depart_at: UtcDatetime | None
    planned_return_at: UtcDatetime | None
    actual_depart_at: UtcDatetime | None
    actual_return_at: UtcDatetime | None
    distance_m: int
    actual_distance_m: int | None
    planned_total_l: float
    stop_count: int
    stops_done: int
    loading_recorded: bool
    loading: LoadingSummaryOut | None


class TripStatusIn(BaseModel):
    status: TripStatus
    actual_depart_at: AwareDatetime | None = None
    actual_return_at: AwareDatetime | None = None
    actual_distance_m: int | None = Field(default=None, ge=0)


# ── Livraisons ────────────────────────────────────────────────────────────────


class DeliveryLineIn(BaseModel):
    order_id: uuid.UUID
    actual_l: float = Field(ge=0, lt=1e9)


class StopDeliveryIn(BaseModel):
    actual_arrival_at: AwareDatetime | None = None
    actual_departure_at: AwareDatetime | None = None
    deliveries: list[DeliveryLineIn] | None = None
    skip_reason: str | None = None

    @model_validator(mode="after")
    def _one_of(self) -> "StopDeliveryIn":
        if self.skip_reason is not None:
            self.skip_reason = self.skip_reason.strip() or None
        if self.deliveries is not None and self.skip_reason is not None:
            raise ValueError("Fournir soit les volumes livrés, soit un motif d'arrêt sauté, pas les deux.")
        if self.deliveries is None and self.skip_reason is None:
            raise ValueError(
                "Fournir les volumes livrés, ou le motif si l'arrêt est sauté (motif obligatoire)."
            )
        if (
            self.actual_arrival_at is not None
            and self.actual_departure_at is not None
            and self.actual_departure_at < self.actual_arrival_at
        ):
            raise ValueError("L'heure de départ ne peut pas précéder l'heure d'arrivée.")
        return self


class StopDeliveryLineOut(BaseModel):
    id: uuid.UUID
    order_id: uuid.UUID
    order_status: str | None
    product_id: uuid.UUID
    product_code: str | None
    planned_l: float
    actual_l: float | None


class StopOut(BaseModel):
    id: uuid.UUID
    trip_id: uuid.UUID
    trip_status: TripStatus
    seq: int
    station_id: uuid.UUID
    station_code: str | None
    station_name: str | None
    status: StopStatus
    planned_arrival_at: UtcDatetime | None
    planned_departure_at: UtcDatetime | None
    actual_arrival_at: UtcDatetime | None
    actual_departure_at: UtcDatetime | None
    skip_reason: str | None
    deliveries: list[StopDeliveryLineOut]
    # Vrai quand tous les arrêts de la tournée sont livrés ou sautés (la tournée peut passer `completed`).
    trip_all_stops_done: bool


# ── Envoi de la fiche ─────────────────────────────────────────────────────────


class LoadingSheetEmailIn(BaseModel):
    # Vide ou absent : envoi aux gérants des stations de la tournée (`stations.contact_email`).
    recipients: list[EmailStr] | None = None


class LoadingSheetEmailOut(BaseModel):
    sent_to: list[str]
    stations_without_email: list[str]
