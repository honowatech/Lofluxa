"""Schémas de l'API de disponibilité du jour (F2)."""

import uuid
from datetime import date
from typing import Literal

from pydantic import BaseModel, Field

from app.core.enums import DriverStatus, TruckSize, TruckStatus
from app.orders.schemas import UtcDatetime

AssignmentSource = Literal["daily", "default"]

# --- Stocks dépôt (F2.1) ---------------------------------------------------------------------


class DepotStockItemIn(BaseModel):
    depot_id: uuid.UUID
    product_id: uuid.UUID
    available_l: float | None = Field(
        ge=0, description="Stock disponible, en litres ; `null` efface la saisie (retour à « non renseigné »)"
    )


class DepotStocksIn(BaseModel):
    items: list[DepotStockItemIn] = Field(min_length=1, max_length=500)


class DepotStockOut(BaseModel):
    """Valeur courante pour (dépôt, produit, jour). `available_l` nul = stock non renseigné
    (jamais saisi, ou saisie effacée : `id`, `entered_at`, `entered_by` décrivent alors l'effacement)."""

    id: uuid.UUID | None
    day: date
    depot_id: uuid.UUID
    depot_code: str
    depot_name: str
    product_id: uuid.UUID
    product_code: str
    product_label: str
    available_l: float | None
    entered_at: UtcDatetime | None
    entered_by: uuid.UUID | None
    entered_by_name: str | None
    history_count: int


class DepotStockEntryOut(BaseModel):
    """Une saisie de l'historique. `is_current` : c'est elle qui fait foi.
    `available_l` nul = effacement de la saisie précédente."""

    id: uuid.UUID
    day: date
    depot_id: uuid.UUID
    depot_code: str
    depot_name: str
    product_id: uuid.UUID
    product_code: str
    product_label: str
    available_l: float | None
    entered_at: UtcDatetime
    entered_by: uuid.UUID | None
    entered_by_name: str | None
    is_current: bool


# --- Camions du jour (F2.2) ------------------------------------------------------------------


class TruckDayItemIn(BaseModel):
    truck_id: uuid.UUID
    available: bool
    reason: str | None = Field(default=None, description="Motif de l'indisponibilité du jour")


class TruckDaysIn(BaseModel):
    items: list[TruckDayItemIn] = Field(min_length=1, max_length=500)


class TruckDayOut(BaseModel):
    truck_id: uuid.UUID
    day: date
    plate: str
    size: TruckSize
    total_capacity_l: float
    carrier_id: uuid.UUID | None
    carrier_name: str | None
    status: TruckStatus  # statut du référentiel
    available_today: bool  # False si marqué indisponible pour J
    day_reason: str | None  # motif du marquage du jour
    assignable: bool  # RM-04
    block_reason: str | None
    rule_code: str | None  # "RM-04" si non affectable
    # Chauffeur affecté pour J (affectation du jour, sinon camion habituel du chauffeur).
    driver_id: uuid.UUID | None
    driver_name: str | None
    assignment_source: AssignmentSource | None


# --- Chauffeurs du jour (F2.3, F2.4) ---------------------------------------------------------


class DriverDayItemIn(BaseModel):
    """Seuls les champs présents sont appliqués.

    `truck_id` : identifiant → affectation du jour ; `null` → retour au camion habituel."""

    driver_id: uuid.UUID
    available: bool | None = None
    reason: str | None = Field(default=None, description="Motif de l'indisponibilité du jour")
    truck_id: uuid.UUID | None = None


class DriverDaysIn(BaseModel):
    items: list[DriverDayItemIn] = Field(min_length=1, max_length=500)


class DriverDayOut(BaseModel):
    driver_id: uuid.UUID
    day: date
    full_name: str
    phone: str | None
    carrier_id: uuid.UUID | None
    carrier_name: str | None
    status: DriverStatus  # statut du référentiel
    license_expiry: date | None
    hazmat_cert: bool
    hazmat_expiry: date | None
    available_today: bool
    day_reason: str | None
    assignable: bool
    block_reason: str | None
    rule_code: str | None  # "RM-03" si le blocage vient du permis ou de l'habilitation
    default_truck_id: uuid.UUID | None
    default_truck_plate: str | None
    # Camion affecté pour J (affectation du jour, sinon camion habituel s'il est libre).
    truck_id: uuid.UUID | None
    truck_plate: str | None
    assignment_source: AssignmentSource | None


# --- Résumé du jour --------------------------------------------------------------------------


class OrdersSummary(BaseModel):
    total: int
    by_status: dict[str, int]
    urgent_pending: int  # commandes urgentes encore en brouillon ou confirmées


class ResourceSummary(BaseModel):
    total: int
    assignable: int
    blocked: int


class DriversSummary(ResourceSummary):
    blocked_rm03: int  # dont bloqués par le permis ou l'habilitation
    assignable_without_truck: int


class MissingStock(BaseModel):
    depot_id: uuid.UUID
    depot_code: str
    product_id: uuid.UUID
    product_code: str


class StocksSummary(BaseModel):
    expected: int  # couples (dépôt actif, produit)
    entered: int
    missing: int
    complete: bool
    last_entered_at: UtcDatetime | None
    missing_items: list[MissingStock]


class DaySummaryOut(BaseModel):
    day: date
    orders: OrdersSummary
    trucks: ResourceSummary
    drivers: DriversSummary
    depot_stocks: StocksSummary
