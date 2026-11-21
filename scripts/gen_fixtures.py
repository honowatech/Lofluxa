#!/usr/bin/env python3
"""Génère les jeux de données fictifs du moteur (spec §7.5), avec une graine fixe.

    cd backend && uv run python ../scripts/gen_fixtures.py            # régénère les trois jeux
    cd backend && uv run python ../scripts/gen_fixtures.py --check     # vérifie qu'ils sont à jour

Sorties : `data/fixtures/{demo_douala,demo_shortage,demo_scale}/problem.json` (sérialisation de
`PlanningProblem`, voir `app/planning/fixtures.py`). Données entièrement fictives : seuls les noms
de villes et de quartiers sont réels, les coordonnées sont approximatives.

Les jeux sont faisables par construction : volumes ≤ capacité des camions admis par la station,
stations joignables dans la durée maximale de service, fenêtres de commande atteignables, stocks
dépôt suffisants (sauf, volontairement, le gasoil de `demo_shortage`).
"""

from __future__ import annotations

import argparse
import random
import sys
from dataclasses import replace
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.core.enums import OrderPriority, TruckSize  # noqa: E402
from app.core.geo import haversine_m  # noqa: E402
from app.planning.domain import (  # noqa: E402
    CompartmentD,
    DepotD,
    DriverD,
    OrderD,
    Params,
    PlanningProblem,
    ProductD,
    StationD,
    TruckD,
)
from app.planning.fixtures import dump_problem, problem_to_dict  # noqa: E402

SEED = 20270112
DAY = date(2027, 1, 12)  # un mardi
H = 3600

PRODUCTS = [
    ProductD("SUPER", "SUPER", "Super sans plomb"),
    ProductD("GASOIL", "GASOIL", "Gasoil"),
    ProductD("PETROLE", "PETROLE", "Pétrole lampant"),
]

# Gabarit → capacités des compartiments (litres).
COMPARTMENT_LAYOUTS = {
    TruckSize.SMALL: [(5000, 4000, 4000), (6000, 4000, 3000)],
    TruckSize.MEDIUM: [(6000, 6000, 5000, 4000, 4000), (7000, 6000, 5000, 4000, 3000)],
    TruckSize.LARGE: [(6000, 6000, 6000, 5000, 5000, 4000, 4000), (8000, 7000, 6000, 6000, 5000, 4000)],
}

FIRST_NAMES = [
    "Jean",
    "Paul",
    "Samuel",
    "Emmanuel",
    "Joseph",
    "Pierre",
    "André",
    "Martin",
    "Alain",
    "Roger",
    "Serge",
    "Hervé",
    "Patrice",
    "Claude",
    "Désiré",
    "Fabrice",
    "Georges",
    "Blaise",
    "Achille",
    "Yves",
]
LAST_NAMES = [
    "Mbarga",
    "Nkoulou",
    "Fotso",
    "Tchoupo",
    "Essomba",
    "Ngono",
    "Kamga",
    "Etoundi",
    "Njoya",
    "Abega",
    "Manga",
    "Biyong",
    "Tagne",
    "Owona",
    "Ndjock",
    "Eyenga",
    "Simo",
    "Atangana",
    "Moukoko",
    "Bella",
]


def _truck(
    truck_id: str,
    plate: str,
    size: TruckSize,
    layout: tuple[int, ...],
    carrier: str,
    restricted: dict[int, frozenset[str]] | None = None,
) -> TruckD:
    compartments = tuple(
        CompartmentD(f"{truck_id}-C{pos}", pos, float(cap), (restricted or {}).get(pos))
        for pos, cap in enumerate(layout, start=1)
    )
    return TruckD(truck_id, plate, size, compartments, carrier_id=carrier)


def _driver(rng: random.Random, used_names: set[str], index: int, carrier: str, **kwargs) -> DriverD:
    # Noms uniques dans un jeu : une journée de référence peut désigner un chauffeur par son nom.
    while True:
        name = f"{rng.choice(FIRST_NAMES)} {rng.choice(LAST_NAMES)}"
        if name not in used_names:
            break
    used_names.add(name)
    return DriverD(
        f"CH{index:02d}",
        name,
        carrier_id=carrier,
        license_expiry=date(2028, 6, 30),
        hazmat_expiry=date(2027, 12, 31),
        **kwargs,
    )


# --------------------------------------------------------------------------- demo_douala


DOUALA_DEPOT = DepotD(
    "DEP-DLA",
    "SCDP-DLA",
    4.0483,
    9.6905,
    windows=((6 * H, 18 * H),),
    avg_wait_min=90,
    max_loadings_per_truck_day=2,
    name="SCDP Douala (Bessengué)",
)

# (code, nom, lat, lon, ouverture, fermeture, gabarit max)
DOUALA_STATIONS = [
    ("DLA01", "OLA Akwa", 4.0502, 9.6975, 6, 18, TruckSize.LARGE),
    ("DLA02", "OLA Bonanjo", 4.0385, 9.6890, 6, 18, TruckSize.LARGE),
    ("DLA03", "OLA Bonapriso", 4.0255, 9.6990, 6, 18, TruckSize.LARGE),
    ("DLA04", "OLA Deido", 4.0665, 9.7080, 6, 18, TruckSize.LARGE),
    ("DLA05", "OLA Bonabéri", 4.0760, 9.6600, 6, 18, TruckSize.LARGE),
    ("DLA06", "OLA Bépanda", 4.0640, 9.7290, 6, 18, TruckSize.LARGE),
    ("DLA07", "OLA Ndokoti", 4.0455, 9.7415, 6, 19, TruckSize.LARGE),
    ("DLA08", "OLA Bonamoussadi", 4.0900, 9.7400, 6, 18, TruckSize.LARGE),
    ("DLA09", "OLA Makepe", 4.0820, 9.7560, 7, 18, TruckSize.LARGE),
    ("DLA10", "OLA Logbessou", 4.0950, 9.7850, 6, 18, TruckSize.LARGE),
    ("DLA11", "OLA Yassa", 3.9990, 9.8000, 6, 19, TruckSize.LARGE),
    (
        "DLA12",
        "OLA New Bell",
        4.0300,
        9.7150,
        7,
        17,
        TruckSize.SMALL,
    ),  # accès étroit : petit gabarit seulement
]

# (station, produit, volume, priorité, fenêtre en heures ou None)
DOUALA_ORDERS = [
    ("DLA01", "SUPER", 6000, "normal", None),
    ("DLA01", "GASOIL", 5000, "normal", None),
    ("DLA02", "SUPER", 5000, "normal", None),
    ("DLA02", "GASOIL", 4000, "urgent", None),
    ("DLA03", "SUPER", 7000, "normal", None),
    ("DLA04", "GASOIL", 6000, "normal", None),
    ("DLA04", "PETROLE", 3000, "normal", None),
    ("DLA05", "SUPER", 5000, "normal", None),
    ("DLA05", "GASOIL", 6000, "normal", None),
    ("DLA06", "SUPER", 4000, "normal", None),
    ("DLA06", "PETROLE", 3000, "normal", None),
    ("DLA07", "GASOIL", 7000, "normal", (10, 11)),  # fenêtre étroite
    ("DLA07", "SUPER", 5000, "normal", None),
    ("DLA08", "SUPER", 6000, "urgent", None),
    ("DLA08", "GASOIL", 4000, "normal", None),
    ("DLA09", "SUPER", 5000, "normal", None),
    ("DLA10", "GASOIL", 6000, "normal", None),
    ("DLA11", "SUPER", 4000, "normal", None),
    ("DLA11", "GASOIL", 5000, "normal", None),
    ("DLA12", "SUPER", 4000, "normal", None),
]


def build_demo_douala() -> PlanningProblem:
    rng = random.Random(SEED)
    stations = [
        StationD(
            code,
            code,
            lat,
            lon,
            windows=((opening * H, closing * H),),
            max_truck_size=size,
            unload_time_min=40,
            name=name,
        )
        for code, name, lat, lon, opening, closing, size in DOUALA_STATIONS
    ]
    all_products = None
    trucks = [
        _truck("CAM01", "LT-401-AA", TruckSize.MEDIUM, COMPARTMENT_LAYOUTS[TruckSize.MEDIUM][0], "TR-OLA"),
        _truck(
            "CAM02",
            "LT-402-AB",
            TruckSize.MEDIUM,
            COMPARTMENT_LAYOUTS[TruckSize.MEDIUM][1],
            "TR-OLA",
            restricted={5: frozenset({"PETROLE"})},
        ),  # dernier compartiment réservé au pétrole lampant
        _truck("CAM03", "LT-403-AC", TruckSize.SMALL, COMPARTMENT_LAYOUTS[TruckSize.SMALL][0], "TR-OLA"),
        _truck(
            "CAM04",
            "CE-404-AD",
            TruckSize.SMALL,
            COMPARTMENT_LAYOUTS[TruckSize.SMALL][1],
            "TR-SOTRACAM",
            restricted={1: frozenset({"SUPER", "GASOIL"})},
        ),
    ]
    del all_products
    names: set[str] = set()
    drivers = [
        _driver(rng, names, 1, "TR-OLA", default_truck_id="CAM01"),
        _driver(rng, names, 2, "TR-OLA", default_truck_id="CAM02"),
        _driver(rng, names, 3, "TR-OLA", default_truck_id="CAM03"),
        _driver(rng, names, 4, "TR-SOTRACAM", default_truck_id="CAM04"),
        _driver(rng, names, 5, "TR-OLA"),  # chauffeur de réserve
    ]
    orders = [
        OrderD(
            f"CMD{i:03d}",
            station,
            product,
            float(volume),
            OrderPriority(priority),
            None if window is None else (window[0] * H, window[1] * H),
        )
        for i, (station, product, volume, priority, window) in enumerate(DOUALA_ORDERS, start=1)
    ]
    demand: dict[str, float] = {}
    for order in orders:
        demand[order.product_id] = demand.get(order.product_id, 0.0) + order.requested_l
    stocks = {(DOUALA_DEPOT.id, product): round(volume * 1.5, -3) for product, volume in demand.items()}
    return PlanningProblem(
        day=DAY,
        products=PRODUCTS,
        depots=[DOUALA_DEPOT],
        stations=stations,
        trucks=trucks,
        drivers=drivers,
        orders=orders,
        depot_stocks=stocks,
        driver_by_truck={"CAM01": "CH01"},
        # Petit jeu : limite de temps réduite ; l'arrêt se fait normalement sur le critère sans horloge.
        params=Params(solver_time_limit_s=6),
    )


def build_demo_shortage() -> PlanningProblem:
    """`demo_douala` avec un stock de gasoil insuffisant au dépôt : 30 000 L pour 43 000 L demandés."""
    problem = build_demo_douala()
    stocks = dict(problem.depot_stocks)
    stocks[(DOUALA_DEPOT.id, "GASOIL")] = 30000.0
    problem.depot_stocks = stocks
    return problem


# --------------------------------------------------------------------------- demo_scale

YAOUNDE_DEPOT = DepotD(
    "DEP-YDE",
    "SCDP-YDE",
    3.8480,
    11.5021,
    windows=((6 * H, 18 * H),),
    avg_wait_min=75,
    max_loadings_per_truck_day=2,
    name="SCDP Yaoundé (Nsam)",
)

# (ville, code à 3 lettres — unique —, lat, lon, nombre de stations, dispersion en degrés, zone)
SCALE_CITIES = [
    ("Douala", "DLA", 4.0483, 9.7043, 20, 0.055, "DLA"),
    ("Limbé", "LIM", 4.0186, 9.2043, 2, 0.012, "DLA"),
    ("Buea", "BUE", 4.1560, 9.2320, 2, 0.012, "DLA"),
    ("Tiko", "TIK", 4.0750, 9.3600, 1, 0.008, "DLA"),
    ("Kumba", "KUM", 4.6363, 9.4469, 2, 0.012, "DLA"),
    ("Mbanga", "MBG", 4.5010, 9.5680, 1, 0.008, "DLA"),
    ("Loum", "LOU", 4.7180, 9.7350, 1, 0.008, "DLA"),
    ("Nkongsamba", "NKO", 4.9547, 9.9404, 2, 0.012, "DLA"),
    ("Edéa", "EDE", 3.8000, 10.1330, 2, 0.012, "DLA"),
    ("Kribi", "KRI", 2.9400, 9.9100, 2, 0.012, "DLA"),
    ("Dizangué", "DIZ", 3.7650, 9.9800, 1, 0.008, "DLA"),
    ("Yaoundé", "YDE", 3.8667, 11.5167, 17, 0.050, "YDE"),
    ("Mbalmayo", "MBL", 3.5170, 11.5000, 2, 0.012, "YDE"),
    ("Obala", "OBA", 4.1667, 11.5333, 2, 0.010, "YDE"),
    ("Soa", "SOA", 3.9800, 11.5950, 1, 0.008, "YDE"),
    ("Mfou", "MFO", 3.7200, 11.6400, 1, 0.008, "YDE"),
    ("Bafia", "BAF", 4.7500, 11.2300, 2, 0.012, "YDE"),
    ("Akonolinga", "AKO", 3.7700, 12.2500, 1, 0.008, "YDE"),
    ("Eséka", "ESE", 3.6500, 10.7700, 1, 0.008, "YDE"),
    ("Ebolowa", "EBO", 2.9000, 11.1500, 2, 0.012, "YDE"),
    ("Sangmélima", "SAN", 2.9300, 11.9800, 2, 0.012, "YDE"),
    ("Monatélé", "MON", 4.2700, 11.2000, 1, 0.008, "YDE"),
    ("Ntui", "NTU", 4.4500, 11.6300, 1, 0.008, "YDE"),
    ("Nanga-Eboko", "NAN", 4.6800, 12.3700, 1, 0.008, "YDE"),
]
assert sum(city[4] for city in SCALE_CITIES) == 70
assert len({city[1] for city in SCALE_CITIES}) == len(SCALE_CITIES), "codes de ville en double"

SCALE_FLEET = [(TruckSize.SMALL, 6), (TruckSize.MEDIUM, 12), (TruckSize.LARGE, 7)]
SCALE_CARRIERS = ["TR-OLA", "TR-SOTRACAM", "TR-TRANSLOG"]
SCALE_ORDERS = 120
SCALE_URGENT = 10
SCALE_WINDOWED = 12


def build_demo_scale() -> PlanningProblem:
    rng = random.Random(SEED)
    # Grand jeu : on laisse la recherche locale travailler, tout en restant loin des 60 s (F4.5).
    params = Params(solver_time_limit_s=30, solver_no_improvement_s=15)
    depots = [DOUALA_DEPOT, YAOUNDE_DEPOT]
    depot_of_zone = {"DLA": DOUALA_DEPOT, "YDE": YAOUNDE_DEPOT}
    speed_m_s = params.default_avg_speed_kmh / 3.6

    stations: list[StationD] = []
    travel_s: dict[str, int] = {}  # trajet depuis le dépôt de la zone (repli haversine)
    for city, prefix, lat, lon, count, spread, zone in SCALE_CITIES:
        for k in range(1, count + 1):
            code = f"{prefix}{k:02d}"
            s_lat = round(lat + rng.uniform(-spread, spread), 5)
            s_lon = round(lon + rng.uniform(-spread, spread), 5)
            in_big_city = count >= 10
            if in_big_city:
                size = rng.choices([TruckSize.SMALL, TruckSize.MEDIUM, TruckSize.LARGE], weights=[2, 5, 3])[0]
            else:
                size = rng.choice([TruckSize.MEDIUM, TruckSize.LARGE, TruckSize.LARGE])
            opening, closing = rng.choice([(6, 18), (6, 19), (7, 19), (6, 20)])
            if not in_big_city:
                closing = 20  # les stations éloignées reçoivent plus tard
            stations.append(
                StationD(
                    code,
                    code,
                    s_lat,
                    s_lon,
                    windows=((opening * H, closing * H),),
                    max_truck_size=size,
                    unload_time_min=rng.choice([35, 40, 45]),
                    name=f"OLA {city} {k}",
                )
            )
            depot = depot_of_zone[zone]
            meters = haversine_m(depot.lat, depot.lon, s_lat, s_lon) * params.haversine_factor
            travel_s[code] = int(meters / speed_m_s)
    round_trip_limit = params.max_service_s - 2 * H
    assert all(2 * t <= round_trip_limit for t in travel_s.values()), (
        "station hors de portée d'un aller-retour"
    )

    trucks: list[TruckD] = []
    for size, count in SCALE_FLEET:
        for _ in range(count):
            index = len(trucks) + 1
            layout = COMPARTMENT_LAYOUTS[size][index % 2]
            carrier = SCALE_CARRIERS[index % len(SCALE_CARRIERS)]
            plate = (
                f"{rng.choice(['LT', 'CE'])}-{500 + index}-{rng.choice('ABCDEFGH')}{rng.choice('ABCDEFGH')}"
            )
            trucks.append(_truck(f"CAM{index:02d}", plate, size, layout, carrier))

    drivers: list[DriverD] = []
    names: set[str] = set()
    for truck in trucks:  # un chauffeur habituel par camion
        drivers.append(_driver(rng, names, len(drivers) + 1, truck.carrier_id, default_truck_id=truck.id))
    for carrier in SCALE_CARRIERS:  # un chauffeur de réserve par transporteur
        drivers.append(_driver(rng, names, len(drivers) + 1, carrier))
    # Deux indisponibilités réalistes : un permis expiré (RM-03) et un congé ; les réserves compensent.
    drivers[3] = replace(drivers[3], license_expiry=date(2026, 12, 31))
    drivers[10] = replace(drivers[10], status="leave")

    min_capacity = {
        size: min(sum(layout) for layout in COMPARTMENT_LAYOUTS[size])
        * (1 - params.compartment_safety_margin_pct / 100)
        for size in TruckSize
    }
    wait_load_s = {
        zone: (depot.avg_wait_min + params.depot_loading_time_min) * 60
        for zone, depot in depot_of_zone.items()
    }
    zone_of = {}
    for _, prefix, _, _, count, _, zone in SCALE_CITIES:
        for k in range(1, count + 1):
            zone_of[f"{prefix}{k:02d}"] = zone

    orders: list[OrderD] = []
    # Chaque station commande au moins une fois, au plus trois (une commande par produit).
    picks = list(stations) + rng.sample(stations * 2, k=SCALE_ORDERS - len(stations))
    rng.shuffle(picks)
    urgent = set(rng.sample(range(SCALE_ORDERS), SCALE_URGENT))
    windowed = set(rng.sample(range(SCALE_ORDERS), SCALE_WINDOWED))
    taken: set[tuple[str, str]] = set()
    for i, station in enumerate(picks):
        product = rng.choices(["SUPER", "GASOIL", "PETROLE"], weights=[5, 4, 1])[0]
        if (station.id, product) in taken:  # une commande par station et par produit
            product = next(p for p in ("SUPER", "GASOIL", "PETROLE") if (station.id, p) not in taken)
        taken.add((station.id, product))
        ceiling = min(9000.0, min_capacity[station.max_truck_size])
        volume = float(min(ceiling, rng.choice([3000, 4000, 4000, 5000, 5000, 6000, 7000, 8000])))
        if product == "PETROLE":
            volume = float(rng.choice([2000, 3000]))
        window = None
        if i in windowed:
            # Fenêtre de 4 h, ouverte au plus tôt 1 h après la première arrivée possible.
            earliest = params.day_start_s + wait_load_s[zone_of[station.id]] + travel_s[station.id]
            opening, closing = station.windows[0]
            first = (max(earliest + H, opening) + H - 1) // H
            last = (closing - 4 * H) // H
            start = rng.randint(first, max(first, last)) * H
            window = (start, min(start + 4 * H, closing))
        priority = OrderPriority.URGENT if i in urgent else OrderPriority.NORMAL
        orders.append(OrderD(f"CMD{i + 1:03d}", station.id, product, volume, priority, window))

    demand: dict[str, float] = {}
    for order in orders:
        demand[order.product_id] = demand.get(order.product_id, 0.0) + order.requested_l
    stocks = {
        (depot.id, product): round(volume, -3) + 20000.0
        for depot in depots
        for product, volume in demand.items()
    }

    return PlanningProblem(
        day=DAY,
        products=PRODUCTS,
        depots=depots,
        stations=stations,
        trucks=trucks,
        drivers=drivers,
        orders=orders,
        depot_stocks=stocks,
        driver_by_truck={},
        params=params,
    )


def check_unique(name: str, problem: PlanningProblem) -> None:
    """Fait échouer la génération si un identifiant, un code, une immatriculation ou un nom est en double."""
    series = {
        "identifiants de dépôt": [d.id for d in problem.depots],
        "identifiants de station": [s.id for s in problem.stations],
        "codes de station": [s.code for s in problem.stations],
        "identifiants de camion": [t.id for t in problem.trucks],
        "immatriculations": [t.plate for t in problem.trucks],
        "identifiants de compartiment": [c.id for t in problem.trucks for c in t.compartments],
        "identifiants de chauffeur": [d.id for d in problem.drivers],
        "noms de chauffeur": [d.full_name for d in problem.drivers],
        "identifiants de commande": [o.id for o in problem.orders],
    }
    for label, values in series.items():
        duplicates = sorted({v for v in values if values.count(v) > 1})
        if duplicates:
            raise ValueError(f"{name} : {label} en double : {', '.join(duplicates)}")


BUILDERS = {
    "demo_douala": build_demo_douala,
    "demo_shortage": build_demo_shortage,
    "demo_scale": build_demo_scale,
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=ROOT / "data" / "fixtures", help="répertoire de sortie")
    parser.add_argument(
        "--check", action="store_true", help="vérifie que les fichiers versionnés sont à jour"
    )
    args = parser.parse_args()
    status = 0
    for name, builder in BUILDERS.items():
        problem = builder()
        check_unique(name, problem)
        target = args.out / name / "problem.json"
        if args.check:
            import json

            current = json.loads(target.read_text(encoding="utf-8")) if target.exists() else None
            ok = current == json.loads(json.dumps(problem_to_dict(problem)))
            print(f"{name} : {'à jour' if ok else 'PÉRIMÉ'}")
            status |= 0 if ok else 1
        else:
            dump_problem(problem, target)
            print(
                f"{name} : {len(problem.depots)} dépôt(s), {len(problem.stations)} stations, "
                f"{len(problem.trucks)} camions, {len(problem.drivers)} chauffeurs, "
                f"{len(problem.orders)} commandes"
                f" → {target.relative_to(ROOT)}"
            )
    return status


if __name__ == "__main__":
    raise SystemExit(main())
