"""Type et bornes de chaque paramètre métier (F9.2), pour valider `PUT /settings`.

Les clés et valeurs par défaut restent définies dans `app.core.settings_store.DEFAULTS` (source unique).
Les bornes ci-dessous sont des garde-fous techniques contre les fautes de frappe, pas des règles métier
(voir docs/questions/l8-admin-infra.md). Une clé de `DEFAULTS` sans entrée ici est validée d'après le
type de sa valeur par défaut, sans borne.
"""

import re
from dataclasses import dataclass
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.core.settings_store import DEFAULTS

INT = "int"
FLOAT = "float"
STR = "str"
BOOL = "bool"
TIME = "time"  # "HH:MM", heure locale
TIMEZONE = "timezone"  # nom de fuseau IANA
JSON = "json"  # valeur libre (clé sans type déductible)

_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


class SettingError(ValueError):
    """Valeur refusée ; le message est destiné à l'utilisateur."""


@dataclass(frozen=True)
class SettingSpec:
    type: str
    min: float | None = None
    max: float | None = None
    nullable: bool = False
    max_length: int | None = None


SPECS: dict[str, SettingSpec] = {
    "default_avg_speed_kmh": SettingSpec(FLOAT, 5, 120),
    "max_service_hours": SettingSpec(FLOAT, 1, 24),
    "default_depot_wait_min": SettingSpec(INT, 0, 720),
    "depot_loading_time_min": SettingSpec(INT, 0, 720),
    "default_unload_time_min": SettingSpec(INT, 0, 720),
    "default_max_loadings_per_truck_day": SettingSpec(INT, 1, 10),
    "compartment_safety_margin_pct": SettingSpec(FLOAT, 0, 50),
    "loading_tolerance_pct": SettingSpec(FLOAT, 0, 50),
    "window_tolerance_min": SettingSpec(INT, 0, 720),
    "partial_delivery_min_pct": SettingSpec(FLOAT, 0, 100),
    "day_start_time": SettingSpec(TIME),
    "timezone": SettingSpec(TIMEZONE),
    "objective_distance_weight": SettingSpec(FLOAT, 0, 1_000),
    "objective_vehicle_fixed_cost_km": SettingSpec(FLOAT, 0, 100_000),
    "objective_unserved_penalty_normal_km": SettingSpec(FLOAT, 0, 10_000_000),
    "objective_unserved_penalty_urgent_km": SettingSpec(FLOAT, 0, 10_000_000),
    "solver_time_limit_s": SettingSpec(INT, 1, 600),
    "solver_no_improvement_s": SettingSpec(INT, 1, 600),
    "solver_seed": SettingSpec(INT, 0, 2_147_483_647),
    "haversine_factor": SettingSpec(FLOAT, 1, 3),
    "ab_success_threshold_pct": SettingSpec(FLOAT, 0, 100),
    "company_name": SettingSpec(STR, max_length=120),
    "pdf_logo_url": SettingSpec(STR, nullable=True, max_length=500),
}


def spec_for(key: str) -> SettingSpec:
    """Spécification d'une clé connue de `DEFAULTS` (déduite du défaut si elle n'est pas décrite)."""
    if key in SPECS:
        return SPECS[key]
    default = DEFAULTS[key][0]
    if isinstance(default, bool):
        return SettingSpec(BOOL)
    if isinstance(default, int):
        return SettingSpec(INT)
    if isinstance(default, float):
        return SettingSpec(FLOAT)
    if isinstance(default, str):
        return SettingSpec(STR)
    return SettingSpec(JSON, nullable=True)


def _number(value: Any) -> float:
    return float(value)


def _fmt(bound: float) -> str:
    return str(int(bound)) if float(bound).is_integer() else str(bound)


def normalize(key: str, value: Any) -> Any:
    """Valide et normalise la valeur d'un paramètre. Lève `SettingError` (message en français)."""
    spec = spec_for(key)
    if value is None or (isinstance(value, str) and not value.strip() and spec.nullable):
        if spec.nullable:
            return None
        raise SettingError("Une valeur est obligatoire.")

    if spec.type == JSON:
        return value

    if spec.type == BOOL:
        if not isinstance(value, bool):
            raise SettingError("Valeur attendue : vrai ou faux.")
        return value

    if spec.type in (INT, FLOAT):
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise SettingError("Valeur attendue : un nombre.")
        if value != value or value in (float("inf"), float("-inf")):
            raise SettingError("Valeur attendue : un nombre fini.")
        if spec.type == INT:
            if float(value) != int(value):
                raise SettingError("Valeur attendue : un nombre entier.")
            value = int(value)
        else:
            value = _number(value)
        if spec.min is not None and value < spec.min:
            raise SettingError(f"La valeur doit être supérieure ou égale à {_fmt(spec.min)}.")
        if spec.max is not None and value > spec.max:
            raise SettingError(f"La valeur doit être inférieure ou égale à {_fmt(spec.max)}.")
        return value

    if not isinstance(value, str):
        raise SettingError("Valeur attendue : un texte.")
    value = value.strip()
    if not value:
        raise SettingError("Une valeur est obligatoire.")
    if spec.max_length is not None and len(value) > spec.max_length:
        raise SettingError(f"{spec.max_length} caractères au maximum.")
    if spec.type == TIME and not _TIME_RE.match(value):
        raise SettingError("Format attendu : HH:MM (par exemple 06:00).")
    if spec.type == TIMEZONE:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise SettingError("Fuseau horaire inconnu (exemple : Africa/Douala).") from exc
    return value
