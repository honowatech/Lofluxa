"""Chargement au dépôt (F7)."""

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base, IdMixin, TimestampMixin

Liters = Numeric(12, 2)


class Loading(Base, IdMixin, TimestampMixin):
    __tablename__ = "loadings"

    trip_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("trips.id", ondelete="CASCADE"), unique=True)
    depot_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("depots.id"))
    arrived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    depot_ticket_no: Mapped[str | None] = mapped_column(String(64))
    entered_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))

    lines: Mapped[list["LoadingLine"]] = relationship(
        back_populates="loading", cascade="all, delete-orphan", lazy="selectin"
    )


class LoadingLine(Base, IdMixin, TimestampMixin):
    __tablename__ = "loading_lines"

    loading_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("loadings.id", ondelete="CASCADE"), index=True)
    compartment_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("truck_compartments.id"))
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id"))
    observed_l: Mapped[Decimal] = mapped_column(Liters)
    observed_temp_c: Mapped[Decimal] = mapped_column(Numeric(5, 2))
    # Stockée et affichée, mais hors calcul dans le MVP (RM-12).
    observed_density: Mapped[Decimal | None] = mapped_column(Numeric(6, 4))
    # Calculée par l'application à l'enregistrement (RM-12), pas par la base.
    volume_15_l: Mapped[Decimal] = mapped_column(Liters)
    planned_l: Mapped[Decimal | None] = mapped_column(Liters)

    loading: Mapped[Loading] = relationship(back_populates="lines")
