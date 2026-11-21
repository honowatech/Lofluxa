"""Plans de tournées (F4, F5) : plans, tournées, arrêts, livraisons, non servies, violations."""

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    PrimaryKeyConstraint,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base, IdMixin, TimestampMixin
from app.core.enums import (
    PlanKind,
    PlanStatus,
    Severity,
    StopStatus,
    TripStatus,
    UnservedReason,
    enum_col,
)

Liters = Numeric(12, 2)


class Plan(Base, IdMixin, TimestampMixin):
    """Un plan = une version. Les versions successives partagent `root_plan_id` (RM-18)."""

    __tablename__ = "plans"
    __table_args__ = (Index("ix_plans_day", "day"),)

    day: Mapped[date] = mapped_column(Date)
    kind: Mapped[PlanKind] = mapped_column(enum_col(PlanKind), default=PlanKind.COMPUTED)
    status: Mapped[PlanStatus] = mapped_column(enum_col(PlanStatus), default=PlanStatus.DRAFT)
    version: Mapped[int] = mapped_column(Integer, default=1)
    parent_plan_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("plans.id"))
    # Ajouts au modèle de la spec :
    root_plan_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("plans.id"), index=True)  # lignée
    label: Mapped[str | None] = mapped_column(String(160))
    approximate: Mapped[bool] = mapped_column(Boolean, default=False)  # matrice de repli haversine (§7.2)
    metrics: Mapped[dict | None] = mapped_column(JSONB)  # métriques agrégées (§7.4, F8.4)
    solver_log: Mapped[dict | None] = mapped_column(JSONB)  # journal de résolution (§7.4)
    prep_time_s: Mapped[int | None] = mapped_column(Integer)  # temps de préparation saisi (F8.4)
    # Reproductibilité (F4.6)
    engine_version: Mapped[str | None] = mapped_column(String(64))
    params_snapshot: Mapped[dict | None] = mapped_column(JSONB)
    computed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    computed_in_ms: Mapped[int | None] = mapped_column(Integer)

    trips: Mapped[list["Trip"]] = relationship(
        back_populates="plan", cascade="all, delete-orphan", order_by="Trip.seq"
    )
    unserved: Mapped[list["UnservedOrder"]] = relationship(
        back_populates="plan", cascade="all, delete-orphan"
    )
    violations: Mapped[list["ConstraintViolation"]] = relationship(
        back_populates="plan", cascade="all, delete-orphan"
    )


class Trip(Base, IdMixin, TimestampMixin):
    __tablename__ = "trips"

    plan_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("plans.id", ondelete="CASCADE"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    truck_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("trucks.id"))
    # NULL toléré en brouillon (chauffeur non trouvé) → violation RM-01 bloquante à la publication.
    driver_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("drivers.id"))
    depot_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("depots.id"))
    # Ajout : arrivée prévue au dépôt pour chargement (avant attente + chargement).
    planned_start_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    planned_depart_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    planned_return_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    distance_m: Mapped[int] = mapped_column(Integer, default=0)
    duration_s: Mapped[int] = mapped_column(Integer, default=0)
    locked: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[TripStatus] = mapped_column(enum_col(TripStatus), default=TripStatus.PLANNED)
    actual_depart_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    actual_return_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    actual_distance_m: Mapped[int | None] = mapped_column(Integer)

    plan: Mapped[Plan] = relationship(back_populates="trips")
    stops: Mapped[list["Stop"]] = relationship(
        back_populates="trip", cascade="all, delete-orphan", order_by="Stop.seq"
    )
    compartment_loads: Mapped[list["TripCompartmentLoad"]] = relationship(
        back_populates="trip", cascade="all, delete-orphan"
    )


class TripCompartmentLoad(Base, IdMixin, TimestampMixin):
    __tablename__ = "trip_compartment_loads"

    trip_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("trips.id", ondelete="CASCADE"), index=True)
    compartment_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("truck_compartments.id"))
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id"))
    planned_l: Mapped[Decimal] = mapped_column(Liters)

    trip: Mapped[Trip] = relationship(back_populates="compartment_loads")


class Stop(Base, IdMixin, TimestampMixin):
    __tablename__ = "stops"
    __table_args__ = (Index("ix_stops_trip_seq", "trip_id", "seq"),)

    trip_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("trips.id", ondelete="CASCADE"))
    seq: Mapped[int] = mapped_column(Integer)
    station_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stations.id"))
    planned_arrival_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    planned_departure_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    distance_from_prev_m: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[StopStatus] = mapped_column(enum_col(StopStatus), default=StopStatus.PENDING)
    actual_arrival_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    actual_departure_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    skip_reason: Mapped[str | None] = mapped_column(Text)

    trip: Mapped[Trip] = relationship(back_populates="stops")
    deliveries: Mapped[list["StopDelivery"]] = relationship(
        back_populates="stop", cascade="all, delete-orphan"
    )


class StopDelivery(Base, IdMixin, TimestampMixin):
    __tablename__ = "stop_deliveries"

    stop_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stops.id", ondelete="CASCADE"), index=True)
    order_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("orders.id"), index=True)
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id"))
    planned_l: Mapped[Decimal] = mapped_column(Liters)
    actual_l: Mapped[Decimal | None] = mapped_column(Liters)

    stop: Mapped[Stop] = relationship(back_populates="deliveries")


class UnservedOrder(Base, IdMixin, TimestampMixin):
    __tablename__ = "unserved_orders"

    plan_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("plans.id", ondelete="CASCADE"), index=True)
    order_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("orders.id"))
    reason_code: Mapped[UnservedReason] = mapped_column(enum_col(UnservedReason))
    reason_text: Mapped[str | None] = mapped_column(Text)

    plan: Mapped[Plan] = relationship(back_populates="unserved")


class ConstraintViolation(Base, IdMixin, TimestampMixin):
    __tablename__ = "constraint_violations"

    plan_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("plans.id", ondelete="CASCADE"), index=True)
    trip_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("trips.id", ondelete="CASCADE"))
    stop_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("stops.id", ondelete="CASCADE"))
    rule_code: Mapped[str] = mapped_column(String(16))  # RM-xx
    severity: Mapped[Severity] = mapped_column(enum_col(Severity))
    message: Mapped[str] = mapped_column(Text)

    plan: Mapped[Plan] = relationship(back_populates="violations")


class DistanceCache(Base):
    """Cache des distances/durées OSRM. Clé = hash des coordonnées arrondies à 5 décimales (§7.2)."""

    __tablename__ = "distance_cache"
    __table_args__ = (PrimaryKeyConstraint("origin_hash", "dest_hash"),)

    origin_hash: Mapped[str] = mapped_column(String(40))
    dest_hash: Mapped[str] = mapped_column(String(40))
    distance_m: Mapped[int] = mapped_column(Integer)
    duration_s: Mapped[int] = mapped_column(Integer)
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
