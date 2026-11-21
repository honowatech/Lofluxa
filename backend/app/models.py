"""Point d'import unique de tous les modèles (Alembic, tests, relations).

Tout nouveau fichier `models.py` d'un module doit être importé ici.
"""

from app.admin.models import Setting
from app.audit.models import AuditLog
from app.availability.models import DailyDepotStock, DailyResourceStatus, DailyTruckDriver
from app.events.models import Event
from app.imports.models import ImportBatch
from app.loading.models import Loading, LoadingLine
from app.orders.models import Order
from app.planning.models import (
    ConstraintViolation,
    DistanceCache,
    Plan,
    Stop,
    StopDelivery,
    Trip,
    TripCompartmentLoad,
    UnservedOrder,
)
from app.referentials.models import (
    Carrier,
    Depot,
    Driver,
    Product,
    Station,
    StationTank,
    Truck,
    TruckCompartment,
)
from app.users.models import User

__all__ = [
    "AuditLog",
    "Carrier",
    "ConstraintViolation",
    "DailyDepotStock",
    "DailyResourceStatus",
    "DailyTruckDriver",
    "Depot",
    "DistanceCache",
    "Driver",
    "Event",
    "ImportBatch",
    "Loading",
    "LoadingLine",
    "Order",
    "Plan",
    "Product",
    "Setting",
    "Station",
    "StationTank",
    "Stop",
    "StopDelivery",
    "Trip",
    "TripCompartmentLoad",
    "Truck",
    "TruckCompartment",
    "UnservedOrder",
    "User",
]
