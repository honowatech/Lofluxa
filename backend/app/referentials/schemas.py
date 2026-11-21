"""Schémas de l'API des référentiels (F1.1 à F1.5).

Conventions (docs/CONTRATS.md §7) : champs en `snake_case` identiques aux colonnes, volumes en `float`,
position en deux champs `lat` / `lon`, horaires d'ouverture au format de `app.core.time.opening_windows`.

Les schémas `…Update` sont partiels : un champ absent de la requête n'est pas modifié (PUT et PATCH).
"""

import re
import uuid
from datetime import date
from typing import Annotated, Any

from pydantic import AfterValidator, BaseModel, ConfigDict, EmailStr, Field, StringConstraints

from app.core.enums import CarrierType, DepotOperator, DriverStatus, TruckSize, TruckStatus
from app.core.time import WEEKDAY_KEYS, hm_to_seconds

_HM = re.compile(r"^(?:([01]?\d|2[0-3]):([0-5]\d)|24:00)$")


def normalize_opening_hours(value: Any) -> dict[str, list[list[str]]]:
    """Valide et normalise des horaires d'ouverture ; lève `ValueError` (message en français).

    Format : `{"mon": [["06:00", "18:00"]], …, "sun": []}`. `{}` = ouvert en continu.
    Dès qu'un jour est renseigné, les jours absents sont fermés (ils sont ajoutés avec une liste vide).
    """
    if value is None or value == {}:
        return {}
    if not isinstance(value, dict):
        raise ValueError("Les horaires doivent être un objet {jour: [[début, fin], …]}.")
    unknown = [key for key in value if key not in WEEKDAY_KEYS]
    if unknown:
        raise ValueError(
            f"Jour inconnu dans les horaires : {', '.join(map(str, unknown))} "
            f"(attendus : {', '.join(WEEKDAY_KEYS)})."
        )
    result: dict[str, list[list[str]]] = {}
    for key in WEEKDAY_KEYS:
        windows = value.get(key) or []
        if not isinstance(windows, list):
            raise ValueError(f"Horaires du jour « {key} » : une liste de plages [début, fin] est attendue.")
        parsed: list[tuple[int, int, list[str]]] = []
        for window in windows:
            if not isinstance(window, list | tuple) or len(window) != 2:
                raise ValueError(f"Horaires du jour « {key} » : chaque plage doit être [début, fin].")
            bounds = []
            for bound in window:
                if not isinstance(bound, str) or not _HM.match(bound.strip()):
                    raise ValueError(
                        f"Horaires du jour « {key} » : heure invalide « {bound} » (format HH:MM)."
                    )
                hours, minutes = bound.strip().split(":")
                bounds.append(f"{int(hours):02d}:{minutes}")
            start_s, end_s = hm_to_seconds(bounds[0]), hm_to_seconds(bounds[1])
            if start_s >= end_s:
                raise ValueError(
                    f"Horaires du jour « {key} » : la fin ({bounds[1]}) doit suivre le début ({bounds[0]})."
                )
            parsed.append((start_s, end_s, bounds))
        parsed.sort()
        for previous, current in zip(parsed, parsed[1:], strict=False):
            if current[0] < previous[1]:
                raise ValueError(f"Horaires du jour « {key} » : les plages se chevauchent.")
        result[key] = [bounds for _, _, bounds in parsed]
    return result


def _clean_color(value: str) -> str:
    if not re.match(r"^#[0-9a-fA-F]{6}$", value):
        raise ValueError("Couleur attendue au format #RRGGBB.")
    return value.lower()


def _upper(value: str) -> str:
    return value.upper()


Code = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=32, pattern=r"^[A-Za-z0-9_.\-]+$"),
    AfterValidator(_upper),
]
Plate = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=32),
    AfterValidator(_upper),
]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]
ShortText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=80)]
Lat = Annotated[float, Field(ge=-90, le=90, description="Latitude en degrés décimaux (WGS 84)")]
Lon = Annotated[float, Field(ge=-180, le=180, description="Longitude en degrés décimaux (WGS 84)")]
Liters = Annotated[float, Field(gt=0, le=9_999_999_999)]
LitersOrZero = Annotated[float, Field(ge=0, le=9_999_999_999)]
OpeningHours = Annotated[dict[str, list[list[str]]], AfterValidator(normalize_opening_hours)]
Color = Annotated[str, AfterValidator(_clean_color)]


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _Out(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --- Produits (F1.1) --------------------------------------------------------------------------------


class ProductCreate(_In):
    code: Code
    label: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
    ref_density_15: Annotated[float, Field(gt=0, lt=2, description="Densité de référence à 15 °C (kg/L)")]
    thermal_coeff: Annotated[float, Field(ge=0, lt=0.01, description="Coefficient de dilatation par °C")]
    color: Color = "#888888"


class ProductUpdate(_In):
    code: Code | None = None
    label: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)] | None = (
        None
    )
    ref_density_15: Annotated[float, Field(gt=0, lt=2)] | None = None
    thermal_coeff: Annotated[float, Field(ge=0, lt=0.01)] | None = None
    color: Color | None = None


class ProductOut(_Out):
    id: uuid.UUID
    code: str
    label: str
    ref_density_15: float
    thermal_coeff: float
    color: str


# --- Dépôts (F1.2) ----------------------------------------------------------------------------------


class DepotCreate(_In):
    code: Code
    name: Name
    operator: DepotOperator = DepotOperator.SCDP
    lat: Lat
    lon: Lon
    address: str | None = None
    opening_hours: OpeningHours = Field(default_factory=dict)
    avg_wait_min: Annotated[int, Field(ge=0, le=1440)] | None = None
    max_loadings_per_truck_day: Annotated[int, Field(ge=1, le=50)] | None = None
    active: bool = True


class DepotUpdate(_In):
    code: Code | None = None
    name: Name | None = None
    operator: DepotOperator | None = None
    lat: Lat | None = None
    lon: Lon | None = None
    address: str | None = None
    opening_hours: OpeningHours | None = None
    avg_wait_min: Annotated[int, Field(ge=0, le=1440)] | None = None
    max_loadings_per_truck_day: Annotated[int, Field(ge=1, le=50)] | None = None
    active: bool | None = None


class DepotOut(_Out):
    id: uuid.UUID
    code: str
    name: str
    operator: DepotOperator
    lat: float
    lon: float
    address: str | None
    opening_hours: dict[str, list[list[str]]]
    avg_wait_min: int | None
    max_loadings_per_truck_day: int | None
    active: bool


# --- Stations et cuves (F1.3) -----------------------------------------------------------------------


class TankCreate(_In):
    product_id: uuid.UUID
    capacity_l: Liters
    safety_stock_l: LitersOrZero = 0


class TankUpdate(_In):
    product_id: uuid.UUID | None = None
    capacity_l: Liters | None = None
    safety_stock_l: LitersOrZero | None = None


class TankOut(_Out):
    id: uuid.UUID
    station_id: uuid.UUID
    product_id: uuid.UUID
    product_code: str
    product_label: str
    capacity_l: float
    safety_stock_l: float


class StationCreate(_In):
    code: Code
    name: Name
    region: ShortText | None = None
    city: ShortText | None = None
    lat: Lat
    lon: Lon
    opening_hours: OpeningHours = Field(default_factory=dict)
    max_truck_size: TruckSize = TruckSize.LARGE
    unload_time_min: Annotated[int, Field(ge=0, le=1440)] | None = None
    contact_name: Annotated[str, StringConstraints(strip_whitespace=True, max_length=160)] | None = None
    contact_phone: Annotated[str, StringConstraints(strip_whitespace=True, max_length=40)] | None = None
    contact_email: EmailStr | None = None
    active: bool = True
    tanks: list[TankCreate] = Field(default_factory=list)


class StationUpdate(_In):
    code: Code | None = None
    name: Name | None = None
    region: ShortText | None = None
    city: ShortText | None = None
    lat: Lat | None = None
    lon: Lon | None = None
    opening_hours: OpeningHours | None = None
    max_truck_size: TruckSize | None = None
    unload_time_min: Annotated[int, Field(ge=0, le=1440)] | None = None
    contact_name: Annotated[str, StringConstraints(strip_whitespace=True, max_length=160)] | None = None
    contact_phone: Annotated[str, StringConstraints(strip_whitespace=True, max_length=40)] | None = None
    contact_email: EmailStr | None = None
    active: bool | None = None
    # Si fourni : remplace la liste complète des cuves (une cuve par produit).
    tanks: list[TankCreate] | None = None


class StationOut(_Out):
    id: uuid.UUID
    code: str
    name: str
    region: str | None
    city: str | None
    lat: float
    lon: float
    opening_hours: dict[str, list[list[str]]]
    max_truck_size: TruckSize
    unload_time_min: int | None
    contact_name: str | None
    contact_phone: str | None
    contact_email: str | None
    active: bool
    tanks: list[TankOut]


# --- Transporteurs ----------------------------------------------------------------------------------


class CarrierCreate(_In):
    name: Name
    type: CarrierType = CarrierType.THIRD_PARTY
    contact: str | None = None


class CarrierUpdate(_In):
    name: Name | None = None
    type: CarrierType | None = None
    contact: str | None = None


class CarrierOut(_Out):
    id: uuid.UUID
    name: str
    type: CarrierType
    contact: str | None


# --- Camions et compartiments (F1.4) ----------------------------------------------------------------


class CompartmentCreate(_In):
    position: Annotated[int, Field(ge=1, le=20)]
    capacity_l: Liters
    # null = tous produits (RM-07)
    allowed_product_ids: list[uuid.UUID] | None = None


class CompartmentUpdate(_In):
    position: Annotated[int, Field(ge=1, le=20)] | None = None
    capacity_l: Liters | None = None
    allowed_product_ids: list[uuid.UUID] | None = None


class CompartmentOut(_Out):
    id: uuid.UUID
    truck_id: uuid.UUID
    position: int
    capacity_l: float
    allowed_product_ids: list[uuid.UUID] | None
    allowed_product_codes: list[str] | None


class TruckCreate(_In):
    plate: Plate
    carrier_id: uuid.UUID | None = None
    size: TruckSize
    # Facultative si des compartiments sont fournis : vaut alors la somme de leurs capacités.
    total_capacity_l: Liters | None = None
    avg_speed_kmh: Annotated[float, Field(gt=0, le=150)] | None = None
    status: TruckStatus = TruckStatus.AVAILABLE
    cost_per_km: Annotated[int, Field(ge=0)] | None = None
    notes: str | None = None
    compartments: list[CompartmentCreate] = Field(default_factory=list)


class TruckUpdate(_In):
    plate: Plate | None = None
    carrier_id: uuid.UUID | None = None
    size: TruckSize | None = None
    total_capacity_l: Liters | None = None
    avg_speed_kmh: Annotated[float, Field(gt=0, le=150)] | None = None
    status: TruckStatus | None = None
    cost_per_km: Annotated[int, Field(ge=0)] | None = None
    notes: str | None = None
    # Si fourni : remplace la liste complète des compartiments (identifiés par leur position).
    compartments: list[CompartmentCreate] | None = None


class TruckOut(_Out):
    id: uuid.UUID
    plate: str
    carrier_id: uuid.UUID | None
    carrier_name: str | None
    carrier_type: CarrierType | None
    size: TruckSize
    total_capacity_l: float
    avg_speed_kmh: float | None
    status: TruckStatus
    cost_per_km: int | None
    notes: str | None
    compartments: list[CompartmentOut]


# --- Chauffeurs (F1.5) ------------------------------------------------------------------------------


class DriverCreate(_In):
    full_name: Name
    phone: Annotated[str, StringConstraints(strip_whitespace=True, max_length=40)] | None = None
    license_no: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)] | None
    ) = None
    license_expiry: date | None = None
    hazmat_cert: bool = False
    hazmat_expiry: date | None = None
    carrier_id: uuid.UUID | None = None
    status: DriverStatus = DriverStatus.AVAILABLE
    default_truck_id: uuid.UUID | None = None


class DriverUpdate(_In):
    full_name: Name | None = None
    phone: Annotated[str, StringConstraints(strip_whitespace=True, max_length=40)] | None = None
    license_no: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)] | None
    ) = None
    license_expiry: date | None = None
    hazmat_cert: bool | None = None
    hazmat_expiry: date | None = None
    carrier_id: uuid.UUID | None = None
    status: DriverStatus | None = None
    default_truck_id: uuid.UUID | None = None


class DriverOut(_Out):
    id: uuid.UUID
    full_name: str
    phone: str | None
    license_no: str | None
    license_expiry: date | None
    hazmat_cert: bool
    hazmat_expiry: date | None
    carrier_id: uuid.UUID | None
    carrier_name: str | None
    status: DriverStatus
    default_truck_id: uuid.UUID | None
    default_truck_plate: str | None
