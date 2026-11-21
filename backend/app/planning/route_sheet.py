"""Feuilles de route PDF (spec §11) — lot L5.

Une feuille par tournée : en-tête OLA, date, camion, chauffeur, dépôt, heure de départ prévue,
tableau des arrêts, plan de chargement par compartiment, zone signatures. Le gabarit étend
`core/templates/pdf_base.html` et passe par `core.pdf.render_pdf`.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import PlanStatus
from app.core.errors import NotFoundError
from app.core.pdf import render_pdf
from app.core.settings_store import load_settings
from app.planning import views
from app.planning.checking import load_plan
from app.planning.models import Plan, Trip

TEMPLATE = "planning/templates/route_sheet.html"


async def _context(session: AsyncSession, plan: Plan, trips: list[Trip]) -> dict[str, Any]:
    labels = await views.load_labels(session, plan)
    settings = await load_settings(session)
    return {
        "company_name": settings.get("company_name"),
        "logo_url": settings.get("pdf_logo_url"),
        "day": plan.day,
        "plan_version": plan.version,
        "draft": plan.status != PlanStatus.PUBLISHED,
        "archived": plan.status == PlanStatus.ARCHIVED,
        "trips": [views.trip_out(trip, labels) for trip in sorted(trips, key=lambda t: t.seq)],
    }


async def trip_route_sheet(session: AsyncSession, trip_id: uuid.UUID) -> tuple[bytes, str]:
    """Feuille de route d'une tournée → (PDF, nom de fichier)."""
    plan_id = (await session.execute(select(Trip.plan_id).where(Trip.id == trip_id))).scalar_one_or_none()
    if plan_id is None:
        raise NotFoundError("Tournée introuvable.")
    plan = await load_plan(session, plan_id)
    trip = next(t for t in plan.trips if t.id == trip_id)
    context = await _context(session, plan, [trip])
    pdf = await asyncio.to_thread(render_pdf, TEMPLATE, context)
    plate = (context["trips"][0].truck_plate or "camion").replace(" ", "")
    return pdf, f"feuille-de-route_{plan.day:%Y-%m-%d}_T{trip.seq}_{plate}.pdf"


async def plan_route_sheets(session: AsyncSession, plan_id: uuid.UUID) -> tuple[bytes, str]:
    """Toutes les feuilles de route d'un plan, une tournée par page → (PDF, nom de fichier)."""
    plan = await load_plan(session, plan_id)
    if not plan.trips:
        raise NotFoundError("Ce plan ne contient aucune tournée : pas de feuille de route à produire.")
    context = await _context(session, plan, list(plan.trips))
    pdf = await asyncio.to_thread(render_pdf, TEMPLATE, context)
    return pdf, f"feuilles-de-route_{plan.day:%Y-%m-%d}_v{plan.version}.pdf"
