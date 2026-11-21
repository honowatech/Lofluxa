"""Routes des événements du jour (F6, spec §9) — lot L10.

Lecture : tous les rôles authentifiés. Écriture : `dispatcher` (panne, chauffeur, résolution d'une
pénurie), `supply` (déclaration d'une pénurie) ; `admin` passe partout.

Ajouts à la spec §9 (voir docs/questions/l10-evenements.md) : `GET /events/replacement-options`,
`GET /events/{event_id}`, `GET /events/{event_id}/impact`, `POST /events/{event_id}/resolve`.
"""

import uuid
from datetime import date, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.core.deps import CurrentUser, Page, PageDep, SessionDep, require_roles
from app.core.enums import EventType, Role
from app.core.settings_store import get_setting
from app.core.time import to_local, utcnow
from app.events import journal, service, shortage
from app.events.schemas import (
    DriverUnavailableIn,
    EventOut,
    EventResultOut,
    ProductShortageIn,
    ReplacementOptionsOut,
    ResolveIn,
    ResolveOut,
    ShortageOut,
    TruckBreakdownIn,
)
from app.users.models import User

router = APIRouter(tags=["événements"])

Dispatcher = Annotated[User, Depends(require_roles(Role.DISPATCHER))]
Supply = Annotated[User, Depends(require_roles(Role.SUPPLY))]


@router.post("/events/truck-breakdown", response_model=EventResultOut)
async def truck_breakdown(payload: TruckBreakdownIn, session: SessionDep, _: Dispatcher) -> EventResultOut:
    """F6.1, RM-19 : panne de camion sur une tournée publiée → les arrêts non livrés passent sur une
    nouvelle tournée du camion de remplacement, dans une nouvelle version du plan (RM-18)."""
    return await service.truck_breakdown(session, payload)


@router.post("/events/driver-unavailable", response_model=EventResultOut)
async def driver_unavailable(
    payload: DriverUnavailableIn, session: SessionDep, _: Dispatcher
) -> EventResultOut:
    """F6.2 : chauffeur indisponible → un remplaçant reprend la tournée, nouvelle version du plan."""
    return await service.driver_unavailable(session, payload)


@router.post("/events/product-shortage", response_model=ShortageOut)
async def product_shortage(payload: ProductShortageIn, session: SessionDep, user: Supply) -> ShortageOut:
    """F6.3 : Supply met à jour le stock d'un produit au dépôt ; les tournées impactées sont
    signalées avec leurs options (réduire, reporter, changer de dépôt)."""
    return await shortage.declare(session, payload, user)


@router.get("/events/replacement-options", response_model=ReplacementOptionsOut)
async def replacement_options(
    session: SessionDep,
    _: CurrentUser,
    trip_id: uuid.UUID,
    replacement_truck_id: Annotated[
        uuid.UUID | None,
        Query(description="Évalue les chauffeurs pour la tournée de remplacement de ce camion (F6.1)."),
    ] = None,
    occurred_at: Annotated[
        datetime | None, Query(description="Heure de l'événement (défaut : maintenant).")
    ] = None,
) -> ReplacementOptionsOut:
    """Assistant de réaffectation (écran 6) : camions et chauffeurs de remplacement possibles pour
    une tournée, avec le motif (`rule_code`) de ceux qui ne sont pas éligibles."""
    return await service.replacement_options(
        session, trip_id, replacement_truck_id=replacement_truck_id, occurred_at=occurred_at
    )


@router.get("/events", response_model=Page[EventOut])
async def list_events(
    session: SessionDep,
    _: CurrentUser,
    page: PageDep,
    day: Annotated[date | None, Query(description="Jour J (défaut : aujourd'hui, heure locale)")] = None,
    type: Annotated[list[EventType] | None, Query(description="Un ou plusieurs types d'événement.")] = None,
    trip_id: uuid.UUID | None = None,
    plan_id: uuid.UUID | None = None,
    include_versions: Annotated[
        bool, Query(description="Avec `plan_id` : toutes les versions de la lignée du plan.")
    ] = False,
) -> Page[EventOut]:
    """F6.4 : journal de la journée, du plus récent au plus ancien, tous modules confondus."""
    if day is None:
        day = to_local(utcnow(), await get_setting(session, "timezone")).date()
    return await journal.list_events(
        session, day, page, types=type, trip_id=trip_id, plan_id=plan_id, include_versions=include_versions
    )


@router.get("/events/{event_id}", response_model=EventOut)
async def get_event(event_id: uuid.UUID, session: SessionDep, _: CurrentUser) -> EventOut:
    event = await journal.get_event(session, event_id)
    return (await journal.events_out(session, [event]))[0]


@router.get("/events/{event_id}/impact", response_model=ShortageOut)
async def shortage_impact(event_id: uuid.UUID, session: SessionDep, _: CurrentUser) -> ShortageOut:
    """F6.3 : tournées encore impactées par une pénurie déclarée, avec leurs options à jour."""
    return await shortage.impact(session, event_id)


@router.post("/events/{event_id}/resolve", response_model=ResolveOut)
async def resolve_shortage(
    event_id: uuid.UUID, payload: ResolveIn, session: SessionDep, _: Dispatcher
) -> ResolveOut:
    """F6.3 : décisions du dispatcher sur les tournées impactées (réduire, reporter, changer de
    dépôt) → nouvelle version du plan, recontrôlée."""
    return await shortage.resolve(session, event_id, payload)
