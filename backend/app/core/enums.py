"""Énumérations partagées (stockées en VARCHAR, sans type ENUM natif PostgreSQL).

Pour ajouter une valeur : l'ajouter ici, aucune migration n'est nécessaire.
"""

from enum import StrEnum

from sqlalchemy import Enum as SAEnum


def enum_col(enum_cls: type[StrEnum]) -> SAEnum:
    """Type de colonne pour une StrEnum : VARCHAR(32) contenant la *valeur* de l'énumération."""
    return SAEnum(
        enum_cls,
        native_enum=False,
        create_constraint=False,
        length=32,
        values_callable=lambda e: [m.value for m in e],
        validate_strings=True,
    )


class Role(StrEnum):
    DISPATCHER = "dispatcher"
    FLEET = "fleet"
    SUPPLY = "supply"
    MANAGER = "manager"
    ADMIN = "admin"


class DepotOperator(StrEnum):
    SCDP = "scdp"
    INTERNAL = "internal"
    THIRD_PARTY = "third_party"


class CarrierType(StrEnum):
    OWN = "own"
    THIRD_PARTY = "third_party"


class TruckSize(StrEnum):
    SMALL = "small"
    MEDIUM = "medium"
    LARGE = "large"

    @property
    def rank(self) -> int:
        """Ordre des gabarits : small < medium < large (RM-09)."""
        return {"small": 0, "medium": 1, "large": 2}[self.value]


class TruckStatus(StrEnum):
    AVAILABLE = "available"
    MAINTENANCE = "maintenance"
    BROKEN = "broken"
    RESERVED = "reserved"


class DriverStatus(StrEnum):
    AVAILABLE = "available"
    REST = "rest"
    LEAVE = "leave"
    SICK = "sick"


class OrderPriority(StrEnum):
    NORMAL = "normal"
    URGENT = "urgent"


class OrderStatus(StrEnum):
    DRAFT = "draft"
    CONFIRMED = "confirmed"
    PLANNED = "planned"
    LOADED = "loaded"
    DELIVERED = "delivered"
    CANCELLED = "cancelled"
    POSTPONED = "postponed"


class OrderSource(StrEnum):
    MANUAL = "manual"
    IMPORT = "import"


class PlanKind(StrEnum):
    COMPUTED = "computed"
    MANUAL_REFERENCE = "manual_reference"
    REPLAY = "replay"


class PlanStatus(StrEnum):
    DRAFT = "draft"
    PUBLISHED = "published"
    ARCHIVED = "archived"


class TripStatus(StrEnum):
    PLANNED = "planned"
    AT_DEPOT = "at_depot"
    LOADED = "loaded"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"


class StopStatus(StrEnum):
    PENDING = "pending"
    DELIVERED = "delivered"
    SKIPPED = "skipped"


class UnservedReason(StrEnum):
    NO_TRUCK = "no_truck"  # aucun camion affectable / capacité de flotte épuisée
    NO_DRIVER = "no_driver"
    DEPOT_STOCK = "depot_stock"  # produit indisponible au dépôt (RM-08)
    TIME_WINDOW = "time_window"  # fenêtre horaire impossible (RM-10)
    TRUCK_SIZE = "truck_size"  # aucun camion au gabarit accepté par la station (RM-09)
    COMPARTMENT = "compartment"  # pas de compartiment compatible (RM-05/06/07)
    SERVICE_DURATION = "service_duration"  # durée max de service (RM-11)
    OTHER = "other"


class Severity(StrEnum):
    BLOCKING = "blocking"
    WARNING = "warning"


class EventType(StrEnum):
    TRUCK_BREAKDOWN = "truck_breakdown"
    DRIVER_UNAVAILABLE = "driver_unavailable"
    PRODUCT_SHORTAGE = "product_shortage"
    MANUAL_EDIT = "manual_edit"
    PUBLISH = "publish"
    REPLAN = "replan"
    LOADING_RECORDED = "loading_recorded"
    DELIVERY_RECORDED = "delivery_recorded"


class ImportKind(StrEnum):
    STATIONS = "stations"
    TRUCKS = "trucks"
    DRIVERS = "drivers"
    DEPOTS = "depots"
    ORDERS = "orders"
    REFERENCE_DAY = "reference_day"


class ImportStatus(StrEnum):
    PREVIEWED = "previewed"
    APPLIED = "applied"
    REJECTED = "rejected"
