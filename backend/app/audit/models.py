"""Journal d'audit (F9.3)."""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Index, String, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, IdMixin


class AuditLog(Base, IdMixin):
    __tablename__ = "audit_log"
    __table_args__ = (Index("ix_audit_table_row", "table_name", "row_id"),)

    table_name: Mapped[str] = mapped_column(String(64))
    row_id: Mapped[str] = mapped_column(String(64))
    action: Mapped[str] = mapped_column(String(16))  # insert | update | delete
    before: Mapped[dict | None] = mapped_column(JSONB)
    after: Mapped[dict | None] = mapped_column(JSONB)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
