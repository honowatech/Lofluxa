"""Structures de la couche d'import.

1. Enregistrements normalisés échangés avec une `ImportSource` (spec §8.3) : `StationIn`, `TruckIn`,
   `DriverIn`, `DepotIn`, `OrderIn`, `DeliveryOut`, `PushResult`. Ils sont indépendants de la source
   (Excel aujourd'hui, ACCPAC / SAP demain) : références par **code** (station, produit, immatriculation),
   jamais par identifiant interne. Un champ facultatif à `None` signifie « non fourni » : la valeur en
   base est conservée lors d'une mise à jour, la valeur par défaut est prise lors d'une création.
   `row` est le numéro de la ligne d'origine dans le fichier (pour le rapport d'erreurs).
2. Rapport d'import (`RowIssue`, `ImportItem`, `ImportSummary`) et schémas de l'API (`ImportBatchOut`).
"""

import uuid
from datetime import date, datetime, time
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.enums import (
    CarrierType,
    DepotOperator,
    DriverStatus,
    ImportKind,
    ImportStatus,
    OrderPriority,
    TruckSize,
    TruckStatus,
)

OpeningHours = dict[str, list[list[str]]]


class _Record(BaseModel):
    model_config = ConfigDict(extra="forbid")

    row: int | None = None


class TankIn(_Record):
    product_code: str
    capacity_l: float
    safety_stock_l: float | None = None


class StationIn(_Record):
    code: str
    name: str | None = None
    region: str | None = None
    city: str | None = None
    lat: float | None = None
    lon: float | None = None
    opening_hours: OpeningHours | None = None
    max_truck_size: TruckSize | None = None
    unload_time_min: int | None = None
    contact_name: str | None = None
    contact_phone: str | None = None
    contact_email: str | None = None
    active: bool | None = None
    tanks: list[TankIn] = Field(default_factory=list)


class CompartmentIn(_Record):
    position: int
    capacity_l: float
    # Liste de codes produit, "all" = tous produits (RM-07), None = non fourni.
    allowed_product_codes: list[str] | Literal["all"] | None = None


class TruckIn(_Record):
    plate: str
    carrier_name: str | None = None
    carrier_type: CarrierType | None = None
    size: TruckSize | None = None
    total_capacity_l: float | None = None
    avg_speed_kmh: float | None = None
    status: TruckStatus | None = None
    cost_per_km: int | None = None
    notes: str | None = None
    compartments: list[CompartmentIn] = Field(default_factory=list)


class DriverIn(_Record):
    license_no: str
    full_name: str | None = None
    phone: str | None = None
    license_expiry: date | None = None
    hazmat_cert: bool | None = None
    hazmat_expiry: date | None = None
    carrier_name: str | None = None
    status: DriverStatus | None = None
    default_truck_plate: str | None = None


class DepotIn(_Record):
    code: str
    name: str | None = None
    operator: DepotOperator | None = None
    lat: float | None = None
    lon: float | None = None
    address: str | None = None
    opening_hours: OpeningHours | None = None
    avg_wait_min: int | None = None
    max_loadings_per_truck_day: int | None = None
    active: bool | None = None


class OrderIn(_Record):
    day: date
    station_code: str
    product_code: str
    requested_l: float
    priority: OrderPriority | None = None
    window_start: time | None = None
    window_end: time | None = None
    comment: str | None = None


class DeliveryOut(BaseModel):
    """Livraison réalisée à renvoyer vers le système source (sans effet dans le MVP)."""

    day: date
    station_code: str
    product_code: str
    delivered_l: float
    truck_plate: str | None = None
    delivered_at: datetime | None = None


class PushResult(BaseModel):
    pushed: int = 0
    message: str = ""


# --- Rapport ----------------------------------------------------------------------------------------


class RowIssue(BaseModel):
    """Une anomalie du fichier : ligne, colonne, valeur fautive et message en français."""

    row: int | None = None
    column: str | None = None
    value: str | None = None
    message: str
    severity: Literal["error", "warning"] = "error"


class FieldChange(BaseModel):
    field: str
    label: str
    before: Any = None
    after: Any = None


class ImportItem(BaseModel):
    """Effet annoncé d'un enregistrement du fichier sur la base."""

    row: int | None = None
    key: str
    label: str
    action: Literal["create", "update", "unchanged"]
    changes: list[FieldChange] = Field(default_factory=list)


class ImportSummary(BaseModel):
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    errors: int = 0
    warnings: int = 0


class ImportReportOut(BaseModel):
    summary: ImportSummary
    issues: list[RowIssue]
    items: list[ImportItem]
    # Données normalisées (enregistrements prêts à appliquer) : seulement sur demande (`include_data`).
    data: list[dict[str, Any]] | None = None
    options: dict[str, Any] = Field(default_factory=dict)
    applied: dict[str, Any] | None = None


class ImportBatchOut(BaseModel):
    id: uuid.UUID
    batch_id: uuid.UUID  # alias de `id` (libellé de la spec §9)
    kind: ImportKind
    filename: str
    status: ImportStatus
    row_count: int
    error_count: int
    can_apply: bool
    created_at: datetime
    created_by: uuid.UUID | None
    report: ImportReportOut


class ImportBatchSummaryOut(BaseModel):
    id: uuid.UUID
    kind: ImportKind
    filename: str
    status: ImportStatus
    row_count: int
    error_count: int
    can_apply: bool
    created_at: datetime
    created_by: uuid.UUID | None
    summary: ImportSummary
