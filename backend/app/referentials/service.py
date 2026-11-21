"""Aides communes aux référentiels : lecture, unicité, cohérence, sérialisation.

Utilisées par le routeur des référentiels et par les imports (`app/imports/`), pour que les mêmes
contrôles s'appliquent quelle que soit la porte d'entrée.
"""

import uuid
from collections.abc import Iterable, Sequence
from typing import Any

from sqlalchemy import Select, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import PageParams
from app.core.errors import ConflictError, NotFoundError, ValidationAppError
from app.core.geo import latlon
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
from app.referentials.schemas import (
    CarrierOut,
    CompartmentOut,
    DepotOut,
    DriverOut,
    ProductOut,
    StationOut,
    TankOut,
    TruckOut,
)

# Écart toléré (litres) entre capacité totale et somme des compartiments : arrondi au centième.
_ROUNDING_L = 0.01


async def get_active(session: AsyncSession, model: type, obj_id: uuid.UUID, missing: str) -> Any:
    """Charge un référentiel non supprimé, ou lève 404 avec le message donné."""
    obj = await session.get(model, obj_id)
    if obj is None or getattr(obj, "deleted_at", None) is not None:
        raise NotFoundError(missing)
    return obj


async def paginate(session: AsyncSession, stmt: Select, page: PageParams) -> tuple[Sequence[Any], int]:
    total = (
        await session.execute(select(func.count()).select_from(stmt.order_by(None).subquery()))
    ).scalar_one()
    rows = (await session.execute(stmt.limit(page.limit).offset(page.offset))).scalars().all()
    return rows, total


async def ensure_unique(
    session: AsyncSession,
    model: type,
    column: Any,
    value: Any,
    *,
    exclude_id: uuid.UUID | None,
    what: str,
    field: str,
) -> None:
    """409 lisible si `value` est déjà pris, y compris par un élément supprimé (contrainte globale)."""
    if value is None:
        return
    stmt = select(model).where(func.lower(column) == str(value).lower())
    if exclude_id is not None:
        stmt = stmt.where(model.id != exclude_id)
    other = (await session.execute(stmt)).scalars().first()
    if other is None:
        return
    if getattr(other, "deleted_at", None) is not None:
        message = (
            f"{what} « {value} » est déjà utilisé par un élément supprimé. "
            "Choisissez une autre valeur, ou réactivez l'élément par un import."
        )
    else:
        message = f"{what} « {value} » est déjà utilisé."
    raise ConflictError(
        message, code="duplicate", details=[{"field": field, "value": value, "existing_id": str(other.id)}]
    )


async def flush_or_conflict(session: AsyncSession, message: str) -> None:
    """Écrit en base ; une violation de contrainte devient un 409 lisible au lieu d'une erreur 500."""
    try:
        async with session.begin_nested():
            await session.flush()
    except IntegrityError as exc:
        raise ConflictError(message) from exc


async def products_by_id(session: AsyncSession) -> dict[uuid.UUID, Product]:
    """Tous les produits (supprimés compris, pour libeller les données historiques)."""
    return {p.id: p for p in (await session.execute(select(Product))).scalars()}


async def ensure_products_exist(
    products: dict[uuid.UUID, Product], ids: Iterable[uuid.UUID], field: str
) -> None:
    unknown = [str(pid) for pid in ids if pid not in products or products[pid].deleted_at is not None]
    if unknown:
        raise ValidationAppError(
            "Produit inconnu : " + ", ".join(unknown) + ".",
            details=[{"field": field, "value": pid, "message": "Produit inconnu."} for pid in unknown],
        )


def check_tank(capacity_l: float, safety_stock_l: float) -> None:
    if safety_stock_l > capacity_l:
        raise ValidationAppError(
            f"Le stock de sécurité ({safety_stock_l:g} L) dépasse la capacité de la cuve ({capacity_l:g} L).",
            details=[{"field": "safety_stock_l", "value": safety_stock_l}],
        )


def capacity_gap_message(total_l: float, compartment_caps: Iterable[float]) -> str | None:
    """Message si la somme des compartiments dépasse la capacité totale du camion, sinon `None`."""
    total_compartments = sum(float(c) for c in compartment_caps)
    if total_compartments > float(total_l) + _ROUNDING_L:
        return (
            f"La somme des capacités des compartiments ({total_compartments:g} L) dépasse "
            f"la capacité totale du camion ({float(total_l):g} L)."
        )
    return None


def check_truck_capacity(total_l: float, compartment_caps: Iterable[float]) -> None:
    message = capacity_gap_message(total_l, compartment_caps)
    if message:
        raise ValidationAppError(message, details=[{"field": "total_capacity_l", "value": float(total_l)}])


def check_allowed_products(allowed: list[uuid.UUID] | None) -> list[uuid.UUID] | None:
    if allowed is not None and len(allowed) == 0:
        raise ValidationAppError(
            "Liste de produits autorisés vide : indiquez null pour « tous produits ».",
            details=[{"field": "allowed_product_ids", "value": []}],
        )
    return list(dict.fromkeys(allowed)) if allowed is not None else None


# --- Sérialisation ----------------------------------------------------------------------------------


def product_out(product: Product) -> ProductOut:
    return ProductOut(
        id=product.id,
        code=product.code,
        label=product.label,
        ref_density_15=float(product.ref_density_15),
        thermal_coeff=float(product.thermal_coeff),
        color=product.color,
    )


def depot_out(depot: Depot) -> DepotOut:
    lat, lon = latlon(depot.location)
    return DepotOut(
        id=depot.id,
        code=depot.code,
        name=depot.name,
        operator=depot.operator,
        lat=lat,
        lon=lon,
        address=depot.address,
        opening_hours=depot.opening_hours or {},
        avg_wait_min=depot.avg_wait_min,
        max_loadings_per_truck_day=depot.max_loadings_per_truck_day,
        active=depot.active,
    )


def tank_out(tank: StationTank, products: dict[uuid.UUID, Product]) -> TankOut:
    product = products.get(tank.product_id)
    return TankOut(
        id=tank.id,
        station_id=tank.station_id,
        product_id=tank.product_id,
        product_code=product.code if product else "",
        product_label=product.label if product else "",
        capacity_l=float(tank.capacity_l),
        safety_stock_l=float(tank.safety_stock_l or 0),
    )


def station_out(station: Station, products: dict[uuid.UUID, Product]) -> StationOut:
    lat, lon = latlon(station.location)
    tanks = sorted((tank_out(t, products) for t in station.tanks), key=lambda t: t.product_code)
    return StationOut(
        id=station.id,
        code=station.code,
        name=station.name,
        region=station.region,
        city=station.city,
        lat=lat,
        lon=lon,
        opening_hours=station.opening_hours or {},
        max_truck_size=station.max_truck_size,
        unload_time_min=station.unload_time_min,
        contact_name=station.contact_name,
        contact_phone=station.contact_phone,
        contact_email=station.contact_email,
        active=station.active,
        tanks=tanks,
    )


def carrier_out(carrier: Carrier) -> CarrierOut:
    return CarrierOut(id=carrier.id, name=carrier.name, type=carrier.type, contact=carrier.contact)


def compartment_out(compartment: TruckCompartment, products: dict[uuid.UUID, Product]) -> CompartmentOut:
    allowed = compartment.allowed_product_ids
    return CompartmentOut(
        id=compartment.id,
        truck_id=compartment.truck_id,
        position=compartment.position,
        capacity_l=float(compartment.capacity_l),
        allowed_product_ids=list(allowed) if allowed is not None else None,
        allowed_product_codes=(
            [products[pid].code for pid in allowed if pid in products] if allowed is not None else None
        ),
    )


def truck_out(
    truck: Truck, products: dict[uuid.UUID, Product], carriers: dict[uuid.UUID, Carrier]
) -> TruckOut:
    carrier = carriers.get(truck.carrier_id) if truck.carrier_id else None
    return TruckOut(
        id=truck.id,
        plate=truck.plate,
        carrier_id=truck.carrier_id,
        carrier_name=carrier.name if carrier else None,
        carrier_type=carrier.type if carrier else None,
        size=truck.size,
        total_capacity_l=float(truck.total_capacity_l),
        avg_speed_kmh=float(truck.avg_speed_kmh) if truck.avg_speed_kmh is not None else None,
        status=truck.status,
        cost_per_km=truck.cost_per_km,
        notes=truck.notes,
        compartments=[
            compartment_out(c, products) for c in sorted(truck.compartments, key=lambda c: c.position)
        ],
    )


def driver_out(
    driver: Driver, carriers: dict[uuid.UUID, Carrier], trucks: dict[uuid.UUID, Truck]
) -> DriverOut:
    carrier = carriers.get(driver.carrier_id) if driver.carrier_id else None
    truck = trucks.get(driver.default_truck_id) if driver.default_truck_id else None
    return DriverOut(
        id=driver.id,
        full_name=driver.full_name,
        phone=driver.phone,
        license_no=driver.license_no,
        license_expiry=driver.license_expiry,
        hazmat_cert=driver.hazmat_cert,
        hazmat_expiry=driver.hazmat_expiry,
        carrier_id=driver.carrier_id,
        carrier_name=carrier.name if carrier else None,
        status=driver.status,
        default_truck_id=driver.default_truck_id,
        default_truck_plate=truck.plate if truck else None,
    )


async def load_by_ids(
    session: AsyncSession, model: type, ids: Iterable[uuid.UUID | None]
) -> dict[uuid.UUID, Any]:
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    return {o.id: o for o in (await session.execute(select(model).where(model.id.in_(wanted)))).scalars()}
