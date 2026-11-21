"""Consultation du journal d'audit (F9.3) — rôles `admin` et `manager`."""

import uuid
from datetime import date, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select

from app.audit.models import AuditLog
from app.audit.schemas import AuditEntryOut
from app.core.deps import Page, PageDep, SessionDep, require_roles
from app.core.enums import Role
from app.core.settings_store import get_setting
from app.core.time import local_midnight_utc
from app.users.models import User

router = APIRouter(tags=["audit"])


@router.get(
    "/audit",
    response_model=Page[AuditEntryOut],
    dependencies=[Depends(require_roles(Role.MANAGER))],
)
async def list_audit(
    session: SessionDep,
    page: PageDep,
    table: Annotated[str | None, Query(description="Nom de la table (plans, trips, settings…)")] = None,
    row_id: Annotated[str | None, Query(description="Identifiant de la ligne concernée")] = None,
    actor_id: Annotated[uuid.UUID | None, Query(description="Auteur de la modification")] = None,
    action: Annotated[str | None, Query(pattern="^(insert|update|delete)$")] = None,
    date_from: Annotated[date | None, Query(description="Premier jour inclus (heure locale)")] = None,
    date_to: Annotated[date | None, Query(description="Dernier jour inclus (heure locale)")] = None,
) -> Page[AuditEntryOut]:
    """Écritures journalisées, de la plus récente à la plus ancienne."""
    conditions = []
    if table:
        conditions.append(AuditLog.table_name == table)
    if row_id:
        conditions.append(AuditLog.row_id == row_id)
    if actor_id is not None:
        conditions.append(AuditLog.actor_id == actor_id)
    if action:
        conditions.append(AuditLog.action == action)
    if date_from is not None or date_to is not None:
        # Les jours sont ceux du fuseau d'affichage (RM-20) ; le journal est stocké en UTC.
        tz_name = await get_setting(session, "timezone")
        if date_from is not None:
            conditions.append(AuditLog.at >= local_midnight_utc(date_from, tz_name))
        if date_to is not None:
            conditions.append(AuditLog.at < local_midnight_utc(date_to + timedelta(days=1), tz_name))

    total = (await session.execute(select(func.count(AuditLog.id)).where(*conditions))).scalar_one()
    rows = (
        await session.execute(
            select(AuditLog, User.full_name, User.email)
            .outerjoin(User, User.id == AuditLog.actor_id)
            .where(*conditions)
            .order_by(AuditLog.at.desc(), AuditLog.id.desc())
            .limit(page.limit)
            .offset(page.offset)
        )
    ).all()
    items = [
        AuditEntryOut(
            id=entry.id,
            table_name=entry.table_name,
            row_id=entry.row_id,
            action=entry.action,
            before=entry.before,
            after=entry.after,
            actor_id=entry.actor_id,
            actor_name=full_name,
            actor_email=email,
            at=entry.at,
        )
        for entry, full_name, email in rows
    ]
    return Page[AuditEntryOut](items=items, total=total, limit=page.limit, offset=page.offset)
