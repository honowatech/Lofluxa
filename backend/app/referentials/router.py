"""API des référentiels (F1.1 à F1.5) : produits, dépôts, stations et cuves, transporteurs, camions et
compartiments, chauffeurs.

- Lecture : tout rôle authentifié. Écriture : `admin` uniquement (spec §2).
- Listes paginées (`Page[T]`), éléments supprimés exclus. Recherche plein texte : paramètre `q`.
- Mise à jour : `PUT` et `PATCH` sont équivalents et partiels (un champ absent n'est pas modifié).
- Suppression logique (`deleted_at`) pour les référentiels ; les cuves et les compartiments, qui n'ont
  pas de colonne `deleted_at`, sont supprimés physiquement (refus 409 s'ils sont utilisés par un plan).
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import exists, or_, select

from app.core.deps import Page, PageDep, SessionDep, get_current_user, require_roles
from app.core.enums import CarrierType, DepotOperator, DriverStatus, Role, TruckSize, TruckStatus
from app.core.errors import ConflictError, NotFoundError, ValidationAppError
from app.core.geo import latlon, point
from app.core.time import utcnow
from app.referentials import service as svc
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
    CarrierCreate,
    CarrierOut,
    CarrierUpdate,
    CompartmentCreate,
    CompartmentOut,
    CompartmentUpdate,
    DepotCreate,
    DepotOut,
    DepotUpdate,
    DriverCreate,
    DriverOut,
    DriverUpdate,
    ProductCreate,
    ProductOut,
    ProductUpdate,
    StationCreate,
    StationOut,
    StationUpdate,
    TankCreate,
    TankOut,
    TankUpdate,
    TruckCreate,
    TruckOut,
    TruckUpdate,
)

router = APIRouter(tags=["référentiels"], dependencies=[Depends(get_current_user)])

ADMIN = [Depends(require_roles(Role.ADMIN))]
Search = Annotated[str | None, Query(description="Recherche (code, nom…), insensible à la casse")]

_IN_USE = "Suppression impossible : l'élément est utilisé par un plan ou un chargement."


def _like(q: str) -> str:
    escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _apply(obj: object, values: dict) -> None:
    for key, value in values.items():
        setattr(obj, key, value)


def _changes(payload: BaseModel, model: type, exclude: set[str] | None = None) -> dict:
    """Champs fournis par la requête ; un `null` sur une colonne obligatoire est ignoré (inchangé)."""
    columns = model.__table__.c
    values = payload.model_dump(exclude_unset=True, exclude=exclude or set())
    return {
        key: value
        for key, value in values.items()
        if value is not None or (key in columns and columns[key].nullable)
    }


def _move(obj: Depot | Station, values: dict) -> None:
    """Retire `lat` / `lon` de `values` et met à jour `location` si l'un des deux est fourni."""
    lat, lon = values.pop("lat", None), values.pop("lon", None)
    if lat is None and lon is None:
        return
    if lat is None or lon is None:
        current = latlon(obj.location) if obj.location is not None else (None, None)
        lat = current[0] if lat is None else lat
        lon = current[1] if lon is None else lon
    obj.location = point(lat, lon)


# === Produits (F1.1) ================================================================================


@router.get("/products", response_model=Page[ProductOut])
async def list_products(session: SessionDep, page: PageDep, q: Search = None) -> Page[ProductOut]:
    stmt = select(Product).where(Product.deleted_at.is_(None)).order_by(Product.code)
    if q:
        stmt = stmt.where(or_(Product.code.ilike(_like(q)), Product.label.ilike(_like(q))))
    rows, total = await svc.paginate(session, stmt, page)
    return Page(items=[svc.product_out(p) for p in rows], total=total, limit=page.limit, offset=page.offset)


@router.post("/products", response_model=ProductOut, status_code=201, dependencies=ADMIN)
async def create_product(payload: ProductCreate, session: SessionDep) -> ProductOut:
    await svc.ensure_unique(
        session, Product, Product.code, payload.code, exclude_id=None, what="Le code produit", field="code"
    )
    product = Product(**payload.model_dump())
    session.add(product)
    await svc.flush_or_conflict(session, "Ce code produit est déjà utilisé.")
    return svc.product_out(product)


@router.get("/products/{product_id}", response_model=ProductOut)
async def get_product(product_id: uuid.UUID, session: SessionDep) -> ProductOut:
    return svc.product_out(await svc.get_active(session, Product, product_id, "Produit introuvable."))


@router.put("/products/{product_id}", response_model=ProductOut, dependencies=ADMIN)
@router.patch("/products/{product_id}", response_model=ProductOut, dependencies=ADMIN)
async def update_product(product_id: uuid.UUID, payload: ProductUpdate, session: SessionDep) -> ProductOut:
    product = await svc.get_active(session, Product, product_id, "Produit introuvable.")
    values = _changes(payload, Product)
    if "code" in values:
        await svc.ensure_unique(
            session, Product, Product.code, values["code"], exclude_id=product.id,
            what="Le code produit", field="code",
        )  # fmt: skip
    _apply(product, values)
    await svc.flush_or_conflict(session, "Ce code produit est déjà utilisé.")
    return svc.product_out(product)


@router.delete("/products/{product_id}", status_code=204, dependencies=ADMIN)
async def delete_product(product_id: uuid.UUID, session: SessionDep) -> None:
    product = await svc.get_active(session, Product, product_id, "Produit introuvable.")
    used = await session.scalar(
        select(
            exists().where(
                StationTank.product_id == product.id,
                StationTank.station_id == Station.id,
                Station.deleted_at.is_(None),
            )
        )
    )
    if used:
        raise ConflictError(
            f"Le produit {product.code} est utilisé par des cuves de stations : supprimez d'abord ces cuves.",
            code="in_use",
        )
    product.deleted_at = utcnow()


# === Dépôts (F1.2) ==================================================================================


@router.get("/depots", response_model=Page[DepotOut])
async def list_depots(
    session: SessionDep,
    page: PageDep,
    q: Search = None,
    active: bool | None = None,
    operator: DepotOperator | None = None,
) -> Page[DepotOut]:
    stmt = select(Depot).where(Depot.deleted_at.is_(None)).order_by(Depot.code)
    if q:
        stmt = stmt.where(or_(Depot.code.ilike(_like(q)), Depot.name.ilike(_like(q))))
    if active is not None:
        stmt = stmt.where(Depot.active.is_(active))
    if operator is not None:
        stmt = stmt.where(Depot.operator == operator)
    rows, total = await svc.paginate(session, stmt, page)
    return Page(items=[svc.depot_out(d) for d in rows], total=total, limit=page.limit, offset=page.offset)


@router.post("/depots", response_model=DepotOut, status_code=201, dependencies=ADMIN)
async def create_depot(payload: DepotCreate, session: SessionDep) -> DepotOut:
    await svc.ensure_unique(
        session, Depot, Depot.code, payload.code, exclude_id=None, what="Le code dépôt", field="code"
    )
    values = payload.model_dump()
    depot = Depot(location=point(values.pop("lat"), values.pop("lon")), **values)
    session.add(depot)
    await svc.flush_or_conflict(session, "Ce code dépôt est déjà utilisé.")
    return svc.depot_out(depot)


@router.get("/depots/{depot_id}", response_model=DepotOut)
async def get_depot(depot_id: uuid.UUID, session: SessionDep) -> DepotOut:
    return svc.depot_out(await svc.get_active(session, Depot, depot_id, "Dépôt introuvable."))


@router.put("/depots/{depot_id}", response_model=DepotOut, dependencies=ADMIN)
@router.patch("/depots/{depot_id}", response_model=DepotOut, dependencies=ADMIN)
async def update_depot(depot_id: uuid.UUID, payload: DepotUpdate, session: SessionDep) -> DepotOut:
    depot = await svc.get_active(session, Depot, depot_id, "Dépôt introuvable.")
    values = _changes(payload, Depot)
    if "code" in values:
        await svc.ensure_unique(
            session,
            Depot,
            Depot.code,
            values["code"],
            exclude_id=depot.id,
            what="Le code dépôt",
            field="code",
        )
    _move(depot, values)
    _apply(depot, values)
    await svc.flush_or_conflict(session, "Ce code dépôt est déjà utilisé.")
    return svc.depot_out(depot)


@router.delete("/depots/{depot_id}", status_code=204, dependencies=ADMIN)
async def delete_depot(depot_id: uuid.UUID, session: SessionDep) -> None:
    depot = await svc.get_active(session, Depot, depot_id, "Dépôt introuvable.")
    depot.deleted_at = utcnow()


# === Stations et cuves (F1.3) =======================================================================


def _check_tank_list(tanks: list[TankCreate]) -> None:
    seen: set[uuid.UUID] = set()
    for tank in tanks:
        if tank.product_id in seen:
            raise ConflictError(
                "Une station ne peut avoir qu'une cuve par produit.",
                code="duplicate",
                details=[{"field": "tanks.product_id", "value": str(tank.product_id)}],
            )
        seen.add(tank.product_id)
        svc.check_tank(tank.capacity_l, tank.safety_stock_l)


@router.get("/stations", response_model=Page[StationOut])
async def list_stations(
    session: SessionDep,
    page: PageDep,
    q: Search = None,
    active: bool | None = None,
    region: str | None = None,
    city: str | None = None,
    max_truck_size: TruckSize | None = None,
    product_id: Annotated[
        uuid.UUID | None, Query(description="Stations ayant une cuve de ce produit")
    ] = None,
) -> Page[StationOut]:
    stmt = select(Station).where(Station.deleted_at.is_(None)).order_by(Station.code)
    if q:
        like = _like(q)
        stmt = stmt.where(or_(Station.code.ilike(like), Station.name.ilike(like), Station.city.ilike(like)))
    if active is not None:
        stmt = stmt.where(Station.active.is_(active))
    if region:
        stmt = stmt.where(Station.region.ilike(region.strip()))
    if city:
        stmt = stmt.where(Station.city.ilike(city.strip()))
    if max_truck_size is not None:
        stmt = stmt.where(Station.max_truck_size == max_truck_size)
    if product_id is not None:
        stmt = stmt.where(
            exists().where(StationTank.station_id == Station.id, StationTank.product_id == product_id)
        )
    rows, total = await svc.paginate(session, stmt, page)
    products = await svc.products_by_id(session)
    return Page(
        items=[svc.station_out(s, products) for s in rows], total=total, limit=page.limit, offset=page.offset
    )


@router.post("/stations", response_model=StationOut, status_code=201, dependencies=ADMIN)
async def create_station(payload: StationCreate, session: SessionDep) -> StationOut:
    await svc.ensure_unique(
        session, Station, Station.code, payload.code, exclude_id=None, what="Le code station", field="code"
    )
    products = await svc.products_by_id(session)
    _check_tank_list(payload.tanks)
    await svc.ensure_products_exist(products, [t.product_id for t in payload.tanks], "tanks.product_id")
    values = payload.model_dump(exclude={"tanks"})
    station = Station(location=point(values.pop("lat"), values.pop("lon")), **values)
    station.tanks = [StationTank(**t.model_dump()) for t in payload.tanks]
    session.add(station)
    await svc.flush_or_conflict(session, "Ce code station est déjà utilisé.")
    return svc.station_out(station, products)


@router.get("/stations/{station_id}", response_model=StationOut)
async def get_station(station_id: uuid.UUID, session: SessionDep) -> StationOut:
    station = await svc.get_active(session, Station, station_id, "Station introuvable.")
    return svc.station_out(station, await svc.products_by_id(session))


@router.put("/stations/{station_id}", response_model=StationOut, dependencies=ADMIN)
@router.patch("/stations/{station_id}", response_model=StationOut, dependencies=ADMIN)
async def update_station(station_id: uuid.UUID, payload: StationUpdate, session: SessionDep) -> StationOut:
    station = await svc.get_active(session, Station, station_id, "Station introuvable.")
    products = await svc.products_by_id(session)
    values = _changes(payload, Station, {"tanks"})
    if "code" in values:
        await svc.ensure_unique(
            session, Station, Station.code, values["code"], exclude_id=station.id,
            what="Le code station", field="code",
        )  # fmt: skip
    if payload.tanks is not None:
        _check_tank_list(payload.tanks)
        await svc.ensure_products_exist(products, [t.product_id for t in payload.tanks], "tanks.product_id")
        wanted = {t.product_id: t for t in payload.tanks}
        for tank in list(station.tanks):
            if tank.product_id in wanted:
                new = wanted.pop(tank.product_id)
                tank.capacity_l, tank.safety_stock_l = new.capacity_l, new.safety_stock_l
            else:
                station.tanks.remove(tank)
        station.tanks.extend(StationTank(**t.model_dump()) for t in wanted.values())
    _move(station, values)
    _apply(station, values)
    await svc.flush_or_conflict(session, "Ce code station est déjà utilisé.")
    return svc.station_out(station, products)


@router.delete("/stations/{station_id}", status_code=204, dependencies=ADMIN)
async def delete_station(station_id: uuid.UUID, session: SessionDep) -> None:
    station = await svc.get_active(session, Station, station_id, "Station introuvable.")
    station.deleted_at = utcnow()


def _find_tank(station: Station, tank_id: uuid.UUID) -> StationTank:
    for tank in station.tanks:
        if tank.id == tank_id:
            return tank
    raise NotFoundError("Cuve introuvable.")


@router.get("/stations/{station_id}/tanks", response_model=Page[TankOut])
async def list_tanks(station_id: uuid.UUID, session: SessionDep, page: PageDep) -> Page[TankOut]:
    station = await svc.get_active(session, Station, station_id, "Station introuvable.")
    products = await svc.products_by_id(session)
    tanks = sorted((svc.tank_out(t, products) for t in station.tanks), key=lambda t: t.product_code)
    return Page(
        items=tanks[page.offset : page.offset + page.limit],
        total=len(tanks),
        limit=page.limit,
        offset=page.offset,
    )


@router.post("/stations/{station_id}/tanks", response_model=TankOut, status_code=201, dependencies=ADMIN)
async def create_tank(station_id: uuid.UUID, payload: TankCreate, session: SessionDep) -> TankOut:
    station = await svc.get_active(session, Station, station_id, "Station introuvable.")
    products = await svc.products_by_id(session)
    await svc.ensure_products_exist(products, [payload.product_id], "product_id")
    svc.check_tank(payload.capacity_l, payload.safety_stock_l)
    if any(t.product_id == payload.product_id for t in station.tanks):
        raise ConflictError(
            f"La station {station.code} a déjà une cuve de {products[payload.product_id].code}.",
            code="duplicate",
            details=[{"field": "product_id", "value": str(payload.product_id)}],
        )
    tank = StationTank(station_id=station.id, **payload.model_dump())
    station.tanks.append(tank)
    await svc.flush_or_conflict(session, "Cette station a déjà une cuve pour ce produit.")
    return svc.tank_out(tank, products)


@router.get("/stations/{station_id}/tanks/{tank_id}", response_model=TankOut)
async def get_tank(station_id: uuid.UUID, tank_id: uuid.UUID, session: SessionDep) -> TankOut:
    station = await svc.get_active(session, Station, station_id, "Station introuvable.")
    return svc.tank_out(_find_tank(station, tank_id), await svc.products_by_id(session))


@router.put(
    "/stations/{station_id}/tanks/{tank_id}",
    response_model=TankOut,
    dependencies=ADMIN,
)
@router.patch(
    "/stations/{station_id}/tanks/{tank_id}",
    response_model=TankOut,
    dependencies=ADMIN,
)
async def update_tank(
    station_id: uuid.UUID, tank_id: uuid.UUID, payload: TankUpdate, session: SessionDep
) -> TankOut:
    station = await svc.get_active(session, Station, station_id, "Station introuvable.")
    tank = _find_tank(station, tank_id)
    products = await svc.products_by_id(session)
    values = _changes(payload, StationTank)
    if "product_id" in values and values["product_id"] != tank.product_id:
        await svc.ensure_products_exist(products, [values["product_id"]], "product_id")
        if any(t.product_id == values["product_id"] for t in station.tanks):
            raise ConflictError(
                f"La station {station.code} a déjà une cuve de {products[values['product_id']].code}.",
                code="duplicate",
                details=[{"field": "product_id", "value": str(values["product_id"])}],
            )
    svc.check_tank(
        values.get("capacity_l", float(tank.capacity_l)),
        values.get("safety_stock_l", float(tank.safety_stock_l or 0)),
    )
    _apply(tank, values)
    await svc.flush_or_conflict(session, "Cette station a déjà une cuve pour ce produit.")
    return svc.tank_out(tank, products)


@router.delete("/stations/{station_id}/tanks/{tank_id}", status_code=204, dependencies=ADMIN)
async def delete_tank(station_id: uuid.UUID, tank_id: uuid.UUID, session: SessionDep) -> None:
    station = await svc.get_active(session, Station, station_id, "Station introuvable.")
    station.tanks.remove(_find_tank(station, tank_id))
    await svc.flush_or_conflict(session, _IN_USE)


# === Transporteurs ==================================================================================


@router.get("/carriers", response_model=Page[CarrierOut])
async def list_carriers(
    session: SessionDep, page: PageDep, q: Search = None, type: CarrierType | None = None
) -> Page[CarrierOut]:
    stmt = select(Carrier).where(Carrier.deleted_at.is_(None)).order_by(Carrier.name)
    if q:
        stmt = stmt.where(Carrier.name.ilike(_like(q)))
    if type is not None:
        stmt = stmt.where(Carrier.type == type)
    rows, total = await svc.paginate(session, stmt, page)
    return Page(items=[svc.carrier_out(c) for c in rows], total=total, limit=page.limit, offset=page.offset)


@router.post("/carriers", response_model=CarrierOut, status_code=201, dependencies=ADMIN)
async def create_carrier(payload: CarrierCreate, session: SessionDep) -> CarrierOut:
    await svc.ensure_unique(
        session, Carrier, Carrier.name, payload.name, exclude_id=None,
        what="Le nom de transporteur", field="name",
    )  # fmt: skip
    carrier = Carrier(**payload.model_dump())
    session.add(carrier)
    await svc.flush_or_conflict(session, "Ce nom de transporteur est déjà utilisé.")
    return svc.carrier_out(carrier)


@router.get("/carriers/{carrier_id}", response_model=CarrierOut)
async def get_carrier(carrier_id: uuid.UUID, session: SessionDep) -> CarrierOut:
    return svc.carrier_out(await svc.get_active(session, Carrier, carrier_id, "Transporteur introuvable."))


@router.put("/carriers/{carrier_id}", response_model=CarrierOut, dependencies=ADMIN)
@router.patch("/carriers/{carrier_id}", response_model=CarrierOut, dependencies=ADMIN)
async def update_carrier(carrier_id: uuid.UUID, payload: CarrierUpdate, session: SessionDep) -> CarrierOut:
    carrier = await svc.get_active(session, Carrier, carrier_id, "Transporteur introuvable.")
    values = _changes(payload, Carrier)
    if "name" in values:
        await svc.ensure_unique(
            session, Carrier, Carrier.name, values["name"], exclude_id=carrier.id,
            what="Le nom de transporteur", field="name",
        )  # fmt: skip
    _apply(carrier, values)
    await svc.flush_or_conflict(session, "Ce nom de transporteur est déjà utilisé.")
    return svc.carrier_out(carrier)


@router.delete("/carriers/{carrier_id}", status_code=204, dependencies=ADMIN)
async def delete_carrier(carrier_id: uuid.UUID, session: SessionDep) -> None:
    carrier = await svc.get_active(session, Carrier, carrier_id, "Transporteur introuvable.")
    trucks = await session.scalar(
        select(exists().where(Truck.carrier_id == carrier.id, Truck.deleted_at.is_(None)))
    )
    drivers = await session.scalar(
        select(exists().where(Driver.carrier_id == carrier.id, Driver.deleted_at.is_(None)))
    )
    if trucks or drivers:
        raise ConflictError(
            f"Le transporteur « {carrier.name} » a encore des camions ou des chauffeurs : "
            "réaffectez-les ou supprimez-les d'abord.",
            code="in_use",
        )
    carrier.deleted_at = utcnow()


# === Camions et compartiments (F1.4) ================================================================


def _check_compartment_list(compartments: list[CompartmentCreate]) -> None:
    positions = [c.position for c in compartments]
    duplicates = sorted({p for p in positions if positions.count(p) > 1})
    if duplicates:
        raise ConflictError(
            "Position de compartiment en double : " + ", ".join(map(str, duplicates)) + ".",
            code="duplicate",
            details=[{"field": "compartments.position", "value": p} for p in duplicates],
        )


async def _truck_out(session: SessionDep, truck: Truck) -> TruckOut:
    products = await svc.products_by_id(session)
    carriers = await svc.load_by_ids(session, Carrier, [truck.carrier_id])
    return svc.truck_out(truck, products, carriers)


@router.get("/trucks", response_model=Page[TruckOut])
async def list_trucks(
    session: SessionDep,
    page: PageDep,
    q: Search = None,
    carrier_id: uuid.UUID | None = None,
    status: TruckStatus | None = None,
    size: TruckSize | None = None,
) -> Page[TruckOut]:
    stmt = select(Truck).where(Truck.deleted_at.is_(None)).order_by(Truck.plate)
    if q:
        stmt = stmt.where(or_(Truck.plate.ilike(_like(q)), Truck.notes.ilike(_like(q))))
    if carrier_id is not None:
        stmt = stmt.where(Truck.carrier_id == carrier_id)
    if status is not None:
        stmt = stmt.where(Truck.status == status)
    if size is not None:
        stmt = stmt.where(Truck.size == size)
    rows, total = await svc.paginate(session, stmt, page)
    products = await svc.products_by_id(session)
    carriers = await svc.load_by_ids(session, Carrier, [t.carrier_id for t in rows])
    return Page(
        items=[svc.truck_out(t, products, carriers) for t in rows],
        total=total,
        limit=page.limit,
        offset=page.offset,
    )


@router.post("/trucks", response_model=TruckOut, status_code=201, dependencies=ADMIN)
async def create_truck(payload: TruckCreate, session: SessionDep) -> TruckOut:
    await svc.ensure_unique(
        session, Truck, Truck.plate, payload.plate, exclude_id=None, what="L'immatriculation", field="plate"
    )
    if payload.carrier_id is not None:
        await svc.get_active(session, Carrier, payload.carrier_id, "Transporteur introuvable.")
    products = await svc.products_by_id(session)
    _check_compartment_list(payload.compartments)
    compartments = []
    for comp in payload.compartments:
        allowed = svc.check_allowed_products(comp.allowed_product_ids)
        await svc.ensure_products_exist(products, allowed or [], "compartments.allowed_product_ids")
        compartments.append(
            TruckCompartment(position=comp.position, capacity_l=comp.capacity_l, allowed_product_ids=allowed)
        )
    values = payload.model_dump(exclude={"compartments"})
    if values["total_capacity_l"] is None:
        if not compartments:
            raise ValidationAppError(
                "Indiquez la capacité totale du camion ou la liste de ses compartiments.",
                details=[{"field": "total_capacity_l", "value": None}],
            )
        values["total_capacity_l"] = sum(c.capacity_l for c in payload.compartments)
    svc.check_truck_capacity(values["total_capacity_l"], [c.capacity_l for c in payload.compartments])
    truck = Truck(**values)
    truck.compartments = compartments
    session.add(truck)
    await svc.flush_or_conflict(session, "Cette immatriculation est déjà utilisée.")
    return await _truck_out(session, truck)


@router.get("/trucks/{truck_id}", response_model=TruckOut)
async def get_truck(truck_id: uuid.UUID, session: SessionDep) -> TruckOut:
    return await _truck_out(session, await svc.get_active(session, Truck, truck_id, "Camion introuvable."))


@router.put("/trucks/{truck_id}", response_model=TruckOut, dependencies=ADMIN)
@router.patch("/trucks/{truck_id}", response_model=TruckOut, dependencies=ADMIN)
async def update_truck(truck_id: uuid.UUID, payload: TruckUpdate, session: SessionDep) -> TruckOut:
    truck = await svc.get_active(session, Truck, truck_id, "Camion introuvable.")
    values = _changes(payload, Truck, {"compartments"})
    if "plate" in values:
        await svc.ensure_unique(
            session, Truck, Truck.plate, values["plate"], exclude_id=truck.id,
            what="L'immatriculation", field="plate",
        )  # fmt: skip
    if values.get("carrier_id") is not None:
        await svc.get_active(session, Carrier, values["carrier_id"], "Transporteur introuvable.")
    products = await svc.products_by_id(session)
    if payload.compartments is not None:
        _check_compartment_list(payload.compartments)
        wanted = {c.position: c for c in payload.compartments}
        for comp in wanted.values():
            allowed = svc.check_allowed_products(comp.allowed_product_ids)
            await svc.ensure_products_exist(products, allowed or [], "compartments.allowed_product_ids")
        caps = [c.capacity_l for c in payload.compartments]
    else:
        wanted = None
        caps = [float(c.capacity_l) for c in truck.compartments]
    svc.check_truck_capacity(values.get("total_capacity_l", float(truck.total_capacity_l)), caps)
    if wanted is not None:
        for existing in list(truck.compartments):
            if existing.position in wanted:
                new = wanted.pop(existing.position)
                existing.capacity_l = new.capacity_l
                existing.allowed_product_ids = svc.check_allowed_products(new.allowed_product_ids)
            else:
                truck.compartments.remove(existing)
        for new in wanted.values():
            truck.compartments.append(
                TruckCompartment(
                    position=new.position,
                    capacity_l=new.capacity_l,
                    allowed_product_ids=svc.check_allowed_products(new.allowed_product_ids),
                )
            )
    _apply(truck, values)
    await svc.flush_or_conflict(
        session,
        "Modification impossible : immatriculation déjà utilisée, ou compartiment utilisé par un plan.",
    )
    return await _truck_out(session, truck)


@router.delete("/trucks/{truck_id}", status_code=204, dependencies=ADMIN)
async def delete_truck(truck_id: uuid.UUID, session: SessionDep) -> None:
    truck = await svc.get_active(session, Truck, truck_id, "Camion introuvable.")
    truck.deleted_at = utcnow()


def _find_compartment(truck: Truck, compartment_id: uuid.UUID) -> TruckCompartment:
    for compartment in truck.compartments:
        if compartment.id == compartment_id:
            return compartment
    raise NotFoundError("Compartiment introuvable.")


@router.get("/trucks/{truck_id}/compartments", response_model=Page[CompartmentOut])
async def list_compartments(truck_id: uuid.UUID, session: SessionDep, page: PageDep) -> Page[CompartmentOut]:
    truck = await svc.get_active(session, Truck, truck_id, "Camion introuvable.")
    products = await svc.products_by_id(session)
    items = [svc.compartment_out(c, products) for c in sorted(truck.compartments, key=lambda c: c.position)]
    return Page(
        items=items[page.offset : page.offset + page.limit],
        total=len(items),
        limit=page.limit,
        offset=page.offset,
    )


@router.post(
    "/trucks/{truck_id}/compartments", response_model=CompartmentOut, status_code=201, dependencies=ADMIN
)
async def create_compartment(
    truck_id: uuid.UUID, payload: CompartmentCreate, session: SessionDep
) -> CompartmentOut:
    truck = await svc.get_active(session, Truck, truck_id, "Camion introuvable.")
    products = await svc.products_by_id(session)
    allowed = svc.check_allowed_products(payload.allowed_product_ids)
    await svc.ensure_products_exist(products, allowed or [], "allowed_product_ids")
    if any(c.position == payload.position for c in truck.compartments):
        raise ConflictError(
            f"Le camion {truck.plate} a déjà un compartiment en position {payload.position}.",
            code="duplicate",
            details=[{"field": "position", "value": payload.position}],
        )
    svc.check_truck_capacity(
        float(truck.total_capacity_l),
        [float(c.capacity_l) for c in truck.compartments] + [payload.capacity_l],
    )
    compartment = TruckCompartment(
        truck_id=truck.id,
        position=payload.position,
        capacity_l=payload.capacity_l,
        allowed_product_ids=allowed,
    )
    truck.compartments.append(compartment)
    await svc.flush_or_conflict(session, "Ce camion a déjà un compartiment à cette position.")
    return svc.compartment_out(compartment, products)


@router.get("/trucks/{truck_id}/compartments/{compartment_id}", response_model=CompartmentOut)
async def get_compartment(
    truck_id: uuid.UUID, compartment_id: uuid.UUID, session: SessionDep
) -> CompartmentOut:
    truck = await svc.get_active(session, Truck, truck_id, "Camion introuvable.")
    return svc.compartment_out(_find_compartment(truck, compartment_id), await svc.products_by_id(session))


@router.put(
    "/trucks/{truck_id}/compartments/{compartment_id}",
    response_model=CompartmentOut,
    dependencies=ADMIN,
)
@router.patch(
    "/trucks/{truck_id}/compartments/{compartment_id}",
    response_model=CompartmentOut,
    dependencies=ADMIN,
)
async def update_compartment(
    truck_id: uuid.UUID, compartment_id: uuid.UUID, payload: CompartmentUpdate, session: SessionDep
) -> CompartmentOut:
    """`allowed_product_ids: null` explicite = tous produits ; champ absent = inchangé."""
    truck = await svc.get_active(session, Truck, truck_id, "Camion introuvable.")
    compartment = _find_compartment(truck, compartment_id)
    products = await svc.products_by_id(session)
    values = _changes(payload, TruckCompartment)
    if "allowed_product_ids" in values:
        values["allowed_product_ids"] = svc.check_allowed_products(values["allowed_product_ids"])
        await svc.ensure_products_exist(products, values["allowed_product_ids"] or [], "allowed_product_ids")
    if "position" in values and values["position"] != compartment.position:
        if any(c.position == values["position"] for c in truck.compartments):
            raise ConflictError(
                f"Le camion {truck.plate} a déjà un compartiment en position {values['position']}.",
                code="duplicate",
                details=[{"field": "position", "value": values["position"]}],
            )
    if "capacity_l" in values:
        others = [float(c.capacity_l) for c in truck.compartments if c.id != compartment.id]
        svc.check_truck_capacity(float(truck.total_capacity_l), others + [values["capacity_l"]])
    _apply(compartment, values)
    await svc.flush_or_conflict(session, "Ce camion a déjà un compartiment à cette position.")
    return svc.compartment_out(compartment, products)


@router.delete("/trucks/{truck_id}/compartments/{compartment_id}", status_code=204, dependencies=ADMIN)
async def delete_compartment(truck_id: uuid.UUID, compartment_id: uuid.UUID, session: SessionDep) -> None:
    truck = await svc.get_active(session, Truck, truck_id, "Camion introuvable.")
    truck.compartments.remove(_find_compartment(truck, compartment_id))
    await svc.flush_or_conflict(session, _IN_USE)


# === Chauffeurs (F1.5) ==============================================================================


async def _driver_out(session: SessionDep, driver: Driver) -> DriverOut:
    carriers = await svc.load_by_ids(session, Carrier, [driver.carrier_id])
    trucks = await svc.load_by_ids(session, Truck, [driver.default_truck_id])
    return svc.driver_out(driver, carriers, trucks)


async def _check_driver_links(session: SessionDep, values: dict) -> None:
    if values.get("carrier_id") is not None:
        await svc.get_active(session, Carrier, values["carrier_id"], "Transporteur introuvable.")
    if values.get("default_truck_id") is not None:
        await svc.get_active(session, Truck, values["default_truck_id"], "Camion habituel introuvable.")


@router.get("/drivers", response_model=Page[DriverOut])
async def list_drivers(
    session: SessionDep,
    page: PageDep,
    q: Search = None,
    carrier_id: uuid.UUID | None = None,
    status: DriverStatus | None = None,
    default_truck_id: uuid.UUID | None = None,
) -> Page[DriverOut]:
    stmt = select(Driver).where(Driver.deleted_at.is_(None)).order_by(Driver.full_name, Driver.id)
    if q:
        like = _like(q)
        stmt = stmt.where(
            or_(Driver.full_name.ilike(like), Driver.license_no.ilike(like), Driver.phone.ilike(like))
        )
    if carrier_id is not None:
        stmt = stmt.where(Driver.carrier_id == carrier_id)
    if status is not None:
        stmt = stmt.where(Driver.status == status)
    if default_truck_id is not None:
        stmt = stmt.where(Driver.default_truck_id == default_truck_id)
    rows, total = await svc.paginate(session, stmt, page)
    carriers = await svc.load_by_ids(session, Carrier, [d.carrier_id for d in rows])
    trucks = await svc.load_by_ids(session, Truck, [d.default_truck_id for d in rows])
    return Page(
        items=[svc.driver_out(d, carriers, trucks) for d in rows],
        total=total,
        limit=page.limit,
        offset=page.offset,
    )


@router.post("/drivers", response_model=DriverOut, status_code=201, dependencies=ADMIN)
async def create_driver(payload: DriverCreate, session: SessionDep) -> DriverOut:
    await svc.ensure_unique(
        session, Driver, Driver.license_no, payload.license_no, exclude_id=None,
        what="Le numéro de permis", field="license_no",
    )  # fmt: skip
    values = payload.model_dump()
    await _check_driver_links(session, values)
    driver = Driver(**values)
    session.add(driver)
    await svc.flush_or_conflict(session, "Ce numéro de permis est déjà utilisé.")
    return await _driver_out(session, driver)


@router.get("/drivers/{driver_id}", response_model=DriverOut)
async def get_driver(driver_id: uuid.UUID, session: SessionDep) -> DriverOut:
    return await _driver_out(
        session, await svc.get_active(session, Driver, driver_id, "Chauffeur introuvable.")
    )


@router.put("/drivers/{driver_id}", response_model=DriverOut, dependencies=ADMIN)
@router.patch("/drivers/{driver_id}", response_model=DriverOut, dependencies=ADMIN)
async def update_driver(driver_id: uuid.UUID, payload: DriverUpdate, session: SessionDep) -> DriverOut:
    driver = await svc.get_active(session, Driver, driver_id, "Chauffeur introuvable.")
    values = _changes(payload, Driver)
    if values.get("license_no") is not None:
        await svc.ensure_unique(
            session, Driver, Driver.license_no, values["license_no"], exclude_id=driver.id,
            what="Le numéro de permis", field="license_no",
        )  # fmt: skip
    await _check_driver_links(session, values)
    _apply(driver, values)
    await svc.flush_or_conflict(session, "Ce numéro de permis est déjà utilisé.")
    return await _driver_out(session, driver)


@router.delete("/drivers/{driver_id}", status_code=204, dependencies=ADMIN)
async def delete_driver(driver_id: uuid.UUID, session: SessionDep) -> None:
    driver = await svc.get_active(session, Driver, driver_id, "Chauffeur introuvable.")
    driver.deleted_at = utcnow()
