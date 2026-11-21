"""API des commandes du jour (F3.1, F3.3, F3.4).

Lecture : tout rôle authentifié. Écriture : `dispatcher` (et `admin`).
Une commande n'est modifiable, annulable ou reportable par le dispatcher qu'en `draft` ou `confirmed` ;
les statuts `planned`, `loaded`, `delivered` sont posés par les autres modules (voir `service.py`).
"""

import uuid
from datetime import date
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, Page, PageDep, SessionDep, require_roles
from app.core.enums import OrderPriority, OrderSource, OrderStatus, Role
from app.core.errors import AppError, ConflictError, NotFoundError, ValidationAppError
from app.orders.models import Order
from app.orders.schemas import (
    BulkConfirmIn,
    BulkConfirmItem,
    BulkConfirmOut,
    BulkError,
    OrderIn,
    OrderOut,
    OrderPatch,
    OrderWarning,
)
from app.orders.service import (
    EDITABLE_STATUSES,
    STATUS_FR,
    apply_status,
    check_tank_capacity,
    order_warnings,
    transition_error,
)
from app.referentials.models import Product, Station

router = APIRouter(tags=["commandes"])

Dispatcher = Depends(require_roles(Role.DISPATCHER))


# --- Aides -----------------------------------------------------------------------------------


def _to_out(order: Order, station: Station, product: Product, warnings: list[dict] | None = None) -> OrderOut:
    return OrderOut(
        id=order.id,
        day=order.day,
        station_id=order.station_id,
        station_code=station.code,
        station_name=station.name,
        product_id=order.product_id,
        product_code=product.code,
        product_label=product.label,
        requested_l=float(order.requested_l),
        priority=order.priority,
        window_start=order.window_start,
        window_end=order.window_end,
        comment=order.comment,
        status=order.status,
        source=order.source,
        import_batch_id=order.import_batch_id,
        created_at=order.created_at,
        updated_at=order.updated_at,
        warnings=[OrderWarning(**w) for w in (warnings or [])],
    )


async def _get_order(session: AsyncSession, order_id: uuid.UUID) -> Order:
    order = await session.get(Order, order_id)
    if order is None:
        raise NotFoundError("Commande introuvable.")
    return order


async def _labels(session: AsyncSession, order: Order) -> tuple[Station, Product]:
    station = await session.get(Station, order.station_id)
    product = await session.get(Product, order.product_id)
    return station, product


async def _out(session: AsyncSession, order: Order) -> OrderOut:
    """Commande avec ses libellés et ses avertissements F3.4 (commandes `draft` et `confirmed`)."""
    warnings = (await order_warnings(session, [order])).get(order.id)
    return _to_out(order, *await _labels(session, order), warnings)


async def _usable_station(session: AsyncSession, station_id: uuid.UUID) -> Station:
    station = await session.get(Station, station_id)
    if station is None or station.deleted_at is not None:
        raise ValidationAppError(
            "Station inconnue.", details=[{"field": "station_id", "message": "Station inconnue."}]
        )
    if not station.active:
        raise ValidationAppError(
            f"La station {station.code} est inactive.",
            details=[{"field": "station_id", "message": "Station inactive."}],
        )
    return station


async def _usable_product(session: AsyncSession, product_id: uuid.UUID) -> Product:
    product = await session.get(Product, product_id)
    if product is None or product.deleted_at is not None:
        raise ValidationAppError(
            "Produit inconnu.", details=[{"field": "product_id", "message": "Produit inconnu."}]
        )
    return product


def _require_editable(order: Order, action: str) -> None:
    if order.status not in EDITABLE_STATUSES:
        raise ConflictError(
            f"Une commande « {STATUS_FR[order.status]} » ne peut plus être {action} : "
            "seules les commandes en brouillon ou confirmées le peuvent.",
            code="order_not_editable",
            details=[{"order_id": str(order.id), "status": order.status.value}],
        )


def _capacity_error(order_id: uuid.UUID, message: str, max_l: float | None) -> ValidationAppError:
    return ValidationAppError(
        message,
        code="order_exceeds_tank_capacity",
        details=[{"order_id": str(order_id), "field": "requested_l", "message": message, "max_l": max_l}],
    )


async def _save(session: AsyncSession, order: Order) -> None:
    await session.flush()
    await session.refresh(order)


# --- Lecture ---------------------------------------------------------------------------------


@router.get("/orders", response_model=Page[OrderOut])
async def list_orders(
    session: SessionDep,
    _: CurrentUser,
    page: PageDep,
    day: date | None = None,
    station_id: uuid.UUID | None = None,
    product_id: uuid.UUID | None = None,
    status: Annotated[
        list[OrderStatus] | None, Query(description="Répétable : ?status=draft&status=…")
    ] = None,
    priority: OrderPriority | None = None,
) -> Page[OrderOut]:
    """Commandes, filtrables par jour, station, produit, statut(s) et priorité."""
    conditions = []
    if day is not None:
        conditions.append(Order.day == day)
    if station_id is not None:
        conditions.append(Order.station_id == station_id)
    if product_id is not None:
        conditions.append(Order.product_id == product_id)
    if status:
        conditions.append(Order.status.in_(status))
    if priority is not None:
        conditions.append(Order.priority == priority)

    total = (await session.execute(select(func.count()).select_from(Order).where(*conditions))).scalar_one()
    rows = (
        await session.execute(
            select(Order, Station, Product)
            .join(Station, Station.id == Order.station_id)
            .join(Product, Product.id == Order.product_id)
            .where(*conditions)
            .order_by(Order.day, Order.id)
            .limit(page.limit)
            .offset(page.offset)
        )
    ).all()
    # Avertissements F3.4 : les cuves de toutes les commandes de la page sont lues en une requête.
    warnings = await order_warnings(session, [order for order, _, _ in rows])
    return Page[OrderOut](
        items=[_to_out(order, station, product, warnings.get(order.id)) for order, station, product in rows],
        total=total,
        limit=page.limit,
        offset=page.offset,
    )


@router.get("/orders/{order_id}", response_model=OrderOut)
async def get_order(order_id: uuid.UUID, session: SessionDep, _: CurrentUser) -> OrderOut:
    order = await _get_order(session, order_id)
    return await _out(session, order)


# --- Écriture --------------------------------------------------------------------------------


@router.post("/orders", response_model=OrderOut, status_code=201, dependencies=[Dispatcher])
async def create_order(payload: OrderIn, session: SessionDep) -> OrderOut:
    """Saisie manuelle (F3.1) : la commande est créée en brouillon."""
    station = await _usable_station(session, payload.station_id)
    product = await _usable_product(session, payload.product_id)
    order = Order(
        day=payload.day,
        station_id=station.id,
        product_id=product.id,
        requested_l=Decimal(str(payload.requested_l)),
        priority=payload.priority,
        window_start=payload.window_start,
        window_end=payload.window_end,
        comment=payload.comment,
        status=OrderStatus.DRAFT,
        source=OrderSource.MANUAL,
    )
    session.add(order)
    await _save(session, order)
    return await _out(session, order)


async def _update(session: AsyncSession, order_id: uuid.UUID, changes: dict) -> OrderOut:
    order = await _get_order(session, order_id)
    _require_editable(order, "modifiée")

    if "station_id" in changes and changes["station_id"] != order.station_id:
        await _usable_station(session, changes["station_id"])
    if "product_id" in changes and changes["product_id"] != order.product_id:
        await _usable_product(session, changes["product_id"])
    for name in ("day", "station_id", "product_id", "requested_l", "priority"):
        if name in changes and changes[name] is None:
            raise ValidationAppError(
                "Requête invalide.", details=[{"field": name, "message": "Ce champ ne peut pas être vide."}]
            )
    if "requested_l" in changes:
        changes["requested_l"] = Decimal(str(changes["requested_l"]))
    for name, value in changes.items():
        setattr(order, name, value)
    if order.window_start and order.window_end and order.window_start >= order.window_end:
        message = "La fenêtre de livraison est incohérente : le début doit précéder la fin."
        raise ValidationAppError(message, details=[{"field": "window_start", "message": message}])

    if order.status == OrderStatus.CONFIRMED:
        # Une commande confirmée doit continuer à respecter le contrôle F3.4.
        check = await check_tank_capacity(session, order.station_id, order.product_id, order.requested_l)
        if check.blocking:
            raise _capacity_error(order.id, check.blocking, check.max_l)
    await _save(session, order)
    return await _out(session, order)


@router.put("/orders/{order_id}", response_model=OrderOut, dependencies=[Dispatcher])
async def replace_order(order_id: uuid.UUID, payload: OrderIn, session: SessionDep) -> OrderOut:
    """Remplace tous les champs saisissables d'une commande `draft` ou `confirmed`."""
    return await _update(session, order_id, {name: getattr(payload, name) for name in OrderIn.model_fields})


@router.patch("/orders/{order_id}", response_model=OrderOut, dependencies=[Dispatcher])
async def patch_order(order_id: uuid.UUID, payload: OrderPatch, session: SessionDep) -> OrderOut:
    """Modifie les seuls champs fournis d'une commande `draft` ou `confirmed`."""
    return await _update(
        session, order_id, {name: getattr(payload, name) for name in payload.model_fields_set}
    )


@router.delete("/orders/{order_id}", status_code=204, dependencies=[Dispatcher])
async def delete_order(order_id: uuid.UUID, session: SessionDep) -> None:
    """Supprime une commande en brouillon. Au-delà, il faut l'annuler (la trace est conservée)."""
    order = await _get_order(session, order_id)
    if order.status != OrderStatus.DRAFT:
        raise ConflictError(
            f"Une commande « {STATUS_FR[order.status]} » ne peut pas être supprimée : annulez-la.",
            code="order_not_deletable",
            details=[{"order_id": str(order.id), "status": order.status.value}],
        )
    await session.delete(order)
    await session.flush()


# --- Transitions de statut -------------------------------------------------------------------


async def _confirm(session: AsyncSession, order: Order) -> None:
    """Confirme une commande (F3.4). Lève une erreur si la transition ou le volume est refusé."""
    if order.status != OrderStatus.DRAFT:
        raise transition_error(order, OrderStatus.CONFIRMED)
    check = await check_tank_capacity(session, order.station_id, order.product_id, order.requested_l)
    if check.blocking:
        raise _capacity_error(order.id, check.blocking, check.max_l)
    apply_status(order, OrderStatus.CONFIRMED, idempotent=False)


@router.post("/orders/confirm", response_model=BulkConfirmOut, dependencies=[Dispatcher])
async def confirm_orders(payload: BulkConfirmIn, session: SessionDep) -> BulkConfirmOut:
    """Confirmation en masse : chaque commande est traitée indépendamment, avec son propre résultat."""
    ids = list(dict.fromkeys(payload.order_ids))
    orders = {
        order.id: order for order in (await session.execute(select(Order).where(Order.id.in_(ids)))).scalars()
    }
    outcomes: list[tuple[uuid.UUID, Order | None, AppError | None]] = []
    for order_id in ids:
        order = orders.get(order_id)
        if order is None:
            outcomes.append((order_id, None, NotFoundError("Commande introuvable.")))
            continue
        try:
            await _confirm(session, order)
            outcomes.append((order_id, order, None))
        except AppError as exc:
            outcomes.append((order_id, order, exc))
    await session.flush()

    results = []
    for order_id, order, error in outcomes:
        if error is not None:
            results.append(
                BulkConfirmItem(
                    order_id=order_id, ok=False, error=BulkError(code=error.code, message=error.message)
                )
            )
            continue
        await session.refresh(order)
        out = await _out(session, order)
        results.append(BulkConfirmItem(order_id=order_id, ok=True, order=out, warnings=out.warnings))
    confirmed = sum(1 for item in results if item.ok)
    return BulkConfirmOut(confirmed=confirmed, failed=len(results) - confirmed, results=results)


@router.post("/orders/{order_id}/confirm", response_model=OrderOut, dependencies=[Dispatcher])
async def confirm_order(order_id: uuid.UUID, session: SessionDep) -> OrderOut:
    """`draft → confirmed`, avec le contrôle de volume F3.4 (bloquant si la cuve est connue,
    avertissement dans `warnings` sinon)."""
    order = await _get_order(session, order_id)
    await _confirm(session, order)
    await _save(session, order)
    return await _out(session, order)


async def _user_transition(session: AsyncSession, order_id: uuid.UUID, target: OrderStatus) -> OrderOut:
    order = await _get_order(session, order_id)
    if order.status not in EDITABLE_STATUSES:
        raise transition_error(order, target)
    apply_status(order, target, idempotent=False)
    await _save(session, order)
    # Les plans brouillons qui portent cette commande sont recontrôlés (RM-15) — service de plans, lot L5.
    from app.planning import service as plan_service

    await plan_service.recheck_drafts_for_orders(session, [order.id])
    return await _out(session, order)


@router.post("/orders/{order_id}/cancel", response_model=OrderOut, dependencies=[Dispatcher])
async def cancel_order(order_id: uuid.UUID, session: SessionDep) -> OrderOut:
    """`draft | confirmed → cancelled`."""
    return await _user_transition(session, order_id, OrderStatus.CANCELLED)


@router.post("/orders/{order_id}/postpone", response_model=OrderOut, dependencies=[Dispatcher])
async def postpone_order(order_id: uuid.UUID, session: SessionDep) -> OrderOut:
    """`draft | confirmed → postponed` (report explicite, RM-15)."""
    return await _user_transition(session, order_id, OrderStatus.POSTPONED)
