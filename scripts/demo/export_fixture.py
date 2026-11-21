#!/usr/bin/env python3
"""Convertit un jeu du moteur (`data/fixtures/<nom>/problem.json`) en fichiers importables par l'API.

    cd backend && uv run python ../scripts/demo/export_fixture.py demo_douala
    cd backend && uv run python ../scripts/demo/export_fixture.py --all
    cd backend && uv run python ../scripts/demo/export_fixture.py demo_douala --day 2027-02-02 --out /tmp/x

Sorties, dans `data/fixtures/<nom>/import/` :

- `depots.xlsx`, `stations.xlsx` (une ligne par cuve), `trucks.xlsx` (une ligne par compartiment),
  `drivers.xlsx`, `orders.xlsx` : au format exact des modèles du lot L3 (mêmes colonnes, mêmes en-têtes,
  feuille « Lisez-moi ») — les classeurs sont écrits par `app.imports.templates.build_template`, la même
  fonction que celle qui produit `data/templates/`, alimentée par les lignes du jeu au lieu des exemples ;
- `depot_stocks.json` : stocks dépôt du jour (la spec ne prévoit pas d'import pour eux : le chargeur
  les saisit par `PUT /availability/depot-stocks`) ;
- `compute.json` : ce qui, dans le jeu, n'a pas de fichier d'import — paramètres de calcul propres au jeu
  (écarts aux valeurs par défaut, à passer à `POST /plans/compute`) et affectations camion → chauffeur
  du jour (F2.4, `PUT /availability/drivers`).

Ce script **écrit** des fichiers Excel et ne lit que du JSON : la lecture d'Excel reste réservée à
`backend/app/imports/` (critère d'acceptation 7).

Un `problem.json` ne contient que ce dont le moteur a besoin. Ce qui manque pour remplir les modèles est
complété ici, de façon déterministe (voir `docs/questions/l15-demo.md`) : région et ville des stations,
cuves, numéro de permis des chauffeurs, nom et type des transporteurs, exploitant des dépôts, horaires
(les fenêtres du jour J sont reportées sur tous les jours de la semaine).
"""

from __future__ import annotations

import argparse
import io
import json
import math
import re
import sys
import zipfile
from dataclasses import fields, replace
from datetime import date, time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.core.enums import ImportKind, TruckSize, TruckStatus  # noqa: E402
from app.imports import columns  # noqa: E402
from app.imports.templates import build_template  # noqa: E402
from app.planning.domain import DAY_S, Params, PlanningProblem  # noqa: E402
from app.planning.fixtures import fixtures_dir, load_problem  # noqa: E402

FIXTURES = ("demo_douala", "demo_shortage", "demo_scale")
XLSX_FILES = {
    ImportKind.DEPOTS: "depots.xlsx",
    ImportKind.STATIONS: "stations.xlsx",
    ImportKind.TRUCKS: "trucks.xlsx",
    ImportKind.DRIVERS: "drivers.xlsx",
    ImportKind.ORDERS: "orders.xlsx",
}
# Ordre d'import imposé par les dépendances : camions avant chauffeurs (camion habituel),
# stations avant commandes.
IMPORT_ORDER = (
    ImportKind.DEPOTS,
    ImportKind.STATIONS,
    ImportKind.TRUCKS,
    ImportKind.DRIVERS,
    ImportKind.ORDERS,
)
STOCKS_FILE = "depot_stocks.json"
COMPUTE_FILE = "compute.json"

# --------------------------------------------------------------------------- compléments déterministes

# Ville → région administrative (les noms de villes des jeux sont réels).
REGION_BY_CITY = {
    "Douala": "Littoral",
    "Mbanga": "Littoral",
    "Loum": "Littoral",
    "Nkongsamba": "Littoral",
    "Edéa": "Littoral",
    "Dizangué": "Littoral",
    "Limbé": "Sud-Ouest",
    "Buea": "Sud-Ouest",
    "Tiko": "Sud-Ouest",
    "Kumba": "Sud-Ouest",
    "Kribi": "Sud",
    "Ebolowa": "Sud",
    "Sangmélima": "Sud",
    "Yaoundé": "Centre",
    "Mbalmayo": "Centre",
    "Obala": "Centre",
    "Soa": "Centre",
    "Mfou": "Centre",
    "Bafia": "Centre",
    "Akonolinga": "Centre",
    "Eséka": "Centre",
    "Monatélé": "Centre",
    "Ntui": "Centre",
    "Nanga-Eboko": "Centre",
}
# Identifiant de transporteur du jeu → (nom, type du fichier camions).
CARRIERS = {"TR-OLA": ("OLA Flotte", "propre")}

SIZE_LABEL = {size: label for label, size in columns.SIZES.items()}
TRUCK_STATUS_LABEL = {status: label for label, status in columns.TRUCK_STATUSES.items()}
DRIVER_STATUS_LABEL = {status.value: label for label, status in columns.DRIVER_STATUSES.items()}
PRIORITY_LABEL = {priority: label for label, priority in columns.PRIORITIES.items()}

# Cuves fabriquées : capacité par défaut et part du stock de sécurité (contrôle F3.4 à la confirmation).
TANK_DEFAULT_L = {"SUPER": 30000, "GASOIL": 30000}
TANK_OTHER_L = 15000
TANK_STEP_L = 5000
TANK_SAFETY_SHARE = 0.10


def carrier_of(carrier_id: str | None) -> tuple[str | None, str | None]:
    """Nom et type du transporteur : `TR-SOTRACAM` → (« Sotracam », « tiers »)."""
    if carrier_id is None:
        return None, None
    if carrier_id in CARRIERS:
        return CARRIERS[carrier_id]
    return carrier_id.removeprefix("TR-").capitalize(), "tiers"


def license_no(driver_id: str) -> str:
    """Numéro de permis fictif, clé d'import d'un chauffeur (question L3-14)."""
    return f"PERMIS-{driver_id}"


def city_of(station: Any) -> str:
    """« OLA Yaoundé 12 » → Yaoundé (jeu à l'échelle) ; sinon une station de quartier de Douala."""
    words = station.name.removeprefix("OLA ").rsplit(" ", 1)
    if len(words) == 2 and words[1].isdigit() and words[0] in REGION_BY_CITY:
        return words[0]
    return "Douala"


def _hm(seconds: int) -> str:
    seconds = min(int(seconds), DAY_S)
    return f"{seconds // 3600:02d}:{(seconds % 3600) // 60:02d}"


def hours_text(windows: tuple[tuple[int, int], ...]) -> str | None:
    """Fenêtres du jour J → texte d'horaires du modèle, appliqué à tous les jours de la semaine."""
    if not windows:
        return None
    if tuple(windows) == ((0, DAY_S),):
        return "24h/24"
    return "lun-dim " + ", ".join(f"{_hm(start)}-{_hm(end)}" for start, end in windows)


def _time(seconds: int) -> time:
    seconds = min(int(seconds), DAY_S - 60)
    return time(seconds // 3600, (seconds % 3600) // 60)


def _num(value: float) -> int | float:
    return int(value) if float(value).is_integer() else float(value)


# --------------------------------------------------------------------------- lignes des fichiers


def _row(spec: columns.FileSpec, **values: Any) -> tuple[Any, ...]:
    """Ligne dans l'ordre des colonnes du modèle ; une clé inconnue est une erreur de programmation."""
    keys = [c.key for c in spec.columns]
    unknown = set(values) - set(keys)
    if unknown:
        raise KeyError(f"Colonnes absentes du modèle {spec.kind.value} : {sorted(unknown)}")
    return tuple(values.get(key) for key in keys)


def depot_rows(problem: PlanningProblem) -> list[tuple]:
    return [
        _row(
            columns.DEPOTS,
            code=depot.code,
            name=depot.name or depot.code,
            operator="SCDP" if depot.code.upper().startswith("SCDP") else "tiers",
            lat=depot.lat,
            lon=depot.lon,
            opening_hours=hours_text(depot.windows),
            avg_wait_min=depot.avg_wait_min,
            max_loadings_per_truck_day=depot.max_loadings_per_truck_day,
            active="oui",
        )
        for depot in problem.depots
    ]


def unique_stations(problem: PlanningProblem) -> list[Any]:
    """Stations du jeu, une par identifiant (la première rencontrée).

    `demo_scale` contient deux stations de même identifiant et de même code (`MBA01` : Mbanga 1 et
    Mbalmayo 1, défaut du générateur signalé dans `docs/DEMO.md`). Le moteur résout un identifiant
    par `problem.station()`, qui renvoie la première : la seconde n'est jamais desservie. L'export
    garde la même lecture — un code station est unique à l'import."""
    seen: dict[str, Any] = {}
    for station in problem.stations:
        seen.setdefault(station.id, station)
    return list(seen.values())


def duplicate_stations(problem: PlanningProblem) -> list[str]:
    """Noms des stations écartées par `unique_stations`."""
    kept = {id(s) for s in unique_stations(problem)}
    return [f"{s.code} ({s.name})" for s in problem.stations if id(s) not in kept]


def station_tanks(problem: PlanningProblem) -> dict[str, list[tuple[str, int, int]]]:
    """Cuves fabriquées par station : (code produit, capacité, stock de sécurité).

    Chaque station reçoit une cuve de super et une de gasoil, plus une cuve par autre produit qu'elle
    commande. La capacité est relevée si nécessaire pour que la plus grosse commande du jeu passe le
    contrôle F3.4 (volume ≤ capacité − stock de sécurité)."""
    codes = {p.id: p.code for p in problem.products}
    largest: dict[tuple[str, str], float] = {}
    for order in problem.orders:
        key = (order.station_id, codes[order.product_id])
        largest[key] = max(largest.get(key, 0.0), order.requested_l)
    tanks: dict[str, list[tuple[str, int, int]]] = {}
    for station in unique_stations(problem):
        rows = []
        for product in problem.products:
            ordered = largest.get((station.id, product.code), 0.0)
            if product.code not in TANK_DEFAULT_L and not ordered:
                continue
            capacity = TANK_DEFAULT_L.get(product.code, TANK_OTHER_L)
            needed = ordered / (1 - TANK_SAFETY_SHARE)
            if needed > capacity:
                capacity = math.ceil(needed / TANK_STEP_L) * TANK_STEP_L
            rows.append((product.code, capacity, int(capacity * TANK_SAFETY_SHARE)))
        tanks[station.id] = rows
    return tanks


def station_rows(problem: PlanningProblem) -> list[tuple]:
    rows = []
    tanks = station_tanks(problem)
    for station in unique_stations(problem):
        city = city_of(station)
        head = {
            "name": station.name or station.code,
            "region": REGION_BY_CITY.get(city),
            "city": city,
            "lat": station.lat,
            "lon": station.lon,
            "opening_hours": hours_text(station.windows),
            "max_truck_size": SIZE_LABEL[TruckSize(station.max_truck_size)],
            "unload_time_min": station.unload_time_min,
            "active": "oui",
        }
        for index, (product_code, capacity, safety) in enumerate(tanks[station.id]):
            rows.append(
                _row(
                    columns.STATIONS,
                    code=station.code,
                    **(head if index == 0 else {}),
                    product_code=product_code,
                    capacity_l=capacity,
                    safety_stock_l=safety,
                )
            )
    return rows


def truck_rows(problem: PlanningProblem) -> list[tuple]:
    codes = {p.id: p.code for p in problem.products}
    rows = []
    for truck in problem.trucks:
        carrier_name, carrier_type = carrier_of(truck.carrier_id)
        head = {
            "carrier_name": carrier_name,
            "carrier_type": carrier_type,
            "size": SIZE_LABEL[TruckSize(truck.size)],
            "total_capacity_l": _num(truck.total_capacity_l),
            "avg_speed_kmh": truck.avg_speed_kmh,
            "status": TRUCK_STATUS_LABEL[TruckStatus(truck.status)],
        }
        for index, compartment in enumerate(sorted(truck.compartments, key=lambda c: c.position)):
            allowed = (
                "tous"
                if compartment.allowed_product_ids is None
                else ", ".join(sorted(codes[p] for p in compartment.allowed_product_ids))
            )
            rows.append(
                _row(
                    columns.TRUCKS,
                    plate=truck.plate,
                    **(head if index == 0 else {}),
                    position=compartment.position,
                    capacity_l=_num(compartment.capacity_l),
                    allowed_product_codes=allowed,
                )
            )
    return rows


def driver_rows(problem: PlanningProblem) -> list[tuple]:
    plates = {t.id: t.plate for t in problem.trucks}
    return [
        _row(
            columns.DRIVERS,
            license_no=license_no(driver.id),
            full_name=driver.full_name,
            license_expiry=driver.license_expiry,
            hazmat_cert="oui" if driver.hazmat_cert else "non",
            hazmat_expiry=driver.hazmat_expiry,
            carrier_name=carrier_of(driver.carrier_id)[0],
            status=DRIVER_STATUS_LABEL[str(driver.status)],
            default_truck_plate=plates.get(driver.default_truck_id) if driver.default_truck_id else None,
        )
        for driver in problem.drivers
    ]


def order_rows(problem: PlanningProblem, day: date | None = None) -> list[tuple]:
    """Commandes du jeu ; `day` remplace la date du jeu (démo rejouée un autre jour)."""
    stations = {s.id: s.code for s in problem.stations}
    codes = {p.id: p.code for p in problem.products}
    rows = []
    for order in problem.orders:
        start, end = order.window if order.window is not None else (None, None)
        rows.append(
            _row(
                columns.ORDERS,
                day=day or problem.day,
                station_code=stations[order.station_id],
                product_code=codes[order.product_id],
                requested_l=_num(order.requested_l),
                priority=PRIORITY_LABEL[order.priority],
                window_start=_time(start) if start is not None else None,
                window_end=_time(end) if end is not None else None,
                comment=order.id,  # référence de la commande dans le jeu (CMD001…)
            )
        )
    return rows


ROW_BUILDERS = {
    ImportKind.DEPOTS: depot_rows,
    ImportKind.STATIONS: station_rows,
    ImportKind.TRUCKS: truck_rows,
    ImportKind.DRIVERS: driver_rows,
}


_ZIP_STAMP = (2026, 11, 21, 8, 0, 0)
_CORE_DATES = re.compile(rb"(<dcterms:(created|modified)[^>]*>)[^<]*(</dcterms:(?:created|modified)>)")


def stable_xlsx(content: bytes) -> bytes:
    """Rend un classeur reproductible à l'octet près : même contenu → même fichier versionné.

    Un .xlsx est une archive zip dont les entrées portent l'heure de création, et dont les propriétés
    (`docProps/core.xml`) portent la date d'enregistrement. On ne touche qu'à ces métadonnées
    d'archive ; aucune cellule n'est lue ni interprétée ici."""
    source = zipfile.ZipFile(io.BytesIO(content))
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as target:
        for info in source.infolist():
            data = source.read(info.filename)
            if info.filename == "docProps/core.xml":
                data = _CORE_DATES.sub(rb"\g<1>2026-11-21T08:00:00Z\g<3>", data)
            entry = zipfile.ZipInfo(info.filename, date_time=_ZIP_STAMP)
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = info.external_attr
            target.writestr(entry, data)
    return buffer.getvalue()


def build_xlsx(kind: ImportKind, problem: PlanningProblem, day: date | None = None) -> bytes:
    """Classeur au format du modèle du kind, rempli avec les lignes du jeu."""
    rows = order_rows(problem, day) if kind == ImportKind.ORDERS else ROW_BUILDERS[kind](problem)
    return stable_xlsx(build_template(replace(columns.SPECS[kind], examples=tuple(rows))))


# --------------------------------------------------------------------------- hors modèles


def stocks_payload(problem: PlanningProblem, day: date | None = None) -> dict[str, Any]:
    """Stocks dépôt du jour, par codes (les identifiants sont résolus par le chargeur)."""
    depots = {d.id: d.code for d in problem.depots}
    codes = {p.id: p.code for p in problem.products}
    return {
        "day": (day or problem.day).isoformat(),
        "items": [
            {"depot_code": depots[depot_id], "product_code": codes[product_id], "available_l": volume}
            for (depot_id, product_id), volume in sorted(problem.depot_stocks.items())
        ],
    }


def compute_payload(problem: PlanningProblem) -> dict[str, Any]:
    """Paramètres de calcul propres au jeu (écarts aux défauts) et affectations du jour (F2.4)."""
    defaults = Params()
    params = {
        f.name: getattr(problem.params, f.name)
        for f in fields(Params)
        if getattr(problem.params, f.name) != getattr(defaults, f.name)
    }
    plates = {t.id: t.plate for t in problem.trucks}
    return {
        "params": params,
        "driver_assignments": [
            {"truck_plate": plates[truck_id], "driver_license_no": license_no(driver_id)}
            for truck_id, driver_id in sorted(problem.driver_by_truck.items())
        ],
    }


def _json(payload: dict[str, Any]) -> bytes:
    return (json.dumps(payload, ensure_ascii=False, indent=1) + "\n").encode("utf-8")


def build_files(problem: PlanningProblem, day: date | None = None) -> dict[str, bytes]:
    """Tous les fichiers d'un jeu : nom de fichier → contenu."""
    files = {XLSX_FILES[kind]: build_xlsx(kind, problem, day) for kind in IMPORT_ORDER}
    files[STOCKS_FILE] = _json(stocks_payload(problem, day))
    files[COMPUTE_FILE] = _json(compute_payload(problem))
    return files


def import_dir(name: str) -> Path:
    return fixtures_dir() / name / "import"


def export(name: str, out: Path | None = None, day: date | None = None) -> Path:
    problem = load_problem(name)
    target = out or import_dir(name)
    target.mkdir(parents=True, exist_ok=True)
    for filename, content in build_files(problem, day).items():
        (target / filename).write_bytes(content)
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("name", nargs="?", help="nom du jeu (demo_douala, demo_shortage, demo_scale)")
    parser.add_argument("--all", action="store_true", help="convertir les trois jeux")
    parser.add_argument("--out", type=Path, help="répertoire de sortie (défaut : <jeu>/import/)")
    parser.add_argument("--day", type=date.fromisoformat, help="date des commandes et des stocks")
    args = parser.parse_args()
    names = FIXTURES if args.all else ([args.name] if args.name else [])
    if not names:
        parser.error("indiquer un nom de jeu ou --all")
    for name in names:
        target = export(name, args.out, args.day)
        problem = load_problem(name)
        for ghost in duplicate_stations(problem):
            print(f"⚠ {name} : station en double dans problem.json, écartée de l'export : {ghost}")
        print(
            f"✔ {name} → {target} : {len(problem.depots)} dépôt(s), "
            f"{len(unique_stations(problem))} stations, "
            f"{len(problem.trucks)} camions, {len(problem.drivers)} chauffeurs, "
            f"{len(problem.orders)} commandes"
        )


if __name__ == "__main__":
    main()
