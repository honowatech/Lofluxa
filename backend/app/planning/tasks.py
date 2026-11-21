"""Tâches de fond du service de plans (F4.5) : calcul et recalcul d'un plan — lot L5.

La logique est dans `service.run_compute` / `service.run_recompute` (testables avec une session).
Ici : ouverture d'une session propre à la tâche, progression, et résultat toujours lisible :
`{"plan_id": …}` en cas de succès, `{"error": message en français}` en cas d'échec.
"""

from __future__ import annotations

import asyncio
import threading
import uuid
from collections.abc import Awaitable, Callable
from datetime import date
from typing import Any

import structlog
from celery.result import AsyncResult
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from app.core.config import get_config
from app.core.context import current_user_id
from app.core.enums import PlanKind
from app.core.errors import AppError
from app.worker import celery_app

log = structlog.get_logger()

PROGRESS = "PROGRESS"


def _run(factory: Callable[[], Awaitable[Any]]) -> Any:
    """Exécute une coroutine depuis une tâche synchrone. Si une boucle tourne déjà dans ce fil
    (mode `task_always_eager` appelé depuis l'API), la coroutine s'exécute dans un fil dédié."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(factory())
    box: dict[str, Any] = {}

    def _target() -> None:
        try:
            box["value"] = asyncio.run(factory())
        except BaseException as exc:  # noqa: BLE001 — relancée dans le fil appelant
            box["error"] = exc

    thread = threading.Thread(target=_target, daemon=True)
    thread.start()
    thread.join()
    if "error" in box:
        raise box["error"]
    return box["value"]


async def _in_session(user_id: str | None, work: Callable[[AsyncSession], Awaitable[uuid.UUID]]) -> uuid.UUID:
    """Ouvre une connexion propre à la tâche (pas de pool partagé entre boucles d'événements)."""
    engine = create_async_engine(get_config().database_url, poolclass=NullPool)
    token = current_user_id.set(uuid.UUID(user_id) if user_id else None)
    try:
        async with AsyncSession(engine, expire_on_commit=False) as session:
            try:
                plan_id = await work(session)
                await session.commit()
                return plan_id
            except Exception:
                await session.rollback()
                raise
    finally:
        current_user_id.reset(token)
        await engine.dispose()


def _execute(task: Any, user_id: str | None, work: Callable[..., Awaitable[uuid.UUID]]) -> dict[str, Any]:
    # Relevé ici : `task.request` est propre au fil d'exécution, la progression peut venir d'un autre fil.
    task_id = task.request.id

    def progress(percent: int, message: str) -> None:
        meta = {"progress": max(0, min(100, int(percent))), "message": message}
        task.update_state(task_id=task_id, state=PROGRESS, meta=meta)

    try:
        plan_id = _run(lambda: _in_session(user_id, lambda session: work(session, progress)))
    except AppError as exc:
        return {"error": exc.message, "code": exc.code}
    except NotImplementedError:
        return {
            "error": "Le moteur de calcul n'est pas installé dans cette version.",
            "code": "engine_missing",
        }
    except Exception as exc:  # noqa: BLE001 — l'utilisateur doit toujours recevoir un message lisible
        log.error("plan_task_failed", task_id=task_id, error=repr(exc))
        return {
            "error": "Le calcul a échoué à cause d'une erreur interne. Réessayez ; si le problème "
            f"persiste, transmettez cette référence à l'administrateur : {task_id}.",
            "code": "internal_error",
        }
    return {"plan_id": str(plan_id)}


@celery_app.task(bind=True, name="planning.compute_plan")
def compute_plan_task(
    self: Any,
    *,
    day: str,
    user_id: str | None = None,
    params_override: dict[str, Any] | None = None,
    kind: str = PlanKind.COMPUTED.value,
    order_ids: list[str] | None = None,
    parent_plan_id: str | None = None,
    label: str | None = None,
) -> dict[str, Any]:
    from app.planning import service

    async def work(session: AsyncSession, progress: Callable[[int, str], None]) -> uuid.UUID:
        plan = await service.run_compute(
            session,
            date.fromisoformat(day),
            params_override=params_override,
            kind=PlanKind(kind),
            order_ids=[uuid.UUID(o) for o in order_ids] if order_ids is not None else None,
            parent_plan_id=uuid.UUID(parent_plan_id) if parent_plan_id else None,
            label=label,
            progress=progress,
        )
        return plan.id

    return _execute(self, user_id, work)


@celery_app.task(bind=True, name="planning.recompute_plan")
def recompute_plan_task(
    self: Any, *, plan_id: str, user_id: str | None = None, params_override: dict[str, Any] | None = None
) -> dict[str, Any]:
    from app.planning import service

    async def work(session: AsyncSession, progress: Callable[[int, str], None]) -> uuid.UUID:
        plan = await service.run_recompute(
            session, uuid.UUID(plan_id), params_override=params_override, progress=progress
        )
        return plan.id

    return _execute(self, user_id, work)


def dispatch_compute(**kwargs: Any) -> str:
    return compute_plan_task.apply_async(kwargs=kwargs).id


def dispatch_recompute(**kwargs: Any) -> str:
    return recompute_plan_task.apply_async(kwargs=kwargs).id


def task_status(task_id: str) -> dict[str, Any]:
    """État d'une tâche pour `GET /tasks/{task_id}` : `pending`, `running`, `succeeded` ou `failed`.

    Celery ne distingue pas une tâche inconnue d'une tâche en attente : les deux sont `pending`."""
    result = AsyncResult(task_id, app=celery_app)
    state = result.state
    info = result.info if isinstance(result.info, dict) else {}
    status: dict[str, Any] = {
        "task_id": task_id,
        "state": "pending",
        "progress": 0,
        "message": "En attente de démarrage",
        "plan_id": None,
        "error": None,
    }
    if state == "STARTED":
        status.update(state="running", message="Calcul démarré")
    elif state == PROGRESS:
        status.update(
            state="running",
            progress=int(info.get("progress", 0)),
            message=info.get("message") or "Calcul en cours",
        )
    elif state == "SUCCESS":
        if info.get("plan_id"):
            status.update(state="succeeded", progress=100, message="Plan calculé", plan_id=info["plan_id"])
        else:
            status.update(
                state="failed", message="Échec du calcul", error=info.get("error") or "Échec du calcul."
            )
    elif state in ("FAILURE", "REVOKED"):
        status.update(
            state="failed",
            message="Échec du calcul",
            error="Le calcul a été interrompu avant la fin. Relancez-le.",
        )
    return status
