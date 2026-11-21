"""Commandes du jour (F3)."""

import uuid
from datetime import date, time
from decimal import Decimal

from sqlalchemy import Date, ForeignKey, Index, Numeric, Text, Time
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, IdMixin, TimestampMixin
from app.core.enums import OrderPriority, OrderSource, OrderStatus, enum_col


class Order(Base, IdMixin, TimestampMixin):
    __tablename__ = "orders"
    __table_args__ = (Index("ix_orders_day_status", "day", "status"),)

    day: Mapped[date] = mapped_column(Date)
    station_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stations.id"), index=True)
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id"))
    requested_l: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    priority: Mapped[OrderPriority] = mapped_column(enum_col(OrderPriority), default=OrderPriority.NORMAL)
    # Fenêtre de livraison souhaitée, en heure locale (Africa/Douala) du jour J.
    window_start: Mapped[time | None] = mapped_column(Time)
    window_end: Mapped[time | None] = mapped_column(Time)
    comment: Mapped[str | None] = mapped_column(Text)
    status: Mapped[OrderStatus] = mapped_column(enum_col(OrderStatus), default=OrderStatus.DRAFT)
    source: Mapped[OrderSource] = mapped_column(enum_col(OrderSource), default=OrderSource.MANUAL)
    import_batch_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("import_batches.id"))
