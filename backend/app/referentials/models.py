"""Référentiels (F1) : produits, dépôts, stations, cuves, transporteurs, camions, chauffeurs."""

import uuid
from datetime import date
from decimal import Decimal

from geoalchemy2 import Geography
from sqlalchemy import Boolean, Date, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint, Uuid
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base, IdMixin, SoftDeleteMixin, TimestampMixin
from app.core.enums import (
    CarrierType,
    DepotOperator,
    DriverStatus,
    TruckSize,
    TruckStatus,
    enum_col,
)

Liters = Numeric(12, 2)


class Product(Base, IdMixin, TimestampMixin, SoftDeleteMixin):
    __tablename__ = "products"

    code: Mapped[str] = mapped_column(String(32), unique=True)
    label: Mapped[str] = mapped_column(String(120))
    ref_density_15: Mapped[Decimal] = mapped_column(Numeric(6, 4))  # kg/L à 15 °C
    thermal_coeff: Mapped[Decimal] = mapped_column(Numeric(8, 6))  # coefficient de dilatation /°C (RM-12)
    color: Mapped[str] = mapped_column(String(16), default="#888888")


class Depot(Base, IdMixin, TimestampMixin, SoftDeleteMixin):
    __tablename__ = "depots"

    code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(160))
    operator: Mapped[DepotOperator] = mapped_column(enum_col(DepotOperator), default=DepotOperator.SCDP)
    location = mapped_column(Geography("POINT", srid=4326), nullable=False)
    address: Mapped[str | None] = mapped_column(Text)
    # Format : voir app.core.time.opening_windows
    opening_hours: Mapped[dict] = mapped_column(JSONB, default=dict)
    avg_wait_min: Mapped[int | None] = mapped_column(Integer)  # NULL → paramètre par défaut
    max_loadings_per_truck_day: Mapped[int | None] = mapped_column(Integer)  # NULL → paramètre par défaut
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class Station(Base, IdMixin, TimestampMixin, SoftDeleteMixin):
    __tablename__ = "stations"

    code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(160))
    region: Mapped[str | None] = mapped_column(String(80))
    city: Mapped[str | None] = mapped_column(String(80))
    location = mapped_column(Geography("POINT", srid=4326), nullable=False)
    # Horaires de réception. Format : voir app.core.time.opening_windows
    opening_hours: Mapped[dict] = mapped_column(JSONB, default=dict)
    max_truck_size: Mapped[TruckSize] = mapped_column(enum_col(TruckSize), default=TruckSize.LARGE)
    unload_time_min: Mapped[int | None] = mapped_column(Integer)  # NULL → paramètre par défaut
    # Ajout au modèle de la spec : contact du gérant (feuille de route §11, envoi fiche F7.3)
    contact_name: Mapped[str | None] = mapped_column(String(160))
    contact_phone: Mapped[str | None] = mapped_column(String(40))
    contact_email: Mapped[str | None] = mapped_column(String(160))
    active: Mapped[bool] = mapped_column(Boolean, default=True)

    tanks: Mapped[list["StationTank"]] = relationship(
        back_populates="station", cascade="all, delete-orphan", lazy="selectin"
    )


class StationTank(Base, IdMixin, TimestampMixin):
    __tablename__ = "station_tanks"
    __table_args__ = (UniqueConstraint("station_id", "product_id"),)

    station_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stations.id", ondelete="CASCADE"), index=True)
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id"))
    capacity_l: Mapped[Decimal] = mapped_column(Liters)
    safety_stock_l: Mapped[Decimal] = mapped_column(Liters, default=0)

    station: Mapped[Station] = relationship(back_populates="tanks")


class Carrier(Base, IdMixin, TimestampMixin, SoftDeleteMixin):
    __tablename__ = "carriers"

    name: Mapped[str] = mapped_column(String(160), unique=True)
    type: Mapped[CarrierType] = mapped_column(enum_col(CarrierType), default=CarrierType.THIRD_PARTY)
    contact: Mapped[str | None] = mapped_column(Text)


class Truck(Base, IdMixin, TimestampMixin, SoftDeleteMixin):
    __tablename__ = "trucks"

    plate: Mapped[str] = mapped_column(String(32), unique=True)
    carrier_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("carriers.id"))
    size: Mapped[TruckSize] = mapped_column(enum_col(TruckSize))
    total_capacity_l: Mapped[Decimal] = mapped_column(Liters)
    avg_speed_kmh: Mapped[Decimal | None] = mapped_column(Numeric(5, 1))  # NULL → paramètre par défaut
    status: Mapped[TruckStatus] = mapped_column(enum_col(TruckStatus), default=TruckStatus.AVAILABLE)
    cost_per_km: Mapped[int | None] = mapped_column(Integer)  # FCFA/km, indicatif
    notes: Mapped[str | None] = mapped_column(Text)

    compartments: Mapped[list["TruckCompartment"]] = relationship(
        back_populates="truck",
        cascade="all, delete-orphan",
        order_by="TruckCompartment.position",
        lazy="selectin",
    )


class TruckCompartment(Base, IdMixin, TimestampMixin):
    __tablename__ = "truck_compartments"
    __table_args__ = (UniqueConstraint("truck_id", "position"),)

    truck_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("trucks.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(Integer)
    capacity_l: Mapped[Decimal] = mapped_column(Liters)
    # NULL = tous produits (RM-07)
    allowed_product_ids: Mapped[list[uuid.UUID] | None] = mapped_column(ARRAY(Uuid), nullable=True)

    truck: Mapped[Truck] = relationship(back_populates="compartments")


class Driver(Base, IdMixin, TimestampMixin, SoftDeleteMixin):
    __tablename__ = "drivers"

    full_name: Mapped[str] = mapped_column(String(160))
    phone: Mapped[str | None] = mapped_column(String(40))
    license_no: Mapped[str | None] = mapped_column(String(64), unique=True)
    license_expiry: Mapped[date | None] = mapped_column(Date)
    hazmat_cert: Mapped[bool] = mapped_column(Boolean, default=False)
    hazmat_expiry: Mapped[date | None] = mapped_column(Date)
    carrier_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("carriers.id"))
    status: Mapped[DriverStatus] = mapped_column(enum_col(DriverStatus), default=DriverStatus.AVAILABLE)
    default_truck_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("trucks.id"))
