"""Routes des plans de tournées (spec §9, F4, F5, §11) — lot L5.

Écriture : `dispatcher` (et `admin`). Lecture : tout rôle authentifié.
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import func, select

from app.core.deps import CurrentUser, Page, PageDep, SessionDep, require_roles
from app.core.enums import OrderStatus, PlanKind, PlanStatus, Role
from app.core.errors import ConflictError
from app.orders.models import Order
from app.planning import editing, route_sheet, service, tasks, versions, views
from app.planning.checking import PLAN_LOAD, load_plan
from app.planning.models import Plan
from app.planning.schemas import (
    AssignIn,
    ComputeIn,
    MoveStopIn,
    PlanOut,
    PlanSummaryOut,
    RecomputeIn,
    ReorderIn,
    TaskAccepted,
    TaskOut,
    VersionOut,
)
from app.users.models import User

router = APIRouter(tags=["plans"])

Dispatcher = Annotated[User, Depends(require_roles(Role.DISPATCHER))]


def _pdf(content: bytes, filename: str) -> Response:
    return Response(
        content=content,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


# --------------------------------------------------------------------------- calcul (F4.1, F4.5)


@router.post("/plans/compute", response_model=TaskAccepted, status_code=202)
async def compute_plan(payload: ComputeIn, session: SessionDep, user: Dispatcher) -> TaskAccepted:
    """Lance le calcul du plan du jour en tâche de fond. Suivi : `GET /tasks/{task_id}`."""
    service.validate_params_override(payload.params)
    confirmed = await session.scalar(
        select(func.count())
        .select_from(Order)
        .where(Order.day == payload.day, Order.status == OrderStatus.CONFIRMED)
    )
    if not confirmed:
        raise ConflictError(
            f"Aucune commande confirmée à planifier pour le {payload.day:%d/%m/%Y}.", code="no_orders_to_plan"
        )
    task_id = await service.launch_compute(
        session, payload.day, user_id=user.id, params_override=payload.params
    )
    return TaskAccepted(task_id=task_id)


@router.get("/tasks/{task_id}", response_model=TaskOut)
async def get_task(task_id: str, _: CurrentUser) -> TaskOut:
    """État d'un calcul : progression de 0 à 100, `plan_id` à la fin, message lisible en cas d'échec."""
    return TaskOut(**tasks.task_status(task_id))


# --------------------------------------------------------------------------- lecture


@router.get("/plans", response_model=Page[PlanSummaryOut])
async def list_plans(
    session: SessionDep,
    _: CurrentUser,
    page: PageDep,
    day: Annotated[date | None, Query()] = None,
    kind: Annotated[PlanKind | None, Query()] = None,
    status: Annotated[PlanStatus | None, Query()] = None,
) -> Page[PlanSummaryOut]:
    """Plans (toutes versions), du plus récent au plus ancien. Filtres : `day`, `kind`, `status`."""
    conditions = []
    if day is not None:
        conditions.append(Plan.day == day)
    if kind is not None:
        conditions.append(Plan.kind == kind)
    if status is not None:
        conditions.append(Plan.status == status)
    total = await session.scalar(select(func.count()).select_from(Plan).where(*conditions))
    rows = await session.execute(
        select(Plan)
        .where(*conditions)
        .options(*PLAN_LOAD)
        .order_by(Plan.day.desc(), Plan.created_at.desc(), Plan.version.desc(), Plan.id.desc())
        .limit(page.limit)
        .offset(page.offset)
        .execution_options(populate_existing=True)
    )
    plans = list(rows.scalars())
    creators = await views._by_id(session, User, {p.created_by for p in plans})
    return Page[PlanSummaryOut](
        items=[views.plan_summary(p, creators.get(p.created_by)) for p in plans],
        total=total or 0,
        limit=page.limit,
        offset=page.offset,
    )


@router.get("/plans/{plan_id}", response_model=PlanOut)
async def get_plan(plan_id: uuid.UUID, session: SessionDep, _: CurrentUser) -> PlanOut:
    """Plan complet : tournées, arrêts, livraisons, chargement, non servies, violations, métriques."""
    return await views.plan_out(session, await load_plan(session, plan_id))


# --------------------------------------------------------------------------- édition manuelle (F5.1, F5.2)
# Toutes ces routes renvoient le plan à jour. Si le plan visé est publié, la modification est
# appliquée à une NOUVELLE version (RM-18) : la réponse porte alors un autre `id` que celui demandé.


@router.post("/plans/{plan_id}/trips/{trip_id}/move-stop", response_model=PlanOut)
async def move_stop(
    plan_id: uuid.UUID, trip_id: uuid.UUID, payload: MoveStopIn, session: SessionDep, _: Dispatcher
) -> PlanOut:
    plan = await editing.move_stop(
        session, plan_id, trip_id, payload.stop_id, payload.to_trip_id, payload.to_seq
    )
    return await views.plan_out(session, plan)


@router.post("/plans/{plan_id}/trips/{trip_id}/reorder", response_model=PlanOut)
async def reorder(
    plan_id: uuid.UUID, trip_id: uuid.UUID, payload: ReorderIn, session: SessionDep, _: Dispatcher
) -> PlanOut:
    plan = await editing.reorder_stops(session, plan_id, trip_id, payload.stop_ids)
    return await views.plan_out(session, plan)


@router.post("/plans/{plan_id}/trips/{trip_id}/assign", response_model=PlanOut)
async def assign(
    plan_id: uuid.UUID, trip_id: uuid.UUID, payload: AssignIn, session: SessionDep, _: Dispatcher
) -> PlanOut:
    changes = {name: getattr(payload, name) for name in payload.model_fields_set}
    plan = await editing.assign_resources(session, plan_id, trip_id, changes)
    return await views.plan_out(session, plan)


@router.post("/plans/{plan_id}/trips/{trip_id}/lock", response_model=PlanOut)
async def lock(plan_id: uuid.UUID, trip_id: uuid.UUID, session: SessionDep, _: Dispatcher) -> PlanOut:
    return await views.plan_out(session, await editing.set_locked(session, plan_id, trip_id, True))


@router.post("/plans/{plan_id}/trips/{trip_id}/unlock", response_model=PlanOut)
async def unlock(plan_id: uuid.UUID, trip_id: uuid.UUID, session: SessionDep, _: Dispatcher) -> PlanOut:
    return await views.plan_out(session, await editing.set_locked(session, plan_id, trip_id, False))


# --------------------------------------------------------------------------- recalcul, publication


@router.post("/plans/{plan_id}/recompute", response_model=TaskAccepted, status_code=202)
async def recompute(
    plan_id: uuid.UUID, session: SessionDep, user: Dispatcher, payload: RecomputeIn | None = None
) -> TaskAccepted:
    """« Recalculer en conservant » (F5.3) : tâche de fond qui fige les tournées verrouillées (RM-17).
    Le `plan_id` renvoyé par `GET /tasks/{task_id}` est celui du plan recalculé (une nouvelle
    version si le plan visé était publié)."""
    params = payload.params if payload else None
    service.validate_params_override(params)
    plan = await load_plan(session, plan_id)
    editing.ensure_not_reference(plan)
    if plan.status == PlanStatus.ARCHIVED:
        raise ConflictError("Ce plan est archivé : il ne peut plus être recalculé.", code="plan_archived")
    task_id = await service.launch_recompute(session, plan_id, user_id=user.id, params_override=params)
    return TaskAccepted(task_id=task_id)


@router.post("/plans/{plan_id}/publish", response_model=PlanOut)
async def publish(plan_id: uuid.UUID, session: SessionDep, _: Dispatcher) -> PlanOut:
    """Publie le plan (F5.4). 409 `rule_violation` avec les `rule_code` s'il reste une violation bloquante."""
    return await views.plan_out(session, await service.publish_plan(session, plan_id))


# --------------------------------------------------------------------------- versions (F5.5)


@router.get("/plans/{plan_id}/versions", response_model=Page[VersionOut])
async def list_versions(
    plan_id: uuid.UUID, session: SessionDep, _: CurrentUser, page: PageDep
) -> Page[VersionOut]:
    """Historique des versions du plan : qui a changé quoi, quand."""
    items = await views.versions_out(session, await load_plan(session, plan_id))
    return Page[VersionOut](
        items=items[page.offset : page.offset + page.limit],
        total=len(items),
        limit=page.limit,
        offset=page.offset,
    )


@router.post("/plans/{plan_id}/versions/{version}/restore", response_model=PlanOut)
async def restore(plan_id: uuid.UUID, version: int, session: SessionDep, _: Dispatcher) -> PlanOut:
    """Restaure une version : crée une nouvelle version brouillon, copie de la version demandée."""
    return await views.plan_out(session, await versions.restore_version(session, plan_id, version))


# --------------------------------------------------------------------------- feuilles de route (§11)


@router.get("/plans/{plan_id}/route-sheets.pdf", response_class=Response)
async def plan_route_sheets(plan_id: uuid.UUID, session: SessionDep, _: CurrentUser) -> Response:
    """Toutes les feuilles de route du plan, une tournée par page."""
    return _pdf(*await route_sheet.plan_route_sheets(session, plan_id))


@router.get("/trips/{trip_id}/route-sheet.pdf", response_class=Response)
async def trip_route_sheet(trip_id: uuid.UUID, session: SessionDep, _: CurrentUser) -> Response:
    """Feuille de route d'une tournée."""
    return _pdf(*await route_sheet.trip_route_sheet(session, trip_id))
