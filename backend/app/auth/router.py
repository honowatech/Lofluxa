"""Authentification : e-mail + mot de passe, JWT (accès 15 min, rafraîchissement 7 jours)."""

import uuid

from fastapi import APIRouter
from pydantic import BaseModel, EmailStr
from sqlalchemy import select

from app.core.deps import CurrentUser, SessionDep
from app.core.enums import Role
from app.core.errors import UnauthorizedError
from app.core.security import ACCESS, REFRESH, create_token, decode_token, verify_password
from app.core.time import utcnow
from app.users.models import User

router = APIRouter(tags=["auth"])


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class RefreshIn(BaseModel):
    refresh_token: str


class TokenOut(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class MeOut(BaseModel):
    id: uuid.UUID
    email: str
    full_name: str
    role: Role


def _tokens(user: User) -> TokenOut:
    return TokenOut(
        access_token=create_token(user.id, user.role.value, ACCESS),
        refresh_token=create_token(user.id, user.role.value, REFRESH),
    )


@router.post("/auth/login", response_model=TokenOut)
async def login(payload: LoginIn, session: SessionDep) -> TokenOut:
    user = (
        await session.execute(select(User).where(User.email == payload.email.lower()))
    ).scalar_one_or_none()
    if user is None or not user.active or not verify_password(payload.password, user.password_hash):
        raise UnauthorizedError("E-mail ou mot de passe incorrect.", code="invalid_credentials")
    user.last_login_at = utcnow()
    return _tokens(user)


@router.post("/auth/refresh", response_model=TokenOut)
async def refresh(payload: RefreshIn, session: SessionDep) -> TokenOut:
    claims = decode_token(payload.refresh_token, REFRESH)
    user = await session.get(User, uuid.UUID(claims["sub"]))
    if user is None or not user.active:
        raise UnauthorizedError("Compte inconnu ou désactivé.")
    return _tokens(user)


@router.post("/auth/logout", status_code=204)
async def logout(_: CurrentUser) -> None:
    """Jetons sans état : le client supprime ses jetons. (Révocation côté serveur : lot L8.)"""
    return None


@router.get("/me", response_model=MeOut)
async def me(user: CurrentUser) -> MeOut:
    return MeOut(id=user.id, email=user.email, full_name=user.full_name, role=user.role)
