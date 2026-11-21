"""Schémas de l'administration : paramètres (F9.2) et état de santé."""

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class SettingOut(BaseModel):
    key: str
    value: Any
    default: Any
    description: str
    type: str  # int | float | str | bool | time | timezone | json
    min: float | None = None
    max: float | None = None
    nullable: bool = False
    is_default: bool
    updated_by: uuid.UUID | None = None
    updated_by_name: str | None = None
    updated_at: datetime | None = None


class SettingsUpdate(BaseModel):
    values: dict[str, Any] = Field(
        min_length=1,
        description='Clés à modifier et leur nouvelle valeur, par exemple {"max_service_hours": 10}.',
    )


class HealthOut(BaseModel):
    status: str  # ok | degrade | indisponible
    checks: dict[str, str]  # composant → ok | indisponible


class OsrmHealthOut(BaseModel):
    status: str  # ok | indisponible
    detail: str | None = None
