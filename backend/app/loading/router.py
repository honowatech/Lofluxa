"""Routes du chargement au dépôt et des livraisons (F7, spec §9).

Lecture : tous les rôles authentifiés. Écriture : `fleet` et `dispatcher` (`admin` passe partout).
"""

import asyncio
import smtplib
import uuid
from datetime import date
from typing import Annotated

import structlog
from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response

from app.core.deps import CurrentUser, Page, PageDep, SessionDep, require_roles
from app.core.enums import Role
from app.core.errors import AppError, ConflictError, NotFoundError, ValidationAppError
from app.core.pdf import _fmt_date
from app.loading import mailer, service, sheet
from app.loading.schemas import (
    DeliveryStopOut,
    LoadingIn,
    LoadingOut,
    LoadingSheetEmailIn,
    LoadingSheetEmailOut,
    StopDeliveryIn,
    TripLoadingOut,
    TripStatusIn,
)
from app.users.models import User

log = structlog.get_logger()

router = APIRouter(tags=["chargement"])

Writer = Annotated[User, Depends(require_roles(Role.FLEET, Role.DISPATCHER))]


@router.get("/loadings", response_model=Page[TripLoadingOut])
async def list_loadings(
    session: SessionDep,
    _: CurrentUser,
    page: PageDep,
    day: Annotated[date | None, Query(description="Jour J (défaut : aujourd'hui, heure locale)")] = None,
    depot_id: uuid.UUID | None = None,
) -> Page[TripLoadingOut]:
    """Vue Fleet (écran 7) : tournées publiées du jour au dépôt, avec leur état de chargement."""
    return await service.list_trip_loadings(
        session, day or await service.today_local(session), depot_id, page
    )


@router.post("/trips/{trip_id}/loading", response_model=LoadingOut)
async def record_loading(
    trip_id: uuid.UUID, payload: LoadingIn, session: SessionDep, user: Writer
) -> LoadingOut:
    """Enregistre le chargement réel (F7.1) ; un nouvel envoi remplace le précédent."""
    return await service.record_loading(session, trip_id, payload, user)


@router.get("/trips/{trip_id}/loading", response_model=LoadingOut)
async def read_loading(trip_id: uuid.UUID, session: SessionDep, _: CurrentUser) -> LoadingOut:
    ctx = await service.load_trip_context(session, trip_id)
    if ctx.loading is None:
        raise NotFoundError("Aucun chargement enregistré pour cette tournée.", code="loading_not_found")
    return await service.loading_out(session, ctx)


@router.put("/trips/{trip_id}/status", response_model=TripLoadingOut)
async def change_trip_status(
    trip_id: uuid.UUID, payload: TripStatusIn, session: SessionDep, user: Writer
) -> TripLoadingOut:
    """planned → at_depot → loaded → in_progress → completed (F7.4) ; toute autre transition → 409."""
    return await service.change_trip_status(session, trip_id, payload, user)


@router.put("/stops/{stop_id}/delivery", response_model=DeliveryStopOut)
async def record_delivery(
    stop_id: uuid.UUID, payload: StopDeliveryIn, session: SessionDep, user: Writer
) -> DeliveryStopOut:
    """Arrêt livré (heures et volumes réels par commande) ou sauté (motif obligatoire)."""
    return await service.record_delivery(session, stop_id, payload, user)


async def _sheet(session: SessionDep, trip_id: uuid.UUID) -> tuple[service.TripContext, bytes]:
    ctx = await service.load_trip_context(session, trip_id)
    service.ensure_published(ctx.plan)
    if ctx.loading is None:
        raise ConflictError(
            "La fiche de chargement n'existe qu'une fois le chargement enregistré.", code="loading_missing"
        )
    context = await sheet.build_sheet_context(session, ctx)
    # WeasyPrint est synchrone et lourd : rendu dans un fil d'exécution.
    return ctx, await asyncio.to_thread(sheet.render_loading_sheet, context)


@router.get(
    "/trips/{trip_id}/loading-sheet.pdf",
    response_class=Response,
    responses={200: {"content": {"application/pdf": {}}}},
)
async def loading_sheet_pdf(trip_id: uuid.UUID, session: SessionDep, _: CurrentUser) -> Response:
    """Fiche de chargement PDF de la tournée (F7.3)."""
    ctx, pdf = await _sheet(session, trip_id)
    return Response(
        pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{sheet.sheet_filename(ctx)}"'},
    )


@router.post("/trips/{trip_id}/loading-sheet/email", response_model=LoadingSheetEmailOut)
async def email_loading_sheet(
    trip_id: uuid.UUID, session: SessionDep, _: Writer, payload: LoadingSheetEmailIn | None = None
) -> LoadingSheetEmailOut:
    """Envoie la fiche par e-mail aux gérants des stations de la tournée, ou aux destinataires fournis."""
    ctx, pdf = await _sheet(session, trip_id)
    stations = [ctx.stations[stop.station_id] for stop in ctx.trip.stops if stop.station_id in ctx.stations]
    without_email = [s.code for s in stations if not (s.contact_email or "").strip()]
    if payload is not None and payload.recipients:
        candidates = [str(address) for address in payload.recipients]
        without_email = []
    else:
        candidates = [s.contact_email.strip() for s in stations if (s.contact_email or "").strip()]
    recipients = list(dict.fromkeys(address.lower() for address in candidates))
    if not recipients:
        raise ValidationAppError(
            "Aucun destinataire : aucune station de la tournée n'a d'adresse e-mail de contact. "
            "Renseignez-la dans le référentiel ou fournissez des destinataires.",
            code="no_recipient",
        )
    plate = ctx.truck.plate if ctx.truck else "—"
    day = _fmt_date(ctx.plan.day)
    subject = f"Fiche de chargement — {plate} — {day}"
    body = (
        "Bonjour,\n\n"
        f"Veuillez trouver ci-joint la fiche de chargement du camion {plate} "
        f"(tournée n° {ctx.trip.seq} du {day}).\n\n"
        "Message automatique de Tournéo.\n"
    )
    try:
        await asyncio.to_thread(mailer.send_pdf, recipients, subject, body, pdf, sheet.sheet_filename(ctx))
    except (smtplib.SMTPException, OSError) as exc:
        log.warning("loading_sheet_email_failed", trip_id=str(trip_id), error=str(exc))
        raise AppError(
            "L'envoi de l'e-mail a échoué (serveur SMTP injoignable ou refus). Réessayez plus tard.",
            code="smtp_error",
            status_code=502,
        ) from exc
    return LoadingSheetEmailOut(sent_to=recipients, stations_without_email=without_email)
