"""Commandes du jour (F3) : machine à états des statuts et contrôle à la confirmation (F3.4).

Fonctions réutilisables par les autres lots
-------------------------------------------
Toutes prennent la session du lot appelant, modifient les objets par l'ORM, font un `flush`
et ne valident jamais la transaction (c'est l'appelant qui décide). Une transition interdite
lève `ConflictError` (409, code `invalid_order_transition`) et ne modifie rien. Elles sont
idempotentes : une commande déjà dans le statut visé est laissée telle quelle.

    await mark_planned(session, order_ids)      # publication d'un plan      confirmed → planned
    await mark_loaded(session, order_ids)       # chargement enregistré      planned   → loaded
    await mark_delivered(session, order_ids)    # livraison enregistrée      loaded    → delivered
    await mark_fully_delivered(session, ids)    # commande entièrement livrée (RM-16, lot L6)
                                                #   confirmed | planned | loaded → delivered
    await release_to_confirmed(session, ids)    # retirée d'un plan publié,  planned | loaded → confirmed
                                                #   ou arrêt non livré
    await mark_postponed(session, order_ids)    # report explicite (RM-15, F6.3)
                                                #   draft | confirmed | planned → postponed
    await set_orders_status(session, order_ids, target)   # forme générale des fonctions ci-dessus

Variante synchrone pour les tâches Celery : `set_orders_status_sync(session, order_ids, target)`.
Sur un objet déjà chargé : `apply_status(order, target)` (pure, sans accès base).
Lecture de la table des transitions : `ALLOWED_TRANSITIONS`, `can_transition(current, target)`.

Contrôle F3.4 : `await check_tank_capacity(session, station_id, product_id, requested_l)` ;
avertissements à afficher en lecture : `await order_warnings(session, orders)`
→ {order_id: [{code, message}]}.
"""

import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.core.enums import OrderStatus
from app.core.errors import ConflictError, NotFoundError
from app.orders.models import Order
from app.referentials.models import StationTank

S = OrderStatus

# Machine à états (F3.3). Source de vérité unique des transitions de statut d'une commande.
ALLOWED_TRANSITIONS: dict[OrderStatus, frozenset[OrderStatus]] = {
    S.DRAFT: frozenset({S.CONFIRMED, S.CANCELLED, S.POSTPONED}),
    S.CONFIRMED: frozenset({S.PLANNED, S.CANCELLED, S.POSTPONED}),
    S.PLANNED: frozenset({S.LOADED, S.CONFIRMED, S.POSTPONED}),
    S.LOADED: frozenset({S.DELIVERED, S.CONFIRMED}),
    S.DELIVERED: frozenset(),
    S.CANCELLED: frozenset(),
    S.POSTPONED: frozenset(),
}

# Statuts dans lesquels le dispatcher peut encore modifier, annuler ou reporter lui-même une commande.
EDITABLE_STATUSES = frozenset({S.DRAFT, S.CONFIRMED})

STATUS_FR = {
    S.DRAFT: "brouillon",
    S.CONFIRMED: "confirmée",
    S.PLANNED: "planifiée",
    S.LOADED: "chargée",
    S.DELIVERED: "livrée",
    S.CANCELLED: "annulée",
    S.POSTPONED: "reportée",
}


def can_transition(current: OrderStatus, target: OrderStatus) -> bool:
    return target in ALLOWED_TRANSITIONS[OrderStatus(current)]


def transition_error(order: Order, target: OrderStatus) -> ConflictError:
    return ConflictError(
        f"Transition interdite : une commande « {STATUS_FR[order.status]} » "
        f"ne peut pas passer à « {STATUS_FR[target]} ».",
        code="invalid_order_transition",
        details=[{"order_id": str(order.id), "from": order.status.value, "to": target.value}],
    )


def apply_status(order: Order, target: OrderStatus, *, idempotent: bool = True) -> bool:
    """Fait passer `order` à `target` si la machine à états l'autorise.

    Renvoie True si le statut a changé. Avec `idempotent=True`, une commande déjà dans le statut
    visé est laissée telle quelle (False) ; sinon c'est une transition interdite.
    """
    target = OrderStatus(target)
    if order.status == target and idempotent:
        return False
    if not can_transition(order.status, target):
        raise transition_error(order, target)
    order.status = target
    return True


def _apply_all(orders: list[Order], order_ids: list[uuid.UUID], target: OrderStatus) -> list[Order]:
    by_id = {order.id: order for order in orders}
    missing = [oid for oid in order_ids if oid not in by_id]
    if missing:
        raise NotFoundError("Commande introuvable.", details=[{"order_id": str(oid)} for oid in missing])
    target = OrderStatus(target)
    # Tout ou rien : on vérifie toutes les transitions avant d'en appliquer une seule.
    for order in orders:
        if order.status != target and not can_transition(order.status, target):
            raise transition_error(order, target)
    for order in orders:
        apply_status(order, target)
    return [by_id[oid] for oid in order_ids]


async def set_orders_status(
    session: AsyncSession, order_ids: Iterable[uuid.UUID], target: OrderStatus
) -> list[Order]:
    """Change le statut d'un lot de commandes (tout ou rien). Renvoie les commandes, dans l'ordre demandé."""
    ids = list(dict.fromkeys(order_ids))
    if not ids:
        return []
    rows = (await session.execute(select(Order).where(Order.id.in_(ids)).with_for_update())).scalars().all()
    orders = _apply_all(list(rows), ids, target)
    await session.flush()
    return orders


def set_orders_status_sync(
    session: Session, order_ids: Iterable[uuid.UUID], target: OrderStatus
) -> list[Order]:
    """Variante synchrone de `set_orders_status` (tâches Celery, scripts)."""
    ids = list(dict.fromkeys(order_ids))
    if not ids:
        return []
    rows = session.execute(select(Order).where(Order.id.in_(ids)).with_for_update()).scalars().all()
    orders = _apply_all(list(rows), ids, target)
    session.flush()
    return orders


async def mark_planned(session: AsyncSession, order_ids: Iterable[uuid.UUID]) -> list[Order]:
    """Publication d'un plan : `confirmed → planned`."""
    return await set_orders_status(session, order_ids, S.PLANNED)


async def mark_loaded(session: AsyncSession, order_ids: Iterable[uuid.UUID]) -> list[Order]:
    """Chargement enregistré au dépôt : `planned → loaded`."""
    return await set_orders_status(session, order_ids, S.LOADED)


async def mark_delivered(session: AsyncSession, order_ids: Iterable[uuid.UUID]) -> list[Order]:
    """Livraison enregistrée en station : `loaded → delivered`."""
    return await set_orders_status(session, order_ids, S.DELIVERED)


# Statuts d'où une commande **entièrement livrée** peut passer à `delivered` (lot L6, RM-16). Une
# commande planifiée en plusieurs fois reste `confirmed` (reliquat à replanifier) ou `planned` tant
# que tout n'est pas livré : sa dernière livraison la clôt sans passer par `loaded`.
FULLY_DELIVERED_FROM = frozenset({S.CONFIRMED, S.PLANNED, S.LOADED})


async def mark_fully_delivered(session: AsyncSession, order_ids: Iterable[uuid.UUID]) -> list[Order]:
    """Commande entièrement livrée (somme des livraisons réelles ≥ volume demandé) :
    `confirmed | planned | loaded → delivered`. Tout ou rien, idempotente ; les autres statuts
    lèvent `ConflictError` (409 `invalid_order_transition`). C'est l'appelant (enregistrement des
    livraisons, lot L6) qui établit que la commande est entièrement livrée."""
    ids = list(dict.fromkeys(order_ids))
    if not ids:
        return []
    rows = (await session.execute(select(Order).where(Order.id.in_(ids)).with_for_update())).scalars().all()
    by_id = {order.id: order for order in rows}
    missing = [oid for oid in ids if oid not in by_id]
    if missing:
        raise NotFoundError("Commande introuvable.", details=[{"order_id": str(oid)} for oid in missing])
    for order in rows:
        if order.status != S.DELIVERED and order.status not in FULLY_DELIVERED_FROM:
            raise transition_error(order, S.DELIVERED)
    for order in rows:
        order.status = S.DELIVERED
    await session.flush()
    return [by_id[oid] for oid in ids]


async def release_to_confirmed(session: AsyncSession, order_ids: Iterable[uuid.UUID]) -> list[Order]:
    """Commande sortie d'un plan publié ou non livrée : `planned | loaded → confirmed` (à replanifier)."""
    return await set_orders_status(session, order_ids, S.CONFIRMED)


async def mark_postponed(session: AsyncSession, order_ids: Iterable[uuid.UUID]) -> list[Order]:
    """Report explicite (RM-15, F6.3) : `draft | confirmed | planned → postponed`."""
    return await set_orders_status(session, order_ids, S.POSTPONED)


# --- F3.4 : contrôle à la confirmation -------------------------------------------------------


@dataclass(slots=True)
class TankCheck:
    """Résultat du contrôle F3.4 : `blocking` (message) si le volume dépasse, sinon avertissements."""

    blocking: str | None = None
    max_l: float | None = None
    warnings: list[dict[str, str]] = field(default_factory=list)


def _fmt_l(value: Decimal | float) -> str:
    return f"{float(value):,.0f}".replace(",", " ")


def evaluate_tank(tank: StationTank | None, requested_l: Decimal | float) -> TankCheck:
    """F3.4 (décision provisoire S1), sans accès base : volume demandé ≤ capacité de cuve − stock de
    sécurité si la cuve existe pour (station, produit) ; sinon avertissement non bloquant."""
    if tank is None:
        return TankCheck(
            warnings=[
                {
                    "code": "tank_unknown",
                    "message": "Cuve non renseignée pour cette station et ce produit : "
                    "le volume demandé n'a pas pu être contrôlé.",
                }
            ]
        )
    max_l = Decimal(tank.capacity_l) - Decimal(tank.safety_stock_l or 0)
    if Decimal(str(requested_l)) > max_l:
        return TankCheck(
            blocking=(
                f"Volume demandé ({_fmt_l(requested_l)} L) supérieur au volume recevable par la cuve "
                f"({_fmt_l(max_l)} L = capacité {_fmt_l(tank.capacity_l)} L − stock de sécurité "
                f"{_fmt_l(tank.safety_stock_l or 0)} L)."
            ),
            max_l=float(max_l),
        )
    return TankCheck(max_l=float(max_l))


async def check_tank_capacity(
    session: AsyncSession, station_id: uuid.UUID, product_id: uuid.UUID, requested_l: Decimal | float
) -> TankCheck:
    """Contrôle F3.4 d'une commande (voir `evaluate_tank`)."""
    tank = (
        await session.execute(
            select(StationTank).where(
                StationTank.station_id == station_id, StationTank.product_id == product_id
            )
        )
    ).scalar_one_or_none()
    return evaluate_tank(tank, requested_l)


def tank_warnings(order: Order, tanks: Iterable[StationTank]) -> list[dict[str, str]]:
    """Avertissements F3.4 d'une commande à afficher en lecture, à partir des cuves de sa station.
    Vide hors `draft` / `confirmed`.

    `tank_unknown` : cuve non renseignée ; `exceeds_tank_capacity` : volume supérieur au volume
    recevable (la confirmation sera refusée)."""
    if order.status not in EDITABLE_STATUSES:
        return []
    tank = next((t for t in tanks if t.product_id == order.product_id), None)
    check = evaluate_tank(tank, order.requested_l)
    if check.blocking:
        return [{"code": "exceeds_tank_capacity", "message": check.blocking}]
    return check.warnings


async def order_warnings(
    session: AsyncSession, orders: Iterable[Order]
) -> dict[uuid.UUID, list[dict[str, str]]]:
    """`tank_warnings` pour un lot de commandes : les cuves sont lues en une seule requête.
    Seules les commandes avec avertissement figurent."""
    concerned = [order for order in orders if order.status in EDITABLE_STATUSES]
    if not concerned:
        return {}
    tanks: dict[uuid.UUID, list[StationTank]] = {}
    for tank in (
        await session.execute(
            select(StationTank).where(StationTank.station_id.in_({o.station_id for o in concerned}))
        )
    ).scalars():
        tanks.setdefault(tank.station_id, []).append(tank)
    result = {order.id: tank_warnings(order, tanks.get(order.station_id, [])) for order in concerned}
    return {order_id: warnings for order_id, warnings in result.items() if warnings}
