"""Dépendances FastAPI communes : session, utilisateur courant, contrôle de rôle, pagination.

Usage dans un routeur :

    from app.core.deps import CurrentUser, SessionDep, require_roles
    from app.core.enums import Role

    @router.post("/orders", dependencies=[Depends(require_roles(Role.DISPATCHER))])
    async def create_order(payload: OrderIn, session: SessionDep, user: CurrentUser): ...

`admin` passe tous les contrôles de rôle.
"""

import uuid
from typing import Annotated

from fastapi import Depends, Query
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.context import current_user_id
from app.core.db import get_session
from app.core.enums import Role
from app.core.errors import ForbiddenError, UnauthorizedError
from app.core.security import ACCESS, decode_token
from app.users.models import User

SessionDep = Annotated[AsyncSession, Depends(get_session)]

_bearer = HTTPBearer(auto_error=False)


async def get_current_user(
    session: SessionDep,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> User:
    if credentials is None:
        raise UnauthorizedError("Authentification requise.")
    payload = decode_token(credentials.credentials, ACCESS)
    user = await session.get(User, uuid.UUID(payload["sub"]))
    if user is None or not user.active:
        raise UnauthorizedError("Compte inconnu ou désactivé.")
    current_user_id.set(user.id)
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]

# Rôles pouvant tout consulter (lecture seule pour `manager`).
ALL_ROLES = (Role.DISPATCHER, Role.FLEET, Role.SUPPLY, Role.MANAGER, Role.ADMIN)


def require_roles(*roles: Role):
    """Dépendance : l'utilisateur doit avoir l'un des rôles donnés (`admin` est toujours accepté)."""
    allowed = {Role(r) for r in roles} | {Role.ADMIN}

    async def _check(user: CurrentUser) -> User:
        if user.role not in allowed:
            raise ForbiddenError("Votre rôle ne permet pas cette action.")
        return user

    return _check


class PageParams(BaseModel):
    limit: int = 50
    offset: int = 0


def page_params(
    limit: Annotated[int, Query(ge=1, le=500)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> PageParams:
    return PageParams(limit=limit, offset=offset)


PageDep = Annotated[PageParams, Depends(page_params)]


class Page[T](BaseModel):
    """Enveloppe de liste paginée commune à toutes les ressources."""

    items: list[T]
    total: int
    limit: int
    offset: int
