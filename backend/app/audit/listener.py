"""Journal d'audit automatique (F9.3) et renseignement de `created_by`.

Toute écriture ORM sur les tables auditées produit une ligne `audit_log` dans la même transaction.
Attention : les écritures en masse (`session.execute(update(...))`) contournent l'ORM et ne sont
donc pas auditées — sur les tables auditées, modifier les objets via la session.
"""

import uuid
from datetime import date, datetime, time
from decimal import Decimal
from enum import Enum
from typing import Any

from sqlalchemy import event, inspect
from sqlalchemy.orm import Session

from app.audit.models import AuditLog
from app.core.context import current_user_id
from app.core.time import utcnow

AUDITED_TABLES = {"plans", "trips", "loadings", "loading_lines", "daily_depot_stocks", "settings"}


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, bool | int | float | str):
        return value
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime | date | time):
        return value.isoformat()
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, list | tuple | set | frozenset):
        return [_jsonable(v) for v in value]
    return str(value)


def _row_id(obj: Any) -> str:
    identity = inspect(obj).mapper.primary_key_from_instance(obj)
    return "/".join(str(part) for part in identity)


def _snapshot(obj: Any) -> dict[str, Any]:
    state = inspect(obj)
    return {col.key: _jsonable(getattr(obj, col.key)) for col in state.mapper.column_attrs}


def _changes(obj: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    before: dict[str, Any] = {}
    after: dict[str, Any] = {}
    state = inspect(obj)
    for col in state.mapper.column_attrs:
        history = state.attrs[col.key].history
        if history.has_changes():
            before[col.key] = _jsonable(history.deleted[0]) if history.deleted else None
            after[col.key] = _jsonable(history.added[0]) if history.added else None
    return before, after


@event.listens_for(Session, "before_flush")
def _audit_before_flush(session: Session, flush_context: Any, instances: Any) -> None:
    actor = current_user_id.get()
    # Horloge réelle (et non l'heure de début de transaction) : l'ordre des écritures est conservé.
    now = utcnow()
    entries: list[AuditLog] = []

    for obj in list(session.new):
        if isinstance(obj, AuditLog):
            continue
        # Identifiant généré côté application avant l'écriture, pour pouvoir le journaliser.
        mapper = inspect(obj).mapper
        if "id" in mapper.columns and getattr(obj, "id", None) is None and mapper.columns["id"].default:
            obj.id = mapper.columns["id"].default.arg(None)
        if hasattr(obj, "created_by") and obj.created_by is None and actor is not None:
            obj.created_by = actor
        if obj.__tablename__ in AUDITED_TABLES:
            entries.append(
                AuditLog(
                    table_name=obj.__tablename__,
                    row_id=_row_id(obj),
                    action="insert",
                    after=_snapshot(obj),
                    actor_id=actor,
                    at=now,
                )
            )

    for obj in list(session.dirty):
        if obj.__tablename__ not in AUDITED_TABLES or not session.is_modified(obj):
            continue
        before, after = _changes(obj)
        if after:
            entries.append(
                AuditLog(
                    table_name=obj.__tablename__,
                    row_id=_row_id(obj),
                    action="update",
                    before=before,
                    after=after,
                    actor_id=actor,
                    at=now,
                )
            )

    for obj in list(session.deleted):
        if obj.__tablename__ in AUDITED_TABLES:
            entries.append(
                AuditLog(
                    table_name=obj.__tablename__,
                    row_id=_row_id(obj),
                    action="delete",
                    before=_snapshot(obj),
                    actor_id=actor,
                    at=now,
                )
            )

    session.add_all(entries)
