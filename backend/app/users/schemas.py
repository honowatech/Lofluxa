"""Schémas de la gestion des utilisateurs (F9.1). Le hachage du mot de passe n'est jamais exposé."""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from app.core.enums import Role


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    full_name: str
    role: Role
    active: bool
    last_login_at: datetime | None
    created_at: datetime
    updated_at: datetime


class UserCreate(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=1, max_length=160)
    role: Role
    password: str = Field(description="Mot de passe initial, à communiquer à l'utilisateur.")
    active: bool = True


class UserUpdate(BaseModel):
    """Mise à jour partielle : seuls les champs fournis sont modifiés."""

    email: EmailStr | None = None
    full_name: str | None = Field(default=None, min_length=1, max_length=160)
    role: Role | None = None
    active: bool | None = None


class PasswordResetIn(BaseModel):
    password: str = Field(description="Nouveau mot de passe, à communiquer à l'utilisateur.")
