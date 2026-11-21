"""Schémas du journal d'audit (F9.3)."""

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel


class AuditEntryOut(BaseModel):
    id: uuid.UUID
    table_name: str
    row_id: str
    action: str  # insert | update | delete
    before: dict[str, Any] | None
    after: dict[str, Any] | None
    actor_id: uuid.UUID | None
    actor_name: str | None
    actor_email: str | None
    at: datetime
