"""Service de plans : pont entre la base, le moteur et les règles — gabarit, LOT L5.

Les autres modules (événements, comparaison/rejeu) passent par ces fonctions et n'appellent
jamais le moteur directement.
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import PlanKind
from app.planning.domain import PlanningProblem, PlanningResult, TripD, ViolationD
from app.planning.models import Plan


async def build_problem(
    session: AsyncSession,
    day: date,
    *,
    params_override: dict[str, Any] | None = None,
    order_ids: list[uuid.UUID] | None = None,
) -> PlanningProblem:
    """Construit le problème du jour J depuis la base (commandes `confirmed` par défaut,
    ou `order_ids` imposés pour un rejeu), ressources, stocks dépôt et paramètres."""
    raise NotImplementedError("Lot L5")


async def persist_result(
    session: AsyncSession,
    day: date,
    result: PlanningResult,
    *,
    kind: PlanKind = PlanKind.COMPUTED,
    parent_plan_id: uuid.UUID | None = None,
    params_snapshot: dict[str, Any] | None = None,
    label: str | None = None,
) -> Plan:
    """Enregistre un résultat du moteur comme plan `draft` (trips, stops, loads, unserved, violations)."""
    raise NotImplementedError("Lot L5")


async def load_plan_trips(session: AsyncSession, plan_id: uuid.UUID) -> list[TripD]:
    """Recharge les tournées d'un plan persisté sous forme de domaine (`TripD.ref` = trips.id)."""
    raise NotImplementedError("Lot L5")


async def launch_compute(
    session: AsyncSession,
    day: date,
    *,
    user_id: uuid.UUID | None,
    params_override: dict[str, Any] | None = None,
    kind: PlanKind = PlanKind.COMPUTED,
    order_ids: list[uuid.UUID] | None = None,
    parent_plan_id: uuid.UUID | None = None,
    label: str | None = None,
) -> str:
    """Lance le calcul en tâche de fond (Celery) et renvoie le `task_id` (suivi : GET /tasks/{id})."""
    raise NotImplementedError("Lot L5")


async def new_version(session: AsyncSession, plan_id: uuid.UUID, *, reason: str) -> Plan:
    """RM-18 : copie un plan `published` en nouvelle version (brouillon), archive la précédente
    à la publication de la nouvelle. Renvoie la nouvelle version, prête à être modifiée."""
    raise NotImplementedError("Lot L5")


async def recheck_plan(session: AsyncSession, plan_id: uuid.UUID) -> list[ViolationD]:
    """Recalcule horaires (timing.schedule_trip), plan de chargement et violations d'un plan
    après modification, et les enregistre (F5.2)."""
    raise NotImplementedError("Lot L5")
