"""Rapport comparatif A/B en PDF (F8.5, spec §11) : synthèse, deux cartes côte à côte, annexes."""

from __future__ import annotations

from typing import Any

from markupsafe import Markup

from app.comparison import maps
from app.comparison.metrics import MetricDelta
from app.core.pdf import render_pdf

TEMPLATE = "comparison/templates/comparison_report.html"


def _number(value: float, decimals: int = 0) -> str:
    text = f"{value:,.{decimals}f}".replace(",", " ").replace(".", ",")
    return text


def format_value(value: float | None, unit: str, *, signed: bool = False) -> str:
    """Mise en forme française d'une valeur selon son unité (`m`, `s`, `l`, `pct`, `count`)."""
    if value is None:
        return "—"
    sign = "+" if signed and value > 0 else ("−" if value < 0 else "")
    magnitude = abs(value)
    if unit == "m":
        body = f"{_number(magnitude / 1000, 1)} km"
    elif unit == "s":
        minutes = round(magnitude / 60)
        if magnitude < 60:
            body = f"{round(magnitude)} s"
        elif minutes < 60:
            body = f"{minutes} min"
        else:
            body = f"{minutes // 60} h {minutes % 60:02d}"
    elif unit == "l":
        body = f"{_number(magnitude)} L"
    elif unit == "pct":
        body = f"{_number(magnitude, 1)} %"
    else:
        body = _number(magnitude)
    return f"{sign}{body}"


def format_pct(value: float | None) -> str:
    return format_value(value, "pct", signed=True)


def _rows(deltas: list[MetricDelta]) -> list[dict[str, Any]]:
    return [
        {
            "label": d.label,
            "a": format_value(d.a, d.unit),
            "b": format_value(d.b, d.unit),
            "delta": format_value(d.delta, d.unit, signed=True),
            "delta_pct": format_pct(d.delta_pct),
            "better": d.better,
        }
        for d in deltas
    ]


def build_context(comparison: dict[str, Any], settings: dict[str, Any]) -> dict[str, Any]:
    bounds = maps.common_bounds(comparison["routes_a"], comparison["routes_b"])
    verdict = comparison["verdict"]
    return {
        **comparison,
        "company_name": settings.get("company_name"),
        "logo_url": settings.get("pdf_logo_url"),
        "rows": _rows(comparison["deltas"]),
        "gain_pct": format_value(verdict.gain_pct, "pct", signed=True),
        "gain_km": format_value(verdict.gain_m, "m", signed=True),
        "gain_vs_actual_pct": format_value(verdict.gain_vs_actual_pct, "pct", signed=True),
        "threshold_pct": format_value(verdict.threshold_pct, "pct"),
        "map_a": Markup(maps.render_map_svg(comparison["routes_a"], bounds)),
        "map_b": Markup(maps.render_map_svg(comparison["routes_b"], bounds)),
        "plans": [
            {
                "letter": "A",
                "summary": comparison["plan_a"],
                "routes": comparison["routes_a"],
                "unserved": comparison["unserved_a"],
            },
            {
                "letter": "B",
                "summary": comparison["plan_b"],
                "routes": comparison["routes_b"],
                "unserved": comparison["unserved_b"],
            },
        ],
    }


def render_comparison_pdf(comparison: dict[str, Any], settings: dict[str, Any]) -> bytes:
    return render_pdf(TEMPLATE, build_context(comparison, settings))
