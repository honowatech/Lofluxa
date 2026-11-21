"""Fiche de chargement PDF (F7.3, spec §11) : une par tournée, destinée aux gérants de station."""

from decimal import Decimal
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.pdf import render_pdf
from app.core.settings_store import load_settings
from app.loading.conversion import ASTM_NOTE
from app.loading.service import TRIP_STATUS_LABELS, TripContext, _sorted_lines

# Chemin complet depuis `app/` : le raccourci "<module>/x.html" annoncé par core/pdf.py ne résout pas.
TEMPLATE = "loading/templates/loading_sheet.html"


def _num(value: Decimal | float | None, digits: int = 2, unit: str = "") -> str:
    """Nombre au format français : 9 880,00."""
    if value is None:
        return "—"
    text = f"{float(value):,.{digits}f}".replace(",", " ").replace(".", ",")
    return f"{text} {unit}".strip()


def _signed(value: Decimal | None, digits: int = 2, unit: str = "") -> str:
    if value is None:
        return "—"
    sign = "+" if value >= 0 else "−"
    return f"{sign}{_num(abs(value), digits, unit)}"


async def build_sheet_context(session: AsyncSession, ctx: TripContext) -> dict[str, Any]:
    """Contexte du gabarit : uniquement des valeurs simples, prêtes à afficher."""
    settings = await load_settings(session)
    trip, loading = ctx.trip, ctx.loading
    assert loading is not None
    result = ctx.rm_13()

    lines = []
    for line in _sorted_lines(ctx):
        gap = result.by_compartment.get(line.compartment_id)
        product = ctx.products.get(line.product_id)
        lines.append(
            {
                "compartment": ctx.compartment_label(line.compartment_id),
                "product": product.label if product else "—",
                "observed": _num(line.observed_l, unit="L"),
                "temperature": _num(line.observed_temp_c, 1, "°C"),
                "density": _num(line.observed_density, 4) if line.observed_density is not None else "—",
                "volume_15": _num(line.volume_15_l, unit="L"),
                "planned": _num(line.planned_l, unit="L"),
                "gap_l": _signed(gap.gap_l, unit="L") if gap else "—",
                "gap_pct": _signed(gap.gap_pct, unit="%") if gap and gap.gap_pct is not None else "—",
                "out_of_tolerance": bool(gap and gap.out_of_tolerance),
            }
        )

    # Produits de la tournée : totaux observés / à 15 °C / planifiés par produit.
    by_product: dict[Any, dict[str, Decimal]] = {}
    for load in trip.compartment_loads:
        by_product.setdefault(
            load.product_id, {"observed": Decimal(0), "v15": Decimal(0), "planned": Decimal(0)}
        )
        by_product[load.product_id]["planned"] += load.planned_l
    for line in loading.lines:
        row = by_product.setdefault(
            line.product_id, {"observed": Decimal(0), "v15": Decimal(0), "planned": Decimal(0)}
        )
        row["observed"] += line.observed_l
        row["v15"] += line.volume_15_l
    products = [
        {
            "label": ctx.products[pid].label if pid in ctx.products else "—",
            "observed": _num(row["observed"], unit="L"),
            "volume_15": _num(row["v15"], unit="L"),
            "planned": _num(row["planned"], unit="L"),
        }
        for pid, row in by_product.items()
    ]

    stops = []
    for stop in trip.stops:
        station = ctx.stations.get(stop.station_id)
        stops.append(
            {
                "seq": stop.seq,
                "station": f"{station.code} — {station.name}" if station else "—",
                "city": (station.city if station else None) or "",
                "contact": " / ".join(
                    part
                    for part in ((station.contact_name, station.contact_phone) if station else ())
                    if part
                ),
                "planned_arrival_at": stop.planned_arrival_at,
                "deliveries": [
                    {
                        "product": ctx.products[d.product_id].label if d.product_id in ctx.products else "—",
                        "planned": _num(d.planned_l, 0, "L"),
                    }
                    for d in stop.deliveries
                ],
            }
        )

    planned_by_compartment = ctx.planned_by_compartment
    planned_products = ctx.planned_product_by_compartment
    compartments = [
        {
            "position": compartment.position,
            "capacity": _num(compartment.capacity_l, 0, "L"),
            "product": (
                ctx.products[planned_products[compartment.id]].label
                if planned_products.get(compartment.id) in ctx.products
                else "vide"
            ),
            "planned": _num(planned_by_compartment.get(compartment.id), 0, "L")
            if compartment.id in planned_by_compartment
            else "—",
        }
        for compartment in sorted(ctx.compartments.values(), key=lambda c: c.position)
    ]

    return {
        "company_name": settings.get("company_name"),
        "logo_url": settings.get("pdf_logo_url"),
        "day": ctx.plan.day,
        "trip_seq": trip.seq,
        "trip_status": TRIP_STATUS_LABELS[trip.status],
        "truck_plate": ctx.truck.plate if ctx.truck else "—",
        "driver_name": ctx.driver.full_name if ctx.driver else "—",
        "driver_phone": (ctx.driver.phone if ctx.driver else None) or "",
        "depot": f"{ctx.depot.code} — {ctx.depot.name}" if ctx.depot else "—",
        "depot_ticket_no": loading.depot_ticket_no or "—",
        "arrived_at": loading.arrived_at,
        "started_at": loading.started_at,
        "finished_at": loading.finished_at,
        # Heure de départ : réelle si elle est saisie, sinon prévue.
        "depart_at": trip.actual_depart_at or trip.planned_depart_at,
        "depart_is_actual": trip.actual_depart_at is not None,
        "lines": lines,
        "products": products,
        "total": {
            "observed": _num(sum((line.observed_l for line in loading.lines), Decimal(0)), unit="L"),
            "volume_15": _num(result.total.loaded_15_l, unit="L"),
            "planned": _num(result.total.planned_l, unit="L"),
            "gap_l": _signed(result.total.gap_l, unit="L"),
            "gap_pct": _signed(result.total.gap_pct, unit="%") if result.total.gap_pct is not None else "—",
            "out_of_tolerance": result.total.out_of_tolerance,
        },
        "tolerance": _num(result.tolerance_pct, 2, "%"),
        "rm_13_message": result.message,
        "rm_13_explanation": result.explanation,
        "stops": stops,
        "compartments": compartments,
        "astm_note": ASTM_NOTE,
    }


def render_loading_sheet(context: dict[str, Any]) -> bytes:
    """Rendu synchrone (WeasyPrint) : à appeler hors de la boucle d'événements."""
    return render_pdf(TEMPLATE, context)


def sheet_filename(ctx: TripContext) -> str:
    plate = "".join(ch for ch in (ctx.truck.plate if ctx.truck else "camion") if ch.isalnum() or ch in "-_")
    return f"fiche-chargement-{ctx.plan.day.isoformat()}-{plate}-T{ctx.trip.seq}.pdf"
