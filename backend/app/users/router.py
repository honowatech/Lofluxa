"""Gestion des utilisateurs (F9.1) — réservée au rôle `admin`.

Pas d'inscription libre : les comptes sont créés ici avec un mot de passe initial. Un compte n'est jamais
supprimé (ses actions restent référencées dans l'historique) : il est désactivé.
"""

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditLog
from app.auth.revocation import revoke_user_tokens
from app.core.deps import CurrentUser, Page, PageDep, SessionDep, require_roles
from app.core.enums import Role
from app.core.errors import ConflictError, NotFoundError
from app.core.security import hash_password
from app.users.models import User
from app.users.passwords import validate_password
from app.users.schemas import PasswordResetIn, UserCreate, UserOut, UserUpdate

router = APIRouter(tags=["utilisateurs"], dependencies=[Depends(require_roles(Role.ADMIN))])


def _trace(session: AsyncSession, actor: User, user: User, action: str, before: Any, after: Any) -> None:
    """Trace l'opération dans le journal d'audit (jamais de mot de passe ni de hachage)."""
    session.add(
        AuditLog(
            table_name=User.__tablename__,
            row_id=str(user.id),
            action=action,
            before=before,
            after=after,
            actor_id=actor.id,
        )
    )


async def _get_user(session: AsyncSession, user_id: uuid.UUID) -> User:
    user = await session.get(User, user_id)
    if user is None:
        raise NotFoundError("Utilisateur introuvable.")
    return user


async def _ensure_email_free(
    session: AsyncSession, email: str, *, except_id: uuid.UUID | None = None
) -> None:
    query = select(User.id).where(User.email == email)
    if except_id is not None:
        query = query.where(User.id != except_id)
    if (await session.execute(query)).first() is not None:
        raise ConflictError(
            "Un compte existe déjà avec cette adresse e-mail.",
            code="email_taken",
            details=[{"field": "email", "message": "Adresse e-mail déjà utilisée."}],
        )


async def _deactivate(session: AsyncSession, actor: User, user: User) -> None:
    if user.id == actor.id:
        raise ConflictError("Vous ne pouvez pas désactiver votre propre compte.", code="self_deactivation")
    if user.active:
        user.active = False
        _trace(session, actor, user, "update", {"active": True}, {"active": False})
        await revoke_user_tokens(user.id)


@router.get("/users", response_model=Page[UserOut])
async def list_users(
    session: SessionDep,
    page: PageDep,
    role: Role | None = None,
    active: bool | None = None,
    q: Annotated[str | None, Query(description="Recherche dans le nom et l'e-mail")] = None,
) -> Page[UserOut]:
    query = select(User)
    if role is not None:
        query = query.where(User.role == role)
    if active is not None:
        query = query.where(User.active.is_(active))
    if q and q.strip():
        pattern = f"%{q.strip().lower()}%"
        query = query.where(or_(func.lower(User.full_name).like(pattern), User.email.like(pattern)))
    total = (await session.execute(select(func.count()).select_from(query.subquery()))).scalar_one()
    rows = (
        (
            await session.execute(
                query.order_by(User.full_name, User.email).limit(page.limit).offset(page.offset)
            )
        )
        .scalars()
        .all()
    )
    return Page[UserOut](
        items=[UserOut.model_validate(row) for row in rows], total=total, limit=page.limit, offset=page.offset
    )


@router.post("/users", response_model=UserOut, status_code=201)
async def create_user(payload: UserCreate, session: SessionDep, actor: CurrentUser) -> User:
    email = payload.email.lower()
    validate_password(payload.password)
    await _ensure_email_free(session, email)
    user = User(
        email=email,
        password_hash=hash_password(payload.password),
        full_name=payload.full_name.strip(),
        role=payload.role,
        active=payload.active,
    )
    session.add(user)
    await session.flush()
    after = {"email": user.email, "full_name": user.full_name, "role": user.role.value, "active": user.active}
    _trace(session, actor, user, "insert", None, after)
    await session.flush()
    await session.refresh(user)
    return user


@router.get("/users/{user_id}", response_model=UserOut)
async def get_user(user_id: uuid.UUID, session: SessionDep) -> User:
    return await _get_user(session, user_id)


@router.put("/users/{user_id}", response_model=UserOut)
@router.patch("/users/{user_id}", response_model=UserOut)
async def update_user(
    user_id: uuid.UUID, payload: UserUpdate, session: SessionDep, actor: CurrentUser
) -> User:
    """Modifie le nom, l'e-mail, le rôle ou l'état (actif / désactivé) d'un compte."""
    user = await _get_user(session, user_id)
    changes = payload.model_dump(exclude_unset=True, exclude_none=True)
    if "email" in changes:
        changes["email"] = changes["email"].lower()
    if "full_name" in changes:
        changes["full_name"] = changes["full_name"].strip()
    changes = {field: value for field, value in changes.items() if getattr(user, field) != value}
    if not changes:
        return user

    if user.id == actor.id:
        if changes.get("active") is False:
            raise ConflictError(
                "Vous ne pouvez pas désactiver votre propre compte.", code="self_deactivation"
            )
        if "role" in changes:
            raise ConflictError("Vous ne pouvez pas modifier votre propre rôle.", code="self_role_change")
    if "email" in changes:
        await _ensure_email_free(session, changes["email"], except_id=user.id)

    before = {field: _plain(getattr(user, field)) for field in changes}
    for field, value in changes.items():
        setattr(user, field, value)
    _trace(session, actor, user, "update", before, {field: _plain(value) for field, value in changes.items()})
    if changes.get("active") is False:
        await revoke_user_tokens(user.id)
    await session.flush()
    await session.refresh(user)
    return user


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(user_id: uuid.UUID, session: SessionDep, actor: CurrentUser) -> None:
    """Désactive le compte (un compte n'est jamais supprimé)."""
    await _deactivate(session, actor, await _get_user(session, user_id))


@router.post("/users/{user_id}/deactivate", response_model=UserOut)
async def deactivate_user(user_id: uuid.UUID, session: SessionDep, actor: CurrentUser) -> User:
    user = await _get_user(session, user_id)
    await _deactivate(session, actor, user)
    await session.flush()
    await session.refresh(user)
    return user


@router.post("/users/{user_id}/activate", response_model=UserOut)
async def activate_user(user_id: uuid.UUID, session: SessionDep, actor: CurrentUser) -> User:
    user = await _get_user(session, user_id)
    if not user.active:
        user.active = True
        _trace(session, actor, user, "update", {"active": False}, {"active": True})
        await session.flush()
        await session.refresh(user)
    return user


@router.post("/users/{user_id}/reset-password", status_code=204)
async def reset_password(
    user_id: uuid.UUID, payload: PasswordResetIn, session: SessionDep, actor: CurrentUser
) -> None:
    """Remplace le mot de passe d'un autre compte et ferme toutes ses sessions."""
    user = await _get_user(session, user_id)
    if user.id == actor.id:
        raise ConflictError(
            "Pour votre propre compte, utilisez le changement de mot de passe (PUT /me/password).",
            code="self_password_reset",
        )
    validate_password(payload.password)
    user.password_hash = hash_password(payload.password)
    _trace(session, actor, user, "update", None, {"password": "réinitialisé"})
    await revoke_user_tokens(user.id)


def _plain(value: Any) -> Any:
    return value.value if isinstance(value, Role) else value
