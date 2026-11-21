"""Événements du jour (F6) : journal horodaté."""

import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, Index
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, IdMixin, TimestampMixin
from app.core.enums import EventType, enum_col


class Event(Base, IdMixin, TimestampMixin):
    __tablename__ = "events"
    __table_args__ = (Index("ix_events_day_occurred", "day", "occurred_at"),)

    day: Mapped[date] = mapped_column(Date)
    plan_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("plans.id", ondelete="SET NULL"))
    trip_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("trips.id", ondelete="SET NULL"))
    type: Mapped[EventType] = mapped_column(enum_col(EventType))
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
