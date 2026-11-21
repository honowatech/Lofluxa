"""Cartes du rapport comparatif (F8.5) dessinées en SVG côté serveur — module pur.

Pas de fond de carte ni d'appel réseau : les tracés des tournées (segments droits colorés),
les dépôts (carrés noirs) et les stations (pastilles numérotées dans l'ordre de passage) sont
projetés dans un cadre commun aux deux plans, pour que les deux cartes soient à la même échelle.
"""

from __future__ import annotations

import math
from typing import Any
from xml.sax.saxutils import escape

Bounds = tuple[float, float, float, float]  # lat min, lat max, lon min, lon max


def common_bounds(*route_sets: list[dict[str, Any]]) -> Bounds | None:
    """Emprise commune à plusieurs jeux de tracés (`None` s'il n'y a aucun point)."""
    points = [p for routes in route_sets for route in routes for p in route["points"]]
    if not points:
        return None
    lats = [p["lat"] for p in points]
    lons = [p["lon"] for p in points]
    return (min(lats), max(lats), min(lons), max(lons))


def render_map_svg(
    routes: list[dict[str, Any]],
    bounds: Bounds | None = None,
    *,
    width: int = 480,
    height: int = 380,
    padding: int = 22,
) -> str:
    """Dessine les tournées (`service.plan_routes`) et renvoie le balisage `<svg>`."""
    bounds = bounds or common_bounds(routes)
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'width="{width}" height="{height}" font-family="DejaVu Sans, Arial, sans-serif">',
        f'<rect x="0.5" y="0.5" width="{width - 1}" height="{height - 1}" fill="#fbfbf8" stroke="#999"/>',
    ]
    if bounds is None:
        parts.append(
            f'<text x="{width / 2}" y="{height / 2}" text-anchor="middle" font-size="11" fill="#666">'
            "Aucune tournée</text></svg>"
        )
        return "".join(parts)

    lat_min, lat_max, lon_min, lon_max = bounds
    # Projection équirectangulaire : les longitudes sont resserrées par le cosinus de la latitude.
    k = math.cos(math.radians((lat_min + lat_max) / 2))
    span_x = max((lon_max - lon_min) * k, 1e-9)
    span_y = max(lat_max - lat_min, 1e-9)
    inner_w, inner_h = width - 2 * padding, height - 2 * padding
    scale = min(inner_w / span_x, inner_h / span_y)
    offset_x = padding + (inner_w - span_x * scale) / 2
    offset_y = padding + (inner_h - span_y * scale) / 2

    def project(point: dict[str, Any]) -> tuple[float, float]:
        x = offset_x + (point["lon"] - lon_min) * k * scale
        y = offset_y + (lat_max - point["lat"]) * scale
        return round(x, 1), round(y, 1)

    for route in routes:  # tracés d'abord, symboles par-dessus
        coords = " ".join(f"{x},{y}" for x, y in map(project, route["points"]))
        parts.append(
            f'<polyline points="{coords}" fill="none" stroke="{route["color"]}" stroke-width="1.6" '
            'stroke-linejoin="round" stroke-opacity="0.85"/>'
        )
    for route in routes:
        for point in route["points"]:
            if point["kind"] != "station":
                continue
            x, y = project(point)
            parts.append(
                f'<circle cx="{x}" cy="{y}" r="6.5" fill="{route["color"]}" stroke="#fff" stroke-width="1"/>'
                f'<text x="{x}" y="{y + 2.6}" text-anchor="middle" font-size="7.5" font-weight="700" '
                f'fill="#fff">{point["seq"]}</text>'
            )
    depots: dict[str, tuple[float, float]] = {}
    for route in routes:
        for point in route["points"]:
            if point["kind"] == "depot":
                depots[point["code"]] = project(point)
    for code, (x, y) in depots.items():
        anchor, dx = ("end", -8) if x > width - 90 else ("start", 8)
        parts.append(
            f'<rect x="{x - 5}" y="{y - 5}" width="10" height="10" fill="#111" stroke="#fff" '
            'stroke-width="1"/>'
            f'<text x="{x + dx}" y="{y - 7}" text-anchor="{anchor}" font-size="8" font-weight="700" '
            f'fill="#111">{escape(str(code))}</text>'
        )
    parts.append("</svg>")
    return "".join(parts)
