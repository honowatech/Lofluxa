"""API des imports (F1.6, F3.2) : prévisualiser puis appliquer, fichiers modèles.

    POST /imports/{kind}/preview      (multipart : champ `file`, xlsx ou csv) → lot + rapport
    POST /imports/{batch_id}/apply    → applique un lot prévisualisé sans erreur
    GET  /imports/templates/{kind}    → fichier modèle (.xlsx ; `?format=csv` pour la variante CSV)
    GET  /imports                     → historique paginé des lots
    GET  /imports/{batch_id}          → un lot et son rapport

Le routeur ne connaît aucun kind : il délègue au registre (`app/imports/registry.py`). Droits : ceux du
kind (référentiels : `admin` ; commandes : `dispatcher`) ; lecture des lots et des modèles : tout rôle
authentifié.
"""

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Query, Request, UploadFile
from fastapi.responses import Response
from sqlalchemy import select

from app.core.deps import CurrentUser, Page, PageDep, SessionDep, get_current_user
from app.core.enums import ImportKind, ImportStatus, Role
from app.core.errors import ConflictError, ForbiddenError, NotFoundError, ValidationAppError
from app.core.settings_store import get_setting
from app.core.time import utcnow
from app.imports.columns import SPECS
from app.imports.models import ImportBatch
from app.imports.registry import KindHandler, UploadedFile, get_kind
from app.imports.schemas import (
    ImportBatchOut,
    ImportBatchSummaryOut,
    ImportReportOut,
    ImportSummary,
)
from app.imports.tabular import FileError
from app.imports.templates import build_csv_template
from app.referentials.service import paginate
from app.users.models import User

router = APIRouter(tags=["imports"], dependencies=[Depends(get_current_user)])

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _handler(kind: ImportKind) -> KindHandler:
    handler = get_kind(kind)
    if handler is None:
        raise NotFoundError(f"L'import « {kind.value} » n'est pas disponible.", code="unknown_import_kind")
    return handler


def _check_role(handler: KindHandler, user: User) -> None:
    if user.role != Role.ADMIN and user.role not in handler.roles:
        raise ForbiddenError(f"Votre rôle ne permet pas l'import « {handler.label} ».")


def _summary(report: dict[str, Any]) -> ImportSummary:
    return ImportSummary.model_validate(report.get("summary", {}))


def _batch_out(batch: ImportBatch, *, include_data: bool = False) -> ImportBatchOut:
    report = batch.report or {}
    return ImportBatchOut(
        id=batch.id,
        batch_id=batch.id,
        kind=batch.kind,
        filename=batch.filename,
        status=batch.status,
        row_count=batch.row_count,
        error_count=batch.error_count,
        can_apply=batch.status == ImportStatus.PREVIEWED,
        created_at=batch.created_at,
        created_by=batch.created_by,
        report=ImportReportOut(
            summary=_summary(report),
            issues=report.get("issues", []),
            items=report.get("items", []),
            data=report.get("data", []) if include_data else None,
            options=report.get("options", {}),
            applied=report.get("applied"),
        ),
    )


@router.post("/imports/{kind}/preview", response_model=ImportBatchOut, status_code=201)
async def preview_import(
    kind: ImportKind,
    request: Request,
    session: SessionDep,
    user: CurrentUser,
    file: Annotated[UploadFile, File(description="Fichier .xlsx ou .csv conforme au modèle")],
    include_data: Annotated[bool, Query(description="Renvoyer aussi les données normalisées")] = False,
) -> ImportBatchOut:
    """Lit et contrôle le fichier sans rien modifier, et enregistre le lot avec son rapport.

    Le rapport liste les anomalies ligne par ligne et annonce chaque création / mise à jour. Le lot est
    `previewed` (applicable) s'il n'y a aucune erreur, sinon `rejected` : corriger le fichier et recommencer.
    Les paramètres de requête propres au kind sont transmis tels quels (ex. `day=AAAA-MM-JJ` pour `orders`).
    """
    handler = _handler(kind)
    _check_role(handler, user)
    max_mb = float(await get_setting(session, "import_max_file_mb"))
    content = await file.read()
    if len(content) > max_mb * 1024 * 1024:
        raise ValidationAppError(
            f"Fichier trop volumineux : {max_mb:g} Mo au plus.",
            code="file_too_large",
            status_code=413,
            details=[{"field": "file", "value": len(content)}],
        )
    filename = (file.filename or f"{kind.value}.xlsx")[:255]
    options = {k: v for k, v in request.query_params.items() if k != "include_data"}
    try:
        result = await handler.preview(session, UploadedFile(content=content, filename=filename), options)
    except FileError as exc:
        raise ValidationAppError(str(exc), code="invalid_file") from exc

    errors = sum(1 for issue in result.issues if issue.severity == "error")
    summary = ImportSummary(
        created=sum(1 for item in result.items if item.action == "create"),
        updated=sum(1 for item in result.items if item.action == "update"),
        unchanged=sum(1 for item in result.items if item.action == "unchanged"),
        errors=errors,
        warnings=len(result.issues) - errors,
    )
    batch = ImportBatch(
        kind=kind,
        filename=filename,
        status=ImportStatus.REJECTED if errors else ImportStatus.PREVIEWED,
        row_count=result.row_count,
        error_count=errors,
        report={
            "summary": summary.model_dump(),
            "issues": [issue.model_dump() for issue in result.issues],
            "items": [item.model_dump(mode="json") for item in result.items],
            "data": result.data,
            "options": result.options,
        },
    )
    session.add(batch)
    await session.flush()
    await session.refresh(batch)
    return _batch_out(batch, include_data=include_data)


@router.post("/imports/{batch_id}/apply", response_model=ImportBatchOut)
async def apply_import(batch_id: uuid.UUID, session: SessionDep, user: CurrentUser) -> ImportBatchOut:
    """Applique un lot prévisualisé. Refus (409) s'il contient des erreurs, s'il a déjà été appliqué, ou
    si la base a changé depuis la prévisualisation (`stale_preview`)."""
    batch = (
        await session.execute(select(ImportBatch).where(ImportBatch.id == batch_id).with_for_update())
    ).scalar_one_or_none()
    if batch is None:
        raise NotFoundError("Lot d'import introuvable.")
    handler = _handler(batch.kind)
    _check_role(handler, user)
    if batch.status == ImportStatus.APPLIED:
        raise ConflictError(
            "Ce lot a déjà été appliqué : il ne peut pas l'être une seconde fois.", code="already_applied"
        )
    if batch.status != ImportStatus.PREVIEWED:
        raise ConflictError(
            f"Ce lot contient {batch.error_count} erreur(s) : corrigez le fichier puis prévisualisez-le.",
            code="import_has_errors",
            details=[i for i in (batch.report or {}).get("issues", []) if i.get("severity") == "error"],
        )
    applied = await handler.apply(session, batch)
    batch.status = ImportStatus.APPLIED
    batch.report = {
        **(batch.report or {}),
        "applied": {**applied, "applied_at": utcnow().isoformat(), "applied_by": str(user.id)},
    }
    await session.flush()
    await session.refresh(batch)
    return _batch_out(batch)


@router.get("/imports/templates/{kind}")
async def download_template(
    kind: ImportKind,
    format: Annotated[str, Query(pattern="^(xlsx|csv)$", description="xlsx (défaut) ou csv")] = "xlsx",
) -> Response:
    """Fichier modèle du kind : en-têtes, lignes d'exemple et feuille « Lisez-moi »."""
    handler = _handler(kind)
    if format == "csv":
        if kind not in SPECS:
            raise NotFoundError("Pas de modèle CSV pour cet import.")
        content, media_type = build_csv_template(SPECS[kind]), "text/csv; charset=utf-8"
    else:
        if handler.template is None:
            raise NotFoundError("Pas de fichier modèle pour cet import.")
        content, media_type = handler.template(), XLSX_MIME
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{kind.value}.{format}"'},
    )


@router.get("/imports", response_model=Page[ImportBatchSummaryOut])
async def list_imports(
    session: SessionDep,
    page: PageDep,
    kind: ImportKind | None = None,
    status: ImportStatus | None = None,
) -> Page[ImportBatchSummaryOut]:
    stmt = select(ImportBatch).order_by(ImportBatch.created_at.desc(), ImportBatch.id.desc())
    if kind is not None:
        stmt = stmt.where(ImportBatch.kind == kind)
    if status is not None:
        stmt = stmt.where(ImportBatch.status == status)
    rows, total = await paginate(session, stmt, page)
    items = [
        ImportBatchSummaryOut(
            id=b.id,
            kind=b.kind,
            filename=b.filename,
            status=b.status,
            row_count=b.row_count,
            error_count=b.error_count,
            can_apply=b.status == ImportStatus.PREVIEWED,
            created_at=b.created_at,
            created_by=b.created_by,
            summary=_summary(b.report or {}),
        )
        for b in rows
    ]
    return Page(items=items, total=total, limit=page.limit, offset=page.offset)


@router.get("/imports/{batch_id}", response_model=ImportBatchOut)
async def get_import(
    batch_id: uuid.UUID,
    session: SessionDep,
    include_data: Annotated[bool, Query(description="Renvoyer aussi les données normalisées")] = False,
) -> ImportBatchOut:
    batch = await session.get(ImportBatch, batch_id)
    if batch is None:
        raise NotFoundError("Lot d'import introuvable.")
    return _batch_out(batch, include_data=include_data)
