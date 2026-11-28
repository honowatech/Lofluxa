"""Kinds d'import du lot L3 : `stations` (avec cuves), `trucks` (avec compartiments), `drivers`, `depots`
(référentiels F1.6, rôle `admin`) et `orders` (commandes du jour F3.2, rôle `dispatcher`).

Règles communes (voir aussi `docs/questions/l3-referentiels.md`) :
- un enregistrement est reconnu par sa clé (code station / dépôt, immatriculation, numéro de permis ;
  pour une commande : date + station + produit) : clé inconnue = création, clé connue = mise à jour ;
- une cellule vide ne modifie rien ; l'import ne supprime jamais rien (cuves et compartiments absents du
  fichier sont conservés) ; un élément supprimé dont la clé réapparaît est réactivé (annoncé) ;
- toute mise à jour est annoncée champ par champ (avant → après) dans la prévisualisation.
"""

import uuid
from collections.abc import Awaitable, Callable
from datetime import date
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import CarrierType, ImportKind, OrderSource, OrderStatus, Role
from app.core.errors import ValidationAppError
from app.core.geo import latlon, point
from app.imports import columns as cols
from app.imports.models import ImportBatch
from app.imports.records import Plan, RecordKind, Step, same, scalar_changes, show
from app.imports.registry import register_kind
from app.imports.schemas import (
    DepotIn,
    DriverIn,
    FieldChange,
    ImportItem,
    OrderIn,
    StationIn,
    TruckIn,
)
from app.imports.source import ExcelImportSource
from app.orders.models import Order
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
from app.referentials.service import capacity_gap_message

Run = Callable[[AsyncSession, ImportBatch], Awaitable[None]]

_REACTIVATED = FieldChange(field="deleted_at", label="État", before="supprimé", after="réactivé")


def _action(existing: Any, changes: list[FieldChange]) -> str:
    if existing is None:
        return "create"
    return "update" if changes else "unchanged"


async def _products_by_code(session: AsyncSession) -> dict[str, Product]:
    rows = (await session.execute(select(Product).where(Product.deleted_at.is_(None)))).scalars()
    return {p.code.upper(): p for p in rows}


def _unknown_product(
    plan: Plan, row: int | None, column: str, code: str, products: dict[str, Product]
) -> None:
    known = ", ".join(sorted(products)) or "aucun"
    plan.error(row, column, code, f"Produit inconnu : « {code} ». Produits du référentiel : {known}.")


def _require_for_create(
    plan: Plan, record: Any, spec: cols.FileSpec, keys: tuple[str, ...], what: str
) -> bool:
    ok = True
    for key in keys:
        if getattr(record, key) is None:
            plan.error(
                record.row,
                spec.header(key),
                None,
                f"« {spec.header(key)} » est obligatoire pour créer {what}.",
            )
            ok = False
    return ok


def _position_changes(
    obj: Any, record: Any, spec: cols.FileSpec
) -> tuple[list[FieldChange], tuple[float, float] | None]:
    """Changement de position (lat / lon) : changements à annoncer et nouvelle position à écrire."""
    if record.lat is None and record.lon is None:
        return [], None
    if obj is None:
        return [], (record.lat, record.lon)
    old_lat, old_lon = latlon(obj.location)
    lat = record.lat if record.lat is not None else old_lat
    lon = record.lon if record.lon is not None else old_lon
    changes = []
    if not same(old_lat, lat):
        changes.append(
            FieldChange(field="lat", label=spec.header("lat"), before=show(old_lat), after=show(lat))
        )
    if not same(old_lon, lon):
        changes.append(
            FieldChange(field="lon", label=spec.header("lon"), before=show(old_lon), after=show(lon))
        )
    return changes, ((lat, lon) if changes else None)


class _Carriers:
    """Transporteurs cités par nom dans les fichiers camions / chauffeurs : créés s'ils n'existent pas."""

    def __init__(self, carriers: list[Carrier]) -> None:
        self.by_name = {c.name.casefold(): c for c in carriers}
        self.by_id = {c.id: c for c in carriers}
        self.planned: dict[str, tuple[str, CarrierType]] = {}

    @classmethod
    async def load(cls, session: AsyncSession) -> "_Carriers":
        return cls(list((await session.execute(select(Carrier))).scalars()))

    def name_of(self, carrier_id: uuid.UUID | None) -> str | None:
        carrier = self.by_id.get(carrier_id) if carrier_id else None
        return carrier.name if carrier else None

    def announce(
        self, plan: Plan, row: int | None, column: str, name: str, type_: CarrierType | None
    ) -> None:
        """Signale (une fois par nom) ce que l'application fera de ce transporteur."""
        key = name.casefold()
        carrier = self.by_name.get(key)
        if carrier is not None:
            if carrier.deleted_at is not None and key not in self.planned:
                self.planned[key] = (carrier.name, carrier.type)
                plan.warning(
                    row,
                    column,
                    name,
                    f"Le transporteur « {carrier.name} » était supprimé : il sera réactivé.",
                )
            if type_ is not None and type_ != carrier.type:
                plan.warning(
                    row,
                    column,
                    name,
                    f"Le transporteur « {carrier.name} » existe déjà avec le type « {carrier.type.value} » : "
                    "son type n'est pas modifié par l'import.",
                )
        elif key not in self.planned:
            kind = type_ or CarrierType.THIRD_PARTY
            self.planned[key] = (name, kind)
            label = "propre" if kind == CarrierType.OWN else "tiers"
            plan.warning(row, column, name, f"Transporteur inconnu : « {name} » sera créé (type {label}).")

    async def get(self, session: AsyncSession, name: str, type_: CarrierType | None) -> Carrier:
        key = name.casefold()
        carrier = self.by_name.get(key)
        if carrier is None:
            carrier = Carrier(
                name=name, type=self.planned.get(key, (name, type_ or CarrierType.THIRD_PARTY))[1]
            )
            session.add(carrier)
            await session.flush()
            self.by_name[key] = carrier
            self.by_id[carrier.id] = carrier
        elif carrier.deleted_at is not None:
            carrier.deleted_at = None
        return carrier


# === Stations (avec cuves) ==========================================================================


class StationsKind(RecordKind):
    kind = ImportKind.STATIONS
    label = "Stations"
    roles = (Role.ADMIN,)
    spec = cols.STATIONS
    record_model = StationIn

    FIELDS = {
        "name": "name",
        "region": "region",
        "city": "city",
        "opening_hours": "opening_hours",
        "max_truck_size": "max_truck_size",
        "unload_time_min": "unload_time_min",
        "contact_name": "contact_name",
        "contact_phone": "contact_phone",
        "contact_email": "contact_email",
        "active": "active",
    }

    def fetch(self, source: ExcelImportSource, options: dict[str, Any]) -> list[StationIn]:
        return source.fetch_stations()

    async def plan(self, session: AsyncSession, records: list[StationIn], options: dict[str, Any]) -> Plan:
        plan = Plan()
        spec = self.spec
        products = await _products_by_code(session)
        codes = [r.code for r in records]
        existing = {
            s.code.upper(): s
            for s in (
                await session.execute(select(Station).where(func.upper(Station.code).in_(codes)))
            ).scalars()
        }
        for record in records:
            station = existing.get(record.code)
            before = plan.error_count()
            if station is None:
                _require_for_create(plan, record, spec, ("name", "lat", "lon"), f"la station {record.code}")
            changes, updates = scalar_changes(station, record, spec, self.FIELDS)
            position_changes, position = _position_changes(station, record, spec)
            changes += position_changes
            if station is not None and station.deleted_at is not None:
                changes.insert(0, _REACTIVATED)
            tanks = {t.product_id: t for t in station.tanks} if station is not None else {}
            tank_ops: list[tuple[uuid.UUID, float, float, StationTank | None]] = []
            for tank_in in record.tanks:
                product = products.get(tank_in.product_code)
                if product is None:
                    _unknown_product(
                        plan, tank_in.row, spec.header("product_code"), tank_in.product_code, products
                    )
                    continue
                tank = tanks.get(product.id)
                safety = tank_in.safety_stock_l
                if safety is None:
                    safety = float(tank.safety_stock_l or 0) if tank is not None else 0.0
                if safety > tank_in.capacity_l:
                    plan.error(
                        tank_in.row,
                        spec.header("safety_stock_l"),
                        safety,
                        f"Le stock de sécurité ({show(safety)} L) dépasse la capacité de la cuve "
                        f"({show(tank_in.capacity_l)} L).",
                    )
                    continue
                prefix = f"Cuve {product.code}"
                if tank is None:
                    tank_ops.append((product.id, tank_in.capacity_l, safety, None))
                    if station is not None:
                        changes.append(
                            FieldChange(
                                field=f"tanks[{product.code}]",
                                label=f"{prefix} (nouvelle)",
                                before=None,
                                after=f"{show(tank_in.capacity_l)} L, stock de sécurité {show(safety)} L",
                            )
                        )
                    continue
                tank_changes = []
                if not same(tank.capacity_l, tank_in.capacity_l):
                    tank_changes.append(
                        FieldChange(
                            field=f"tanks[{product.code}].capacity_l",
                            label=f"{prefix} — {spec.header('capacity_l')}",
                            before=show(tank.capacity_l),
                            after=show(tank_in.capacity_l),
                        )
                    )
                if not same(tank.safety_stock_l or 0, safety):
                    tank_changes.append(
                        FieldChange(
                            field=f"tanks[{product.code}].safety_stock_l",
                            label=f"{prefix} — {spec.header('safety_stock_l')}",
                            before=show(tank.safety_stock_l or 0),
                            after=show(safety),
                        )
                    )
                if tank_changes:
                    changes += tank_changes
                    tank_ops.append((product.id, tank_in.capacity_l, safety, tank))
            if plan.error_count() > before:
                continue
            label = f"{record.code} — {record.name or (station.name if station else '')}"
            item = ImportItem(
                row=record.row,
                key=record.code,
                label=label,
                action=_action(station, changes),
                changes=changes,
            )
            plan.steps.append(Step(item, self._run(station, record, updates, position, tank_ops)))
        return plan

    @staticmethod
    def _run(station: Station | None, record: StationIn, updates: dict, position: Any, tank_ops: list) -> Run:
        async def run(session: AsyncSession, batch: ImportBatch) -> None:
            target = station
            if target is None:
                target = Station(code=record.code, location=point(*position), **updates)
                session.add(target)
            else:
                target.deleted_at = None
                for attr, value in updates.items():
                    setattr(target, attr, value)
                if position is not None:
                    target.location = point(*position)
            for product_id, capacity, safety, tank in tank_ops:
                if tank is None:
                    target.tanks.append(
                        StationTank(product_id=product_id, capacity_l=capacity, safety_stock_l=safety)
                    )
                else:
                    tank.capacity_l, tank.safety_stock_l = capacity, safety

        return run


# === Dépôts =========================================================================================


class DepotsKind(RecordKind):
    kind = ImportKind.DEPOTS
    label = "Dépôts"
    roles = (Role.ADMIN,)
    spec = cols.DEPOTS
    record_model = DepotIn

    FIELDS = {
        "name": "name",
        "operator": "operator",
        "address": "address",
        "opening_hours": "opening_hours",
        "avg_wait_min": "avg_wait_min",
        "max_loadings_per_truck_day": "max_loadings_per_truck_day",
        "active": "active",
    }

    def fetch(self, source: ExcelImportSource, options: dict[str, Any]) -> list[DepotIn]:
        return source.fetch_depots()

    async def plan(self, session: AsyncSession, records: list[DepotIn], options: dict[str, Any]) -> Plan:
        plan = Plan()
        codes = [r.code for r in records]
        existing = {
            d.code.upper(): d
            for d in (await session.execute(select(Depot).where(func.upper(Depot.code).in_(codes)))).scalars()
        }
        for record in records:
            depot = existing.get(record.code)
            if depot is None and not _require_for_create(
                plan, record, self.spec, ("name", "lat", "lon"), f"le dépôt {record.code}"
            ):
                continue
            changes, updates = scalar_changes(depot, record, self.spec, self.FIELDS)
            position_changes, position = _position_changes(depot, record, self.spec)
            changes += position_changes
            if depot is not None and depot.deleted_at is not None:
                changes.insert(0, _REACTIVATED)
            label = f"{record.code} — {record.name or (depot.name if depot else '')}"
            item = ImportItem(
                row=record.row, key=record.code, label=label, action=_action(depot, changes), changes=changes
            )
            plan.steps.append(Step(item, self._run(depot, record, updates, position)))
        return plan

    @staticmethod
    def _run(depot: Depot | None, record: DepotIn, updates: dict, position: Any) -> Run:
        async def run(session: AsyncSession, batch: ImportBatch) -> None:
            if depot is None:
                session.add(Depot(code=record.code, location=point(*position), **updates))
                return
            depot.deleted_at = None
            for attr, value in updates.items():
                setattr(depot, attr, value)
            if position is not None:
                depot.location = point(*position)

        return run


# === Camions (avec compartiments) ===================================================================


def _allowed_label(ids: list[uuid.UUID] | None, codes: dict[uuid.UUID, str]) -> str:
    return "tous" if ids is None else ", ".join(sorted(codes.get(i, "?") for i in ids))


class TrucksKind(RecordKind):
    kind = ImportKind.TRUCKS
    label = "Camions"
    roles = (Role.ADMIN,)
    spec = cols.TRUCKS
    record_model = TruckIn

    FIELDS = {
        "size": "size",
        "total_capacity_l": "total_capacity_l",
        "avg_speed_kmh": "avg_speed_kmh",
        "status": "status",
        "cost_per_km": "cost_per_km",
        "notes": "notes",
    }

    def fetch(self, source: ExcelImportSource, options: dict[str, Any]) -> list[TruckIn]:
        return source.fetch_trucks()

    async def plan(self, session: AsyncSession, records: list[TruckIn], options: dict[str, Any]) -> Plan:
        plan = Plan()
        spec = self.spec
        products = await _products_by_code(session)
        codes = {p.id: p.code for p in products.values()}
        carriers = await _Carriers.load(session)
        plates = [r.plate for r in records]
        existing = {
            t.plate.upper(): t
            for t in (
                await session.execute(select(Truck).where(func.upper(Truck.plate).in_(plates)))
            ).scalars()
        }
        for record in records:
            truck = existing.get(record.plate)
            before = plan.error_count()
            if truck is None:
                _require_for_create(plan, record, spec, ("size",), f"le camion {record.plate}")
            changes, updates = scalar_changes(truck, record, spec, self.FIELDS)
            if truck is not None and truck.deleted_at is not None:
                changes.insert(0, _REACTIVATED)
            if record.carrier_name is not None:
                carriers.announce(
                    plan, record.row, spec.header("carrier_name"), record.carrier_name, record.carrier_type
                )
                current = carriers.name_of(truck.carrier_id) if truck is not None else None
                if truck is not None and (current or "").casefold() != record.carrier_name.casefold():
                    changes.append(
                        FieldChange(
                            field="carrier_id",
                            label=spec.header("carrier_name"),
                            before=current,
                            after=record.carrier_name,
                        )
                    )
            compartments = {c.position: c for c in truck.compartments} if truck is not None else {}
            capacities = {position: float(c.capacity_l) for position, c in compartments.items()}
            comp_ops: list[tuple[int, float, bool, list[uuid.UUID] | None, TruckCompartment | None]] = []
            for comp_in in record.compartments:
                compartment = compartments.get(comp_in.position)
                capacities[comp_in.position] = comp_in.capacity_l
                allowed_in = comp_in.allowed_product_codes
                set_allowed = allowed_in is not None or compartment is None
                allowed: list[uuid.UUID] | None = None
                if isinstance(allowed_in, list):
                    unknown = [code for code in allowed_in if code not in products]
                    for code in unknown:
                        _unknown_product(
                            plan, comp_in.row, spec.header("allowed_product_codes"), code, products
                        )
                    if unknown:
                        continue
                    allowed = [products[code].id for code in allowed_in]
                prefix = f"Compartiment {comp_in.position}"
                if compartment is None:
                    comp_ops.append((comp_in.position, comp_in.capacity_l, True, allowed, None))
                    if truck is not None:
                        changes.append(
                            FieldChange(
                                field=f"compartments[{comp_in.position}]",
                                label=f"{prefix} (nouveau)",
                                before=None,
                                after=f"{show(comp_in.capacity_l)} L, produits : "
                                f"{_allowed_label(allowed, codes)}",
                            )
                        )
                    continue
                comp_changes = []
                if not same(compartment.capacity_l, comp_in.capacity_l):
                    comp_changes.append(
                        FieldChange(
                            field=f"compartments[{comp_in.position}].capacity_l",
                            label=f"{prefix} — {spec.header('capacity_l')}",
                            before=show(compartment.capacity_l),
                            after=show(comp_in.capacity_l),
                        )
                    )
                old_allowed = compartment.allowed_product_ids
                if set_allowed and (
                    (old_allowed is None) != (allowed is None) or set(old_allowed or []) != set(allowed or [])
                ):
                    comp_changes.append(
                        FieldChange(
                            field=f"compartments[{comp_in.position}].allowed_product_ids",
                            label=f"{prefix} — {spec.header('allowed_product_codes')}",
                            before=_allowed_label(old_allowed, codes),
                            after=_allowed_label(allowed, codes),
                        )
                    )
                if comp_changes:
                    changes += comp_changes
                    comp_ops.append((comp_in.position, comp_in.capacity_l, set_allowed, allowed, compartment))

            total = record.total_capacity_l
            if total is None and truck is not None:
                total = float(truck.total_capacity_l)
            if total is None:
                if capacities:
                    total = sum(capacities.values())
                    updates["total_capacity_l"] = total
                else:
                    plan.error(
                        record.row,
                        spec.header("total_capacity_l"),
                        None,
                        f"Indiquez la capacité totale du camion {record.plate} ou ses compartiments.",
                    )
            if total is not None and capacities:
                gap = capacity_gap_message(total, capacities.values())
                if gap:
                    plan.error(record.row, spec.header("total_capacity_l"), total, gap)
                elif sum(capacities.values()) < total - 0.01:
                    plan.warning(
                        record.row,
                        spec.header("total_capacity_l"),
                        total,
                        f"La somme des compartiments ({show(sum(capacities.values()))} L) est "
                        f"inférieure à la capacité totale ({show(total)} L).",
                    )
            if plan.error_count() > before:
                continue
            item = ImportItem(
                row=record.row,
                key=record.plate,
                label=record.plate,
                action=_action(truck, changes),
                changes=changes,
            )
            plan.steps.append(Step(item, self._run(truck, record, updates, comp_ops, carriers)))
        return plan

    @staticmethod
    def _run(truck: Truck | None, record: TruckIn, updates: dict, comp_ops: list, carriers: _Carriers) -> Run:
        async def run(session: AsyncSession, batch: ImportBatch) -> None:
            carrier = None
            if record.carrier_name is not None:
                carrier = await carriers.get(session, record.carrier_name, record.carrier_type)
            target = truck
            if target is None:
                target = Truck(plate=record.plate, carrier_id=carrier.id if carrier else None, **updates)
                session.add(target)
            else:
                target.deleted_at = None
                for attr, value in updates.items():
                    setattr(target, attr, value)
                if carrier is not None:
                    target.carrier_id = carrier.id
            for position, capacity, set_allowed, allowed, compartment in comp_ops:
                if compartment is None:
                    target.compartments.append(
                        TruckCompartment(position=position, capacity_l=capacity, allowed_product_ids=allowed)
                    )
                else:
                    compartment.capacity_l = capacity
                    if set_allowed:
                        compartment.allowed_product_ids = allowed

        return run


# === Chauffeurs =====================================================================================


class DriversKind(RecordKind):
    kind = ImportKind.DRIVERS
    label = "Chauffeurs"
    roles = (Role.ADMIN,)
    spec = cols.DRIVERS
    record_model = DriverIn

    FIELDS = {
        "full_name": "full_name",
        "phone": "phone",
        "license_expiry": "license_expiry",
        "hazmat_cert": "hazmat_cert",
        "hazmat_expiry": "hazmat_expiry",
        "status": "status",
    }

    def fetch(self, source: ExcelImportSource, options: dict[str, Any]) -> list[DriverIn]:
        return source.fetch_drivers()

    async def plan(self, session: AsyncSession, records: list[DriverIn], options: dict[str, Any]) -> Plan:
        plan = Plan()
        spec = self.spec
        carriers = await _Carriers.load(session)
        licenses = [r.license_no.casefold() for r in records]
        existing = {
            d.license_no.casefold(): d
            for d in (
                await session.execute(select(Driver).where(func.lower(Driver.license_no).in_(licenses)))
            ).scalars()
        }
        plates = [r.default_truck_plate for r in records if r.default_truck_plate]
        trucks = {
            t.plate.upper(): t
            for t in (
                await session.execute(
                    select(Truck).where(func.upper(Truck.plate).in_(plates), Truck.deleted_at.is_(None))
                )
            ).scalars()
        }
        trucks_by_id = {t.id: t for t in trucks.values()}
        for record in records:
            driver = existing.get(record.license_no.casefold())
            before = plan.error_count()
            if driver is None:
                _require_for_create(plan, record, spec, ("full_name",), f"le chauffeur {record.license_no}")
            changes, updates = scalar_changes(driver, record, spec, self.FIELDS)
            if driver is not None and driver.deleted_at is not None:
                changes.insert(0, _REACTIVATED)
            if record.carrier_name is not None:
                carriers.announce(plan, record.row, spec.header("carrier_name"), record.carrier_name, None)
                current = carriers.name_of(driver.carrier_id) if driver is not None else None
                if driver is not None and (current or "").casefold() != record.carrier_name.casefold():
                    changes.append(
                        FieldChange(
                            field="carrier_id",
                            label=spec.header("carrier_name"),
                            before=current,
                            after=record.carrier_name,
                        )
                    )
            truck = None
            if record.default_truck_plate is not None:
                truck = trucks.get(record.default_truck_plate)
                if truck is None:
                    plan.error(
                        record.row,
                        spec.header("default_truck_plate"),
                        record.default_truck_plate,
                        f"Camion inconnu : « {record.default_truck_plate} ». Importez d'abord les camions.",
                    )
                elif driver is not None and driver.default_truck_id != truck.id:
                    if driver.default_truck_id and driver.default_truck_id not in trucks_by_id:
                        previous = await session.get(Truck, driver.default_truck_id)
                        if previous is not None:
                            trucks_by_id[previous.id] = previous
                    old = trucks_by_id.get(driver.default_truck_id)
                    changes.append(
                        FieldChange(
                            field="default_truck_id",
                            label=spec.header("default_truck_plate"),
                            before=old.plate if old else None,
                            after=truck.plate,
                        )
                    )
            if plan.error_count() > before:
                continue
            label = f"{record.full_name or (driver.full_name if driver else '')} ({record.license_no})"
            item = ImportItem(
                row=record.row,
                key=record.license_no,
                label=label,
                action=_action(driver, changes),
                changes=changes,
            )
            plan.steps.append(Step(item, self._run(driver, record, updates, truck, carriers)))
        return plan

    @staticmethod
    def _run(
        driver: Driver | None, record: DriverIn, updates: dict, truck: Truck | None, carriers: _Carriers
    ) -> Run:
        async def run(session: AsyncSession, batch: ImportBatch) -> None:
            carrier = None
            if record.carrier_name is not None:
                carrier = await carriers.get(session, record.carrier_name, None)
            if driver is None:
                session.add(
                    Driver(
                        license_no=record.license_no,
                        carrier_id=carrier.id if carrier else None,
                        default_truck_id=truck.id if truck else None,
                        **updates,
                    )
                )
                return
            driver.deleted_at = None
            for attr, value in updates.items():
                setattr(driver, attr, value)
            if carrier is not None:
                driver.carrier_id = carrier.id
            if truck is not None:
                driver.default_truck_id = truck.id

        return run


# === Commandes du jour ==============================================================================

_STATUS_LABELS = {
    OrderStatus.CONFIRMED: "confirmée",
    OrderStatus.PLANNED: "planifiée",
    OrderStatus.LOADED: "chargée",
    OrderStatus.DELIVERED: "livrée",
    OrderStatus.CANCELLED: "annulée",
    OrderStatus.POSTPONED: "reportée",
}
# Statuts terminaux d'une commande qui ne sera pas livrée ce jour-là.
_CLOSED = (OrderStatus.CANCELLED, OrderStatus.POSTPONED)


class OrdersKind(RecordKind):
    kind = ImportKind.ORDERS
    label = "Commandes"
    roles = (Role.DISPATCHER,)
    spec = cols.ORDERS
    record_model = OrderIn

    FIELDS = {
        "requested_l": "requested_l",
        "priority": "priority",
        "window_start": "window_start",
        "window_end": "window_end",
        "comment": "comment",
    }

    def parse_options(self, raw: dict[str, str]) -> dict[str, Any]:
        """`day=YYYY-MM-DD` (facultatif) : journée importée ; les lignes d'une autre date sont refusées."""
        if not raw.get("day"):
            return {}
        try:
            return {"day": date.fromisoformat(raw["day"]).isoformat()}
        except ValueError as exc:
            raise ValidationAppError(
                "Paramètre « day » invalide : date attendue au format AAAA-MM-JJ.",
                details=[{"field": "day", "value": raw["day"]}],
            ) from exc

    def fetch(self, source: ExcelImportSource, options: dict[str, Any]) -> list[OrderIn]:
        return source.fetch_orders(date.fromisoformat(options["day"]) if options.get("day") else None)

    async def plan(self, session: AsyncSession, records: list[OrderIn], options: dict[str, Any]) -> Plan:
        plan = Plan()
        spec = self.spec
        products = await _products_by_code(session)
        codes = {r.station_code for r in records}
        stations = {
            s.code.upper(): s
            for s in (
                await session.execute(
                    select(Station).where(func.upper(Station.code).in_(codes), Station.deleted_at.is_(None))
                )
            ).scalars()
        }
        existing: dict[tuple[date, uuid.UUID, uuid.UUID], list[Order]] = {}
        if records and stations:
            rows = await session.execute(
                select(Order)
                .where(
                    Order.day.in_({r.day for r in records}),
                    Order.station_id.in_([s.id for s in stations.values()]),
                )
                .order_by(Order.created_at, Order.id)
            )
            # Tous les statuts comptent : une ligne dont la clé correspond à une commande existante,
            # même reportée, annulée ou livrée, ne crée jamais de doublon (question L3-15).
            for order in rows.scalars():
                existing.setdefault((order.day, order.station_id, order.product_id), []).append(order)
        seen: dict[tuple[date, str, str], int] = {}
        for record in records:
            station = stations.get(record.station_code)
            product = products.get(record.product_code)
            if station is None:
                plan.error(
                    record.row,
                    spec.header("station_code"),
                    record.station_code,
                    f"Station inconnue : « {record.station_code} ». Vérifiez le code ou créez la station.",
                )
            if product is None:
                _unknown_product(plan, record.row, spec.header("product_code"), record.product_code, products)
            file_key = (record.day, record.station_code, record.product_code)
            if file_key in seen:
                plan.error(
                    record.row,
                    spec.header("station_code"),
                    record.station_code,
                    f"Doublon : même date, même station et même produit qu'à la ligne {seen[file_key]}. "
                    "Regroupez-les en une seule commande.",
                )
                continue
            seen[file_key] = record.row or 0
            if station is None or product is None:
                continue
            matches = existing.get((record.day, station.id, product.id), [])
            active = [o for o in matches if o.status not in _CLOSED]
            if len(active) > 1:
                plan.error(
                    record.row,
                    spec.header("station_code"),
                    record.station_code,
                    f"{len(active)} commandes existent déjà pour cette date, cette station et ce produit : "
                    "modifiez-les à l'écran Commandes.",
                )
                continue
            if active:
                order = active[0]
            else:
                # Seulement des commandes closes (reportées, annulées) : la ligne identique à l'une d'elles
                # est « inchangée », sinon on compare à la plus récente.
                closed = [o for o in matches if not scalar_changes(o, record, spec, self.FIELDS)[0]]
                order = (closed or matches)[-1] if matches else None
            changes, updates = scalar_changes(order, record, spec, self.FIELDS)
            status = _STATUS_LABELS.get(order.status, order.status.value) if order is not None else ""
            if order is not None and changes and order.status != OrderStatus.DRAFT:
                advice = (
                    "elle n'est ni recréée ni modifiée par l'import : saisissez une nouvelle commande à "
                    "l'écran Commandes si besoin."
                    if order.status in _CLOSED
                    else "modifiez-la à l'écran Commandes."
                )
                plan.error(
                    record.row,
                    spec.header("requested_l"),
                    record.requested_l,
                    f"Une commande {status} existe déjà pour cette date, cette station et ce produit, "
                    f"avec des valeurs différentes : {advice}",
                )
                continue
            if order is not None and order.status in _CLOSED:
                plan.warning(
                    record.row,
                    spec.header("station_code"),
                    record.station_code,
                    f"Une commande {status} existe déjà pour cette date, cette station et ce produit : "
                    "elle reste inchangée et n'est pas recréée.",
                )
            if not station.active:
                plan.warning(
                    record.row,
                    spec.header("station_code"),
                    station.code,
                    "Cette station est marquée inactive.",
                )
            if all(t.product_id != product.id for t in station.tanks):
                plan.warning(
                    record.row,
                    spec.header("product_code"),
                    product.code,
                    f"La station {station.code} n'a pas de cuve {product.code} dans le référentiel : "
                    "le volume ne pourra pas être contrôlé à la confirmation.",
                )
            item = ImportItem(
                row=record.row,
                key=f"{record.day.isoformat()}|{station.code}|{product.code}",
                label=f"{record.day.strftime('%d/%m/%Y')} — {station.code} — {product.code} — "
                f"{show(record.requested_l)} L",
                action=_action(order, changes),
                changes=changes,
            )
            plan.steps.append(Step(item, self._run(order, record, updates, station.id, product.id)))
        return plan

    @staticmethod
    def _run(
        order: Order | None, record: OrderIn, updates: dict, station_id: uuid.UUID, product_id: uuid.UUID
    ) -> Run:
        async def run(session: AsyncSession, batch: ImportBatch) -> None:
            if order is None:
                session.add(
                    Order(
                        day=record.day,
                        station_id=station_id,
                        product_id=product_id,
                        status=OrderStatus.DRAFT,
                        source=OrderSource.IMPORT,
                        import_batch_id=batch.id,
                        **updates,
                    )
                )
                return
            for attr, value in updates.items():
                setattr(order, attr, value)
            order.import_batch_id = batch.id

        return run


for _kind in (StationsKind(), DepotsKind(), TrucksKind(), DriversKind(), OrdersKind()):
    register_kind(_kind.handler())
