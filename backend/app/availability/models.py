"""Disponibilité du jour (F2) : stocks dépôt, statuts jour des ressources, affectation du jour."""

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Boolean, CheckConstraint, Date, DateTime, ForeignKey, Numeric, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, IdMixin, TimestampMixin


class DailyDepotStock(Base, IdMixin, TimestampMixin):
    """Stock disponible par (dépôt, produit, jour). Historisé : la saisie la plus récente
    (`entered_at` max) fait foi, les précédentes sont conservées (F2.1)."""

    __tablename__ = "daily_depot_stocks"
    __table_args__ = (UniqueConstraint("depot_id", "product_id", "day", "entered_at"),)

    depot_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("depots.id"), index=True)
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id"))
    day: Mapped[date] = mapped_column(Date, index=True)
    available_l: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    entered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    entered_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))


class DailyResourceStatus(Base, IdMixin, TimestampMixin):
    """Disponibilité d'un camion OU d'un chauffeur pour le jour J (F2.2, F2.3).

    Absence de ligne = disponible si le statut du référentiel le permet."""

    __tablename__ = "daily_resource_status"
    __table_args__ = (
        CheckConstraint("truck_id IS NOT NULL OR driver_id IS NOT NULL", name="ck_resource_set"),
        UniqueConstraint("day", "truck_id"),
        UniqueConstraint("day", "driver_id"),
    )

    day: Mapped[date] = mapped_column(Date, index=True)
    truck_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("trucks.id"))
    driver_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("drivers.id"))
    available: Mapped[bool] = mapped_column(Boolean, default=True)
    reason: Mapped[str | None] = mapped_column(Text)


class DailyTruckDriver(Base, IdMixin, TimestampMixin):
    """Affectation chauffeur ↔ camion pour le jour J (F2.4).

    Ajout au modèle de la spec (qui ne prévoit pas de table pour F2.4). Absence de ligne =
    le camion habituel du chauffeur (`drivers.default_truck_id`) s'applique."""

    __tablename__ = "daily_truck_drivers"
    __table_args__ = (UniqueConstraint("day", "truck_id"), UniqueConstraint("day", "driver_id"))

    day: Mapped[date] = mapped_column(Date, index=True)
    truck_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("trucks.id"))
    driver_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("drivers.id"))
