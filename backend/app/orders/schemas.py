"""Schémas de l'API des commandes (F3) et types de sérialisation communs au lot L4.

Conventions (docs/CONTRATS.md §7) : volumes en `float`, heures seules `"HH:MM"` (heure locale),
horodatages ISO 8601 en UTC (`…Z`), dates `YYYY-MM-DD`.
"""

import uuid
from datetime import UTC, date, datetime, time
from typing import Annotated, Self

from pydantic import AfterValidator, BaseModel, Field, PlainSerializer, model_validator

from app.core.enums import OrderPriority, OrderSource, OrderStatus


def _utc_iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _strip_seconds(value: time) -> time:
    return time(value.hour, value.minute)


# Horodatage toujours rendu en UTC avec le suffixe `Z` (RM-20 : l'affichage local est fait par le front).
UtcDatetime = Annotated[datetime, PlainSerializer(_utc_iso, return_type=str)]
# Heure seule `"HH:MM"`, en heure locale du jour J.
HourMinute = Annotated[
    time, AfterValidator(_strip_seconds), PlainSerializer(lambda t: t.strftime("%H:%M"), return_type=str)
]


def _check_window(start: time | None, end: time | None) -> None:
    if start is not None and end is not None and start >= end:
        raise ValueError("La fenêtre de livraison est incohérente : le début doit précéder la fin.")


class OrderIn(BaseModel):
    """Saisie manuelle d'une commande (F3.1). La commande est créée en `draft`."""

    day: date
    station_id: uuid.UUID
    product_id: uuid.UUID
    requested_l: float = Field(gt=0, description="Volume demandé, en litres")
    priority: OrderPriority = OrderPriority.NORMAL
    window_start: HourMinute | None = None
    window_end: HourMinute | None = None
    comment: str | None = None

    @model_validator(mode="after")
    def _window(self) -> Self:
        _check_window(self.window_start, self.window_end)
        return self


class OrderPatch(BaseModel):
    """Modification partielle : seuls les champs présents sont modifiés."""

    day: date | None = None
    station_id: uuid.UUID | None = None
    product_id: uuid.UUID | None = None
    requested_l: float | None = Field(default=None, gt=0)
    priority: OrderPriority | None = None
    window_start: HourMinute | None = None
    window_end: HourMinute | None = None
    comment: str | None = None


class OrderWarning(BaseModel):
    """Avertissement non bloquant (ex. F3.4 : cuve non renseignée)."""

    code: str
    message: str


class OrderOut(BaseModel):
    id: uuid.UUID
    day: date
    station_id: uuid.UUID
    station_code: str
    station_name: str
    product_id: uuid.UUID
    product_code: str
    product_label: str
    requested_l: float
    priority: OrderPriority
    window_start: HourMinute | None
    window_end: HourMinute | None
    comment: str | None
    status: OrderStatus
    source: OrderSource
    import_batch_id: uuid.UUID | None
    created_at: UtcDatetime
    updated_at: UtcDatetime
    # Avertissements F3.4, calculés à chaque lecture pour les commandes `draft` et `confirmed` :
    # `tank_unknown` (cuve non renseignée), `exceeds_tank_capacity` (confirmation impossible).
    warnings: list[OrderWarning] = []


class BulkConfirmIn(BaseModel):
    order_ids: list[uuid.UUID] = Field(min_length=1, max_length=500)


class BulkError(BaseModel):
    code: str
    message: str


class BulkConfirmItem(BaseModel):
    order_id: uuid.UUID
    ok: bool
    order: OrderOut | None = None
    warnings: list[OrderWarning] = []
    error: BulkError | None = None


class BulkConfirmOut(BaseModel):
    confirmed: int
    failed: int
    results: list[BulkConfirmItem]
