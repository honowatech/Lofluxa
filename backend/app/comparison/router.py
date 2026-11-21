"""Routes F8 : journée de référence, rejeu, comparaison A/B (+ PDF), tableau de bord du jour.

Lecture : tout rôle authentifié (le `manager` consulte et exporte).
Import de la journée de référence et rejeu : `dispatcher` (et `admin`).
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from fastapi.responses import JSONResponse, Response

from app.comparison import dashboard as dashboard_service
from app.comparison import reference_day as reference_day_service
from app.comparison import report
from app.comparison import service as comparison_service
from app.comparison.schemas import ComparisonOut, DashboardOut, ReferenceDayImportOut, ReplayOut
from app.core.deps import CurrentUser, SessionDep, get_current_user, require_roles
from app.core.enums import ImportStatus, Role
from app.core.errors import envelope
from app.core.settings_store import load_settings

router = APIRouter(tags=["comparaison"])

_read = [Depends(get_current_user)]
_write = [Depends(require_roles(Role.DISPATCHER))]


@router.post(
    "/reference-days/import",
    response_model=ReferenceDayImportOut,
    status_code=201,
    dependencies=_write,
    summary="Importer une journée de référence (journée A réelle)",
    responses={
        200: {"description": "Contrôle seul (`dry_run`) : rapport sans création."},
        409: {"description": "Une journée de référence existe déjà pour cette date."},
        422: {"description": "Fichier rejeté : rapport d'erreurs ligne par ligne dans `details`."},
    },
)
async def import_reference_day(
    session: SessionDep,
    file: Annotated[UploadFile, File(description="Classeur au format `reference_day.xlsx`")],
    day: Annotated[date | None, Form(description="Date de la journée (prime sur le fichier)")] = None,
    prep_time_min: Annotated[
        float | None, Form(ge=0, description="Temps de préparation du plan manuel, en minutes")
    ] = None,
    label: Annotated[str | None, Form(max_length=160)] = None,
    dry_run: Annotated[bool, Form(description="Contrôler le fichier sans rien créer")] = False,
    replace: Annotated[bool, Form(description="Remplacer la journée de référence existante")] = False,
) -> Response | ReferenceDayImportOut:
    outcome = await reference_day_service.import_reference_day(
        session,
        content=await file.read(),
        filename=file.filename or "reference_day.xlsx",
        day=day,
        prep_time_min=prep_time_min,
        label=label or None,
        dry_run=dry_run,
        replace=replace,
    )
    body = ReferenceDayImportOut(
        batch_id=outcome.batch.id,
        status=outcome.status,
        plan_id=outcome.plan.id if outcome.plan else None,
        day=outcome.day,
        row_count=outcome.batch.row_count,
        error_count=outcome.batch.error_count,
        errors=outcome.errors,
        warnings=outcome.warnings,
        summary=outcome.summary,
    )
    if outcome.status == ImportStatus.REJECTED:
        # Réponse construite à la main (pas d'exception) : le lot `rejected` et son rapport sont conservés.
        payload = body.model_dump(mode="json")
        return JSONResponse(
            {
                **envelope(
                    "import_rejected",
                    f"Fichier rejeté : {outcome.batch.error_count} erreur(s). Aucune donnée n'a été créée.",
                    payload["errors"],
                ),
                **payload,
            },
            status_code=422,
        )
    if outcome.status == ImportStatus.PREVIEWED:
        return JSONResponse(body.model_dump(mode="json"), status_code=200)
    return body


@router.post(
    "/plans/{plan_id}/replay",
    response_model=ReplayOut,
    status_code=202,
    dependencies=_write,
    summary="Rejouer une journée de référence avec le moteur (plan `replay`)",
)
async def replay_plan(plan_id: uuid.UUID, session: SessionDep, user: CurrentUser) -> ReplayOut:
    task_id = await comparison_service.replay_reference(session, plan_id, user_id=user.id)
    return ReplayOut(task_id=task_id)


@router.get(
    "/comparison",
    response_model=ComparisonOut,
    dependencies=_read,
    summary="Tableau comparatif entre deux plans (métriques, écarts, verdict, tracés)",
)
async def get_comparison(
    session: SessionDep,
    plan_a: Annotated[uuid.UUID, Query(description="Plan de référence (A)")],
    plan_b: Annotated[uuid.UUID, Query(description="Plan comparé (B)")],
) -> ComparisonOut:
    return ComparisonOut.model_validate(await comparison_service.build_comparison(session, plan_a, plan_b))


@router.get(
    "/comparison.pdf",
    dependencies=_read,
    summary="Rapport comparatif A/B en PDF (synthèse, cartes, annexes par tournée)",
    response_class=Response,
    responses={200: {"content": {"application/pdf": {}}}},
)
async def get_comparison_pdf(
    session: SessionDep,
    plan_a: Annotated[uuid.UUID, Query(description="Plan de référence (A)")],
    plan_b: Annotated[uuid.UUID, Query(description="Plan comparé (B)")],
) -> Response:
    comparison = await comparison_service.build_comparison(session, plan_a, plan_b)
    settings = await load_settings(session)
    pdf = await asyncio.to_thread(report.render_comparison_pdf, comparison, settings)
    day = comparison["plan_a"]["day"].isoformat()
    return Response(
        pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="comparaison_AB_{day}.pdf"'},
    )


@router.get(
    "/dashboard",
    response_model=DashboardOut,
    dependencies=_read,
    summary="Tableau de bord du jour : avancement, retards estimés, alertes actives",
)
async def get_dashboard(
    session: SessionDep,
    day: Annotated[date, Query(description="Jour J (AAAA-MM-JJ)")],
) -> DashboardOut:
    return DashboardOut.model_validate(await dashboard_service.build_dashboard(session, day))
