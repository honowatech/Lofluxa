"""Authentification : e-mail + mot de passe, JWT (accès 15 min, rafraîchissement 7 jours).

Durcissement (spec §8.5, lot L8) : limitation de débit, révocation à la déconnexion, rotation du jeton
de rafraîchissement (un jeton de rafraîchissement ne sert qu'une fois).
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, EmailStr
from sqlalchemy import select

from app.auth.hardening import auth_limit, limiter, login_limit
from app.auth.revocation import is_token_revoked, revoke_token, revoke_user_tokens
from app.core.deps import CurrentUser, SessionDep
from app.core.enums import Role
from app.core.errors import AppError, UnauthorizedError
from app.core.security import (
    ACCESS,
    REFRESH,
    create_token,
    decode_token,
    hash_password,
    verify_password,
)
from app.core.time import utcnow
from app.users.models import User
from app.users.passwords import validate_password

router = APIRouter(tags=["auth"])

_bearer = HTTPBearer(auto_error=False)
_dummy_hash: str | None = None


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class RefreshIn(BaseModel):
    refresh_token: str


class LogoutIn(BaseModel):
    refresh_token: str | None = None


class PasswordChangeIn(BaseModel):
    current_password: str
    new_password: str


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


def _burn_time(password: str) -> None:
    """Vérifie un mot de passe factice : même temps de réponse que le compte existe ou non."""
    global _dummy_hash
    if _dummy_hash is None:
        _dummy_hash = hash_password(uuid.uuid4().hex)
    verify_password(password, _dummy_hash)


@router.post("/auth/login", response_model=TokenOut)
@limiter.limit(login_limit)
async def login(request: Request, payload: LoginIn, session: SessionDep) -> TokenOut:
    user = (
        await session.execute(select(User).where(User.email == payload.email.lower()))
    ).scalar_one_or_none()
    if user is None:
        _burn_time(payload.password)
    if user is None or not user.active or not verify_password(payload.password, user.password_hash):
        raise UnauthorizedError("E-mail ou mot de passe incorrect.", code="invalid_credentials")
    user.last_login_at = utcnow()
    return _tokens(user)


@router.post("/auth/refresh", response_model=TokenOut)
@limiter.limit(auth_limit)
async def refresh(request: Request, payload: RefreshIn, session: SessionDep) -> TokenOut:
    """Échange un jeton de rafraîchissement contre une nouvelle paire ; l'ancien jeton est révoqué."""
    claims = decode_token(payload.refresh_token, REFRESH)
    if await is_token_revoked(claims):
        raise UnauthorizedError("Session terminée. Reconnectez-vous.", code="token_revoked")
    user = await session.get(User, uuid.UUID(claims["sub"]))
    if user is None or not user.active:
        raise UnauthorizedError("Compte inconnu ou désactivé.")
    await revoke_token(claims)
    return _tokens(user)


@router.post("/auth/logout", status_code=204)
@limiter.limit(auth_limit)
async def logout(
    request: Request,
    user: CurrentUser,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    payload: LogoutIn | None = None,
) -> None:
    """Révoque le jeton d'accès présenté et, s'il est fourni dans le corps, le jeton de rafraîchissement."""
    if credentials is not None:
        await revoke_token(decode_token(credentials.credentials, ACCESS))
    if payload is not None and payload.refresh_token:
        try:
            claims = decode_token(payload.refresh_token, REFRESH)
        except UnauthorizedError:
            return None  # jeton déjà expiré ou illisible : rien à révoquer
        if claims.get("sub") == str(user.id):
            await revoke_token(claims)
    return None


@router.get("/me", response_model=MeOut)
async def me(user: CurrentUser) -> MeOut:
    return MeOut(id=user.id, email=user.email, full_name=user.full_name, role=user.role)


@router.put("/me/password", response_model=TokenOut)
@limiter.limit(auth_limit)
async def change_own_password(
    request: Request,
    payload: PasswordChangeIn,
    user: CurrentUser,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> TokenOut:
    """Change son propre mot de passe. Toutes les sessions ouvertes sont fermées ;
    la réponse contient une nouvelle paire de jetons pour la session en cours."""
    if not verify_password(payload.current_password, user.password_hash):
        raise AppError("Mot de passe actuel incorrect.", code="invalid_current_password")
    validate_password(payload.new_password, field="new_password")
    if payload.new_password == payload.current_password:
        raise AppError(
            "Le nouveau mot de passe doit être différent de l'ancien.",
            code="validation_error",
            status_code=422,
            details=[{"field": "new_password", "message": "Identique au mot de passe actuel."}],
        )
    user.password_hash = hash_password(payload.new_password)
    await revoke_user_tokens(user.id)
    if credentials is not None:
        await revoke_token(decode_token(credentials.credentials, ACCESS))
    return _tokens(user)
