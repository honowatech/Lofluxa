"""API de la disponibilité du jour (F2.1 à F2.4) et résumé de la journée.

Lecture : tout rôle authentifié. Écriture : stocks dépôt → `supply` ; camions et chauffeurs →
`dispatcher` (`admin` passe partout).
"""

import uuid
from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.availability.models import DailyDepotStock, DailyResourceStatus, DailyTruckDriver
from app.availability.schemas import (
    DaySummaryOut,
    DepotStockEntryOut,
    DepotStockOut,
    DepotStocksIn,
    DriverDayOut,
    DriverDaysIn,
    DriversSummary,
    MissingStock,
    OrdersSummary,
    ResourceSummary,
    StocksSummary,
    TruckDayOut,
    TruckDaysIn,
)
from app.availability.service import (
    DriverDay,
    TruckDay,
    current_depot_stocks,
    depot_stock_counts,
    driver_domain,
    latest_depot_stock_entries,
    load_day_resources,
    record_depot_stock,
    truck_domain,
)
from app.core.deps import CurrentUser, Page, PageDep, PageParams, SessionDep, require_roles
from app.core.enums import OrderPriority, OrderStatus, Role
from app.core.errors import ConflictError, NotFoundError, RuleViolationError, ValidationAppError
from app.orders.models import Order
from app.planning.violations.eligibility import driver_block_reason, truck_block_reason
from app.referentials.models import Depot, Driver, Product, Truck
from app.users.models import User

router = APIRouter(tags=["disponibilité du jour"])


def _page[T](items: list[T], page: PageParams) -> dict:
    return {
        "items": items[page.offset : page.offset + page.limit],
        "total": len(items),
        "limit": page.limit,
        "offset": page.offset,
    }


def _duplicates(ids: list[uuid.UUID], field: str) -> None:
    if len(set(ids)) != len(ids):
        raise ValidationAppError(
            "La même ligne figure plusieurs fois dans la saisie.",
            details=[{"field": field, "message": "Doublon dans la saisie."}],
        )


# --- Stocks dépôt (F2.1) ---------------------------------------------------------------------


async def _stock_grid(session: AsyncSession, day: date) -> list[tuple[Depot, Product]]:
    """Couples (dépôt actif, produit) attendus chaque jour, triés par code."""
    depots = (
        (
            await session.execute(
                select(Depot).where(Depot.deleted_at.is_(None), Depot.active.is_(True)).order_by(Depot.code)
            )
        )
        .scalars()
        .all()
    )
    products = (
        (await session.execute(select(Product).where(Product.deleted_at.is_(None)).order_by(Product.code)))
        .scalars()
        .all()
    )
    return [(depot, product) for depot in depots for product in products]


async def _user_names(session: AsyncSession, user_ids: set[uuid.UUID | None]) -> dict[uuid.UUID, str]:
    ids = {uid for uid in user_ids if uid is not None}
    if not ids:
        return {}
    return dict((await session.execute(select(User.id, User.full_name).where(User.id.in_(ids)))).all())


async def _current_stock_rows(
    session: AsyncSession, day: date, pairs: list[tuple[Depot, Product]]
) -> list[DepotStockOut]:
    current = await latest_depot_stock_entries(session, day)  # effacements compris
    counts = await depot_stock_counts(session, day)
    names = await _user_names(session, {entry.entered_by for entry in current.values()})
    rows = []
    for depot, product in pairs:
        entry = current.get((depot.id, product.id))
        rows.append(
            DepotStockOut(
                id=entry.id if entry else None,
                day=day,
                depot_id=depot.id,
                depot_code=depot.code,
                depot_name=depot.name,
                product_id=product.id,
                product_code=product.code,
                product_label=product.label,
                available_l=float(entry.available_l) if entry and entry.available_l is not None else None,
                entered_at=entry.entered_at if entry else None,
                entered_by=entry.entered_by if entry else None,
                entered_by_name=names.get(entry.entered_by) if entry else None,
                history_count=counts.get((depot.id, product.id), 0),
            )
        )
    return rows


@router.get("/availability/depot-stocks", response_model=Page[DepotStockOut])
async def list_depot_stocks(
    day: date,
    session: SessionDep,
    _: CurrentUser,
    page: PageDep,
    depot_id: uuid.UUID | None = None,
    product_id: uuid.UUID | None = None,
) -> dict:
    """Valeur courante du stock pour chaque (dépôt actif, produit) : la saisie la plus récente
    fait foi ; `available_l` nul = non renseigné."""
    pairs = [
        (depot, product)
        for depot, product in await _stock_grid(session, day)
        if (depot_id is None or depot.id == depot_id) and (product_id is None or product.id == product_id)
    ]
    return _page(await _current_stock_rows(session, day, pairs), page)


@router.get("/availability/depot-stocks/history", response_model=Page[DepotStockEntryOut])
async def depot_stock_history(
    day: date,
    session: SessionDep,
    _: CurrentUser,
    page: PageDep,
    depot_id: uuid.UUID | None = None,
    product_id: uuid.UUID | None = None,
) -> Page[DepotStockEntryOut]:
    """Toutes les saisies du jour, de la plus récente à la plus ancienne."""
    conditions = [DailyDepotStock.day == day]
    if depot_id is not None:
        conditions.append(DailyDepotStock.depot_id == depot_id)
    if product_id is not None:
        conditions.append(DailyDepotStock.product_id == product_id)
    total = (
        await session.execute(select(func.count()).select_from(DailyDepotStock).where(*conditions))
    ).scalar_one()
    rows = (
        await session.execute(
            select(DailyDepotStock, Depot, Product)
            .join(Depot, Depot.id == DailyDepotStock.depot_id)
            .join(Product, Product.id == DailyDepotStock.product_id)
            .where(*conditions)
            .order_by(DailyDepotStock.entered_at.desc(), DailyDepotStock.id.desc())
            .limit(page.limit)
            .offset(page.offset)
        )
    ).all()
    current_ids = {entry.id for entry in (await latest_depot_stock_entries(session, day)).values()}
    names = await _user_names(session, {entry.entered_by for entry, _, _ in rows})
    items = [
        DepotStockEntryOut(
            id=entry.id,
            day=entry.day,
            depot_id=depot.id,
            depot_code=depot.code,
            depot_name=depot.name,
            product_id=product.id,
            product_code=product.code,
            product_label=product.label,
            available_l=None if entry.available_l is None else float(entry.available_l),
            entered_at=entry.entered_at,
            entered_by=entry.entered_by,
            entered_by_name=names.get(entry.entered_by),
            is_current=entry.id in current_ids,
        )
        for entry, depot, product in rows
    ]
    return Page[DepotStockEntryOut](items=items, total=total, limit=page.limit, offset=page.offset)


@router.put(
    "/availability/depot-stocks",
    response_model=list[DepotStockOut],
    dependencies=[Depends(require_roles(Role.SUPPLY))],
)
async def put_depot_stocks(
    day: date, payload: DepotStocksIn, session: SessionDep, user: CurrentUser
) -> list[DepotStockOut]:
    """Saisie Supply. Chaque valeur modifiée ajoute une ligne horodatée et signée ; les saisies
    précédentes sont conservées. `available_l: null` efface la saisie : le stock redevient
    « non renseigné » (l'historique garde la trace). Renvoie la valeur courante des couples saisis."""
    keys = [(item.depot_id, item.product_id) for item in payload.items]
    if len(set(keys)) != len(keys):
        raise ValidationAppError("Le même couple (dépôt, produit) figure plusieurs fois dans la saisie.")

    current = await current_depot_stocks(session, day)
    pairs: list[tuple[Depot, Product]] = []
    for item in payload.items:
        depot = await session.get(Depot, item.depot_id)
        if depot is None or depot.deleted_at is not None:
            raise NotFoundError("Dépôt introuvable.", details=[{"depot_id": str(item.depot_id)}])
        product = await session.get(Product, item.product_id)
        if product is None or product.deleted_at is not None:
            raise NotFoundError("Produit introuvable.", details=[{"product_id": str(item.product_id)}])
        pairs.append((depot, product))
        value = None if item.available_l is None else Decimal(str(item.available_l))
        previous = current.get((depot.id, product.id))  # None : jamais saisi, ou saisie effacée
        if value == (Decimal(previous.available_l) if previous is not None else None):
            continue  # valeur inchangée : pas de ligne d'historique supplémentaire
        await record_depot_stock(
            session, depot_id=depot.id, product_id=product.id, day=day, available_l=value, user_id=user.id
        )
    return await _current_stock_rows(session, day, pairs)


# --- Camions du jour (F2.2) ------------------------------------------------------------------


def _truck_out(item: TruckDay, day: date) -> TruckDayOut:
    truck = item.truck
    return TruckDayOut(
        truck_id=truck.id,
        day=day,
        plate=truck.plate,
        size=truck.size,
        total_capacity_l=float(truck.total_capacity_l),
        carrier_id=truck.carrier_id,
        carrier_name=item.carrier_name,
        status=truck.status,
        available_today=item.available_today,
        day_reason=item.day_reason,
        assignable=item.assignable,
        block_reason=item.block_reason,
        rule_code=None if item.assignable else "RM-04",
        driver_id=item.driver.id if item.driver else None,
        driver_name=item.driver.full_name if item.driver else None,
        assignment_source=item.assignment_source,
    )


def _driver_out(item: DriverDay, day: date) -> DriverDayOut:
    driver = item.driver
    return DriverDayOut(
        driver_id=driver.id,
        day=day,
        full_name=driver.full_name,
        phone=driver.phone,
        carrier_id=driver.carrier_id,
        carrier_name=item.carrier_name,
        status=driver.status,
        license_expiry=driver.license_expiry,
        hazmat_cert=driver.hazmat_cert,
        hazmat_expiry=driver.hazmat_expiry,
        available_today=item.available_today,
        day_reason=item.day_reason,
        assignable=item.assignable,
        block_reason=item.block_reason,
        rule_code="RM-03" if item.rm03_reason else None,
        default_truck_id=item.default_truck.id if item.default_truck else None,
        default_truck_plate=item.default_truck.plate if item.default_truck else None,
        truck_id=item.truck.id if item.truck else None,
        truck_plate=item.truck.plate if item.truck else None,
        assignment_source=item.assignment_source,
    )


@router.get("/availability/trucks", response_model=Page[TruckDayOut])
async def list_trucks(
    day: date, session: SessionDep, _: CurrentUser, page: PageDep, assignable: bool | None = None
) -> dict:
    """Tous les camions avec leur affectabilité pour J (RM-04) et leur chauffeur du jour."""
    resources = await load_day_resources(session, day)
    items = [
        _truck_out(item, day)
        for item in resources.trucks
        if assignable is None or item.assignable == assignable
    ]
    return _page(items, page)


async def _set_day_mark(
    session: AsyncSession, day: date, *, truck_id=None, driver_id=None, available: bool, reason: str | None
) -> None:
    """Pose ou retire le marquage « indisponible pour la journée » d'une ressource."""
    column = DailyResourceStatus.truck_id if truck_id else DailyResourceStatus.driver_id
    mark = (
        await session.execute(
            select(DailyResourceStatus).where(
                DailyResourceStatus.day == day, column == (truck_id or driver_id)
            )
        )
    ).scalar_one_or_none()
    if available:
        # Absence de ligne = disponible si le statut du référentiel le permet.
        if mark is not None:
            await session.delete(mark)
        return
    reason = (reason or "").strip() or None
    if mark is None:
        session.add(
            DailyResourceStatus(
                day=day, truck_id=truck_id, driver_id=driver_id, available=False, reason=reason
            )
        )
    else:
        mark.available, mark.reason = False, reason


async def _get_truck(session: AsyncSession, truck_id: uuid.UUID) -> Truck:
    truck = await session.get(Truck, truck_id)
    if truck is None or truck.deleted_at is not None:
        raise NotFoundError("Camion introuvable.", details=[{"truck_id": str(truck_id)}])
    return truck


@router.put(
    "/availability/trucks",
    response_model=list[TruckDayOut],
    dependencies=[Depends(require_roles(Role.DISPATCHER))],
)
async def put_trucks(day: date, payload: TruckDaysIn, session: SessionDep) -> list[TruckDayOut]:
    """Marque (`available: false`, avec motif) ou démarque (`available: true`) des camions pour J.
    Renvoie l'état du jour des camions modifiés."""
    ids = [item.truck_id for item in payload.items]
    _duplicates(ids, "truck_id")
    for item in payload.items:
        await _get_truck(session, item.truck_id)
        await _set_day_mark(
            session, day, truck_id=item.truck_id, available=item.available, reason=item.reason
        )
    await session.flush()
    by_id = {t.truck.id: t for t in (await load_day_resources(session, day)).trucks}
    return [_truck_out(by_id[truck_id], day) for truck_id in ids]


# --- Chauffeurs du jour (F2.3, F2.4) ---------------------------------------------------------


@router.get("/availability/drivers", response_model=Page[DriverDayOut])
async def list_drivers(
    day: date, session: SessionDep, _: CurrentUser, page: PageDep, assignable: bool | None = None
) -> dict:
    """Tous les chauffeurs avec leur affectabilité pour J (contrôle automatique RM-03 : permis ou
    habilitation expirés → non affectable, avec message) et leur camion du jour."""
    resources = await load_day_resources(session, day)
    items = [
        _driver_out(item, day)
        for item in resources.drivers
        if assignable is None or item.assignable == assignable
    ]
    return _page(items, page)


@router.put(
    "/availability/drivers",
    response_model=list[DriverDayOut],
    dependencies=[Depends(require_roles(Role.DISPATCHER))],
)
async def put_drivers(day: date, payload: DriverDaysIn, session: SessionDep) -> list[DriverDayOut]:
    """Marque / démarque des chauffeurs pour J et règle l'affectation chauffeur ↔ camion du jour.

    - `available` (+ `reason`) : marquage du jour ;
    - `truck_id` : affectation du jour (409 si le camion est déjà affecté à un autre chauffeur ;
      409 RM-03 / RM-04 si le chauffeur ou le camion n'est pas affectable) ; `null` = retour au
      camion habituel.
    Renvoie l'état du jour des chauffeurs modifiés."""
    ids = [item.driver_id for item in payload.items]
    _duplicates(ids, "driver_id")

    drivers: dict[uuid.UUID, Driver] = {}
    for item in payload.items:
        driver = await session.get(Driver, item.driver_id)
        if driver is None or driver.deleted_at is not None:
            raise NotFoundError("Chauffeur introuvable.", details=[{"driver_id": str(item.driver_id)}])
        drivers[driver.id] = driver
        if "available" in item.model_fields_set and item.available is not None:
            await _set_day_mark(
                session, day, driver_id=driver.id, available=item.available, reason=item.reason
            )

    # Affectations : on libère d'abord les lignes des chauffeurs concernés (permet un échange de
    # camions dans une même saisie), puis on pose les nouvelles en contrôlant les conflits.
    changes = {item.driver_id: item.truck_id for item in payload.items if "truck_id" in item.model_fields_set}
    if changes:
        existing = (
            (
                await session.execute(
                    select(DailyTruckDriver).where(
                        DailyTruckDriver.day == day, DailyTruckDriver.driver_id.in_(changes)
                    )
                )
            )
            .scalars()
            .all()
        )
        for row in existing:
            await session.delete(row)
        await session.flush()

        marks = await session.execute(
            select(DailyResourceStatus.truck_id).where(
                DailyResourceStatus.day == day,
                DailyResourceStatus.truck_id.is_not(None),
                DailyResourceStatus.available.is_(False),
            )
        )
        unavailable_trucks = set(marks.scalars())
        taken = {
            row.truck_id: row.driver_id
            for row in (
                await session.execute(select(DailyTruckDriver).where(DailyTruckDriver.day == day))
            ).scalars()
        }
        for driver_id, truck_id in changes.items():
            if truck_id is None:
                continue
            driver = drivers[driver_id]
            truck = await _get_truck(session, truck_id)
            if truck_id in taken:
                other = await session.get(Driver, taken[truck_id])
                raise ConflictError(
                    f"Le camion {truck.plate} est déjà affecté à {other.full_name} pour cette journée.",
                    code="truck_already_assigned",
                    details=[
                        {"truck_id": str(truck_id), "driver_id": str(taken[truck_id]), "day": day.isoformat()}
                    ],
                )
            reason = driver_block_reason(driver_domain(driver), day)
            if reason:
                raise RuleViolationError(
                    f"{driver.full_name} n'est pas affectable : {reason}",
                    [{"rule_code": "RM-03", "message": reason, "driver_id": str(driver_id)}],
                )
            reason = truck_block_reason(truck_domain(truck, truck_id not in unavailable_trucks))
            if reason:
                raise RuleViolationError(
                    f"Le camion {truck.plate} n'est pas affectable : {reason}",
                    [{"rule_code": "RM-04", "message": reason, "truck_id": str(truck_id)}],
                )
            session.add(DailyTruckDriver(day=day, truck_id=truck_id, driver_id=driver_id))
            taken[truck_id] = driver_id

    await session.flush()
    by_id = {d.driver.id: d for d in (await load_day_resources(session, day)).drivers}
    return [_driver_out(by_id[driver_id], day) for driver_id in ids]


# --- Résumé de la journée --------------------------------------------------------------------


@router.get("/availability/summary", response_model=DaySummaryOut)
async def day_summary(day: date, session: SessionDep, _: CurrentUser) -> DaySummaryOut:
    """Compteurs de l'écran « Journée » : commandes par statut, camions et chauffeurs affectables,
    stocks dépôt renseignés ou non."""
    by_status = {status.value: 0 for status in OrderStatus}
    rows = await session.execute(
        select(Order.status, func.count()).where(Order.day == day).group_by(Order.status)
    )
    for status, count in rows:
        by_status[OrderStatus(status).value] = count
    urgent_pending = (
        await session.execute(
            select(func.count())
            .select_from(Order)
            .where(
                Order.day == day,
                Order.priority == OrderPriority.URGENT,
                Order.status.in_([OrderStatus.DRAFT, OrderStatus.CONFIRMED]),
            )
        )
    ).scalar_one()

    resources = await load_day_resources(session, day)
    trucks_ok = sum(1 for t in resources.trucks if t.assignable)
    drivers_ok = [d for d in resources.drivers if d.assignable]

    pairs = await _stock_grid(session, day)
    current = await current_depot_stocks(session, day)
    missing = [(depot, product) for depot, product in pairs if (depot.id, product.id) not in current]
    entered = [
        current[(depot.id, product.id)] for depot, product in pairs if (depot.id, product.id) in current
    ]

    return DaySummaryOut(
        day=day,
        orders=OrdersSummary(
            total=sum(by_status.values()), by_status=by_status, urgent_pending=urgent_pending
        ),
        trucks=ResourceSummary(
            total=len(resources.trucks), assignable=trucks_ok, blocked=len(resources.trucks) - trucks_ok
        ),
        drivers=DriversSummary(
            total=len(resources.drivers),
            assignable=len(drivers_ok),
            blocked=len(resources.drivers) - len(drivers_ok),
            blocked_rm03=sum(1 for d in resources.drivers if d.rm03_reason),
            assignable_without_truck=sum(1 for d in drivers_ok if d.truck is None),
        ),
        depot_stocks=StocksSummary(
            expected=len(pairs),
            entered=len(entered),
            missing=len(missing),
            complete=bool(pairs) and not missing,
            last_entered_at=max((entry.entered_at for entry in entered), default=None),
            missing_items=[
                MissingStock(
                    depot_id=depot.id, depot_code=depot.code, product_id=product.id, product_code=product.code
                )
                for depot, product in missing
            ],
        ),
    )
