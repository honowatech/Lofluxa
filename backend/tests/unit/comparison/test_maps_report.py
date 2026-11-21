"""F8.5 — cartes SVG dessinées côté serveur et mise en forme du rapport."""

import re

from app.comparison.maps import common_bounds, legend_swatch, render_map_svg, route_dash
from app.comparison.report import format_pct, format_value


def _route(color: str, stations: list[tuple[float, float]]) -> dict:
    depot = {"kind": "depot", "lat": 4.05, "lon": 9.70, "code": "SCDP <DLA>", "name": "Dépôt", "seq": None}
    points = [
        {"kind": "station", "lat": lat, "lon": lon, "code": f"S{i}", "name": f"S{i}", "seq": i}
        for i, (lat, lon) in enumerate(stations, start=1)
    ]
    return {"color": color, "points": [depot, *points, dict(depot)]}


def test_carte_svg_traces_depot_et_stations_numerotees():
    routes = [_route("#1f77b4", [(4.06, 9.72), (4.09, 9.74)]), _route("#d62728", [(4.03, 9.76)])]
    svg = render_map_svg(routes, width=400, height=300)

    assert svg.startswith("<svg") and svg.endswith("</svg>")
    assert svg.count("<polyline") == 2 and 'stroke="#1f77b4"' in svg and 'stroke="#d62728"' in svg
    assert svg.count("<circle") == 3
    assert re.findall(r'fill="#fff">(\d+)</text>', svg) == ["1", "2", "1"]  # ordre de passage par tournée
    assert svg.count('fill="#111" stroke="#fff"') == 1  # un seul symbole pour le dépôt commun
    assert "SCDP &lt;DLA&gt;" in svg  # texte échappé
    assert "href" not in svg and "<image" not in svg  # aucun fond de carte, aucun appel réseau

    # Tous les points tombent dans le cadre.
    for x, y in re.findall(r'cx="([\d.]+)" cy="([\d.]+)"', svg):
        assert 0 <= float(x) <= 400 and 0 <= float(y) <= 300
    # Le nord est en haut : la station la plus au nord a le plus petit y.
    ys = [float(y) for _, y in re.findall(r'cx="([\d.]+)" cy="([\d.]+)"', svg)]
    assert ys[1] < ys[0] < ys[2]


def test_cadre_commun_aux_deux_cartes():
    a = [_route("#000", [(4.06, 9.72)])]
    b = [_route("#000", [(4.20, 9.90)])]
    bounds = common_bounds(a, b)
    assert bounds == (4.05, 4.20, 9.70, 9.90)
    # Même emprise : le dépôt est dessiné au même endroit sur les deux cartes.
    rect = r'<rect x="([\d.]+)" y="([\d.]+)" width="10"'
    assert (
        re.search(rect, render_map_svg(a, bounds)).groups()
        == re.search(rect, render_map_svg(b, bounds)).groups()
    )


def test_carte_sans_tournee_ou_point_unique():
    assert common_bounds([], []) is None
    assert "Aucune tournée" in render_map_svg([])
    single = [
        {
            "color": "#000",
            "points": [{"kind": "depot", "lat": 4.0, "lon": 9.7, "code": "D", "name": "", "seq": None}],
        }
    ]
    assert "<rect" in render_map_svg(single)  # emprise nulle : pas de division par zéro


def test_palette_qui_boucle_style_de_trait_distinct():
    """Au-delà de dix tournées les couleurs se répètent : le style du trait distingue les tournées."""
    from app.comparison.service import ROUTE_COLORS

    assert len(ROUTE_COLORS) == 10
    assert [route_dash(i) for i in (0, 9, 10, 19, 20, 29, 30)] == [
        None,
        None,
        "7 3",
        "7 3",
        "2 3",
        "2 3",
        None,
    ]
    routes = [_route(ROUTE_COLORS[i % 10], [(4.0 + i * 0.01, 9.8)]) for i in range(28)]
    svg = render_map_svg(routes)
    lines = re.findall(r"<polyline[^>]*>", svg)
    assert len(lines) == 28
    assert sum("stroke-dasharray" not in line for line in lines) == 10
    assert sum('stroke-dasharray="7 3"' in line for line in lines) == 10
    assert sum('stroke-dasharray="2 3"' in line for line in lines) == 8
    # Les tournées 1, 11 et 21 partagent une couleur mais pas un style de trait.
    assert {(ROUTE_COLORS[i % 10], route_dash(i)) for i in (0, 10, 20)} == {
        ("#1d6fb8", None),
        ("#1d6fb8", "7 3"),
        ("#1d6fb8", "2 3"),
    }
    assert 'stroke-dasharray="7 3"' in legend_swatch("#1d6fb8", "7 3")
    assert "stroke-dasharray" not in legend_swatch("#1d6fb8", None)


def test_mise_en_forme_francaise_des_valeurs():
    assert format_value(120_400, "m") == "120,4 km"
    assert format_value(-18_000, "m", signed=True) == "−18,0 km"
    assert format_value(18_000, "m", signed=True) == "+18,0 km"
    assert format_value(7200, "s") == "2 h 00"
    assert format_value(2700, "s") == "45 min"
    assert format_value(42, "s") == "42 s"
    assert format_value(-7158, "s", signed=True) == "−1 h 59"
    assert format_value(45000, "l") == "45 000 L"
    assert format_value(81.25, "pct") == "81,2 %"
    assert format_value(3, "count") == "3"
    assert format_value(0, "count", signed=True) == "0"
    assert format_value(None, "m") == "—"
    assert format_pct(-15.0) == "−15,0 %" and format_pct(None) == "—"
