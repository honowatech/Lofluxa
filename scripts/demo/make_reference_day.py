#!/usr/bin/env python3
"""Fabrique une « journée A manuelle » plausible et volontairement médiocre à partir d'un jeu du moteur.

    cd backend && uv run python ../scripts/demo/make_reference_day.py            # demo_douala
    cd backend && uv run python ../scripts/demo/make_reference_day.py demo_scale --out /tmp/a.xlsx

Sortie : `data/fixtures/<nom>/import/reference_day.xlsx`, au format du modèle du lot L7
(`data/templates/reference_day.xlsx`, feuilles « Journée », « Commandes », « Tournées »), à importer par
`POST /reference-days/import`. Elle tient lieu de journée réelle d'OLA tant que celle-ci n'est pas
fournie (preuve A/B de bout en bout, critères d'acceptation 1 et 2).

Heuristique du « dispatcher pressé » — aucune optimisation, mais un plan réalisable :

1. les stations sont prises **dans l'ordre de leur code**, sans regarder la carte ; seules celles dont
   une commande a une fenêtre horaire passent en tête de liste (ce qu'un dispatcher fait spontanément) ;
2. les camions sont pris dans l'ordre de leur immatriculation, chacun avec son chauffeur habituel ;
   chaque camion fait une tournée, puis un second tour de la flotte si des stations restent ;
3. un camion parcourt la liste et prend chaque station qui tient encore dans ses compartiments
   (premier qui rentre, sans chercher le meilleur remplissage ni regrouper les stations voisines) ;
   une station trop petite pour le camion est laissée au camion suivant ;
4. dans la tournée, les arrêts restent dans l'ordre de la liste.

Le plan n'est pas inventé « faux » : la répartition par compartiment est vérifiée par la fonction du
moteur (`assign_compartments`), et le résultat est contrôlé par les vraies règles avant d'être écrit —
les violations éventuelles sont affichées. Les « km réels » sont les kilomètres estimés (repli
haversine) majorés de 5 %, arrondis au kilomètre : un compteur plausible, pas une mesure.

Ce script écrit un fichier Excel et ne lit que du JSON (critère d'acceptation 7).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import export_fixture  # noqa: E402
from app.core.enums import Severity, UnservedReason  # noqa: E402  (chemin `backend/` ajouté par export_fixture)
from app.imports.reference_day import TEMPLATE_README, build_workbook  # noqa: E402
from app.planning.domain import DeliveryD, PlanningProblem, StopD, TripD, TruckD, UnservedD  # noqa: E402
from app.planning.engine.compartments import assign_compartments  # noqa: E402
from app.planning.engine.distance_matrix import haversine_matrix, problem_nodes  # noqa: E402
from app.planning.fixtures import load_problem  # noqa: E402
from app.planning.timing import schedule_trip  # noqa: E402
from app.planning.violations import rules  # noqa: E402

REFERENCE_FILE = "reference_day.xlsx"
PREP_TIME_MIN = 120  # temps de préparation déclaré du plan manuel (F8.4)
ACTUAL_KM_FACTOR = 1.05
_SIZE_RANK = {"small": 0, "medium": 1, "large": 2}


def _fits(problem: PlanningProblem, truck: TruckD, station_ids: list[str]) -> bool:
    """Toutes les commandes de ces stations tiennent-elles dans les compartiments du camion ?"""
    volumes: dict[str, float] = {}
    for order in problem.orders:
        if order.station_id in station_ids:
            volumes[order.product_id] = volumes.get(order.product_id, 0.0) + order.requested_l
    return assign_compartments(truck, volumes, problem.params.compartment_safety_margin_pct) is not None


def _accepts(problem: PlanningProblem, station_id: str, truck: TruckD) -> bool:
    station = problem.station(station_id)
    return _SIZE_RANK[truck.size.value] <= _SIZE_RANK[station.max_truck_size.value]


def naive_trips(problem: PlanningProblem) -> list[TripD]:
    """Tournées du dispatcher pressé (voir l'en-tête du module)."""
    codes = {s.id: s.code for s in problem.stations}
    windowed = {o.station_id for o in problem.orders if o.window is not None}
    pending = sorted({o.station_id for o in problem.orders}, key=lambda s: (s not in windowed, codes[s]))
    trucks = sorted((t for t in problem.trucks if t.affectable), key=lambda t: t.plate)
    driver_of = {d.default_truck_id: d.id for d in problem.drivers if d.default_truck_id}
    driver_of.update(problem.driver_by_truck)
    depot = problem.depots[0]

    trips: list[TripD] = []
    for _ in range(problem.max_loadings(depot)):
        for truck in trucks:
            taken: list[str] = []
            for station_id in list(pending):
                if not _accepts(problem, station_id, truck):
                    continue  # laissée au camion suivant
                if not _fits(problem, truck, [*taken, station_id]):
                    continue  # ne tient plus : on essaie la suivante de la liste
                taken.append(station_id)
            if not taken:
                continue
            pending = [s for s in pending if s not in taken]
            stops = [
                StopD(
                    seq=index,
                    station_id=station_id,
                    deliveries=[
                        DeliveryD(o.id, o.product_id, o.requested_l)
                        for o in problem.orders
                        if o.station_id == station_id
                    ],
                )
                for index, station_id in enumerate(taken, start=1)
            ]
            trips.append(
                TripD(
                    seq=len(trips) + 1,
                    truck_id=truck.id,
                    depot_id=depot.id,
                    driver_id=driver_of.get(truck.id),
                    stops=stops,
                )
            )
    return trips


def schedule_and_check(problem: PlanningProblem, trips: list[TripD]) -> tuple[int, list]:
    """Horaires (comme l'import : les tournées d'un camion s'enchaînent), km estimés et violations."""
    matrix = haversine_matrix(problem_nodes(problem), problem.params)
    last_return: dict[str, int] = {}
    for trip in trips:
        resources = [r for r in (trip.truck_id, trip.driver_id) if r]
        start = max((last_return.get(r, 0) for r in resources), default=0)
        schedule_trip(trip, problem, matrix, start_s=start)
        trip.loads = (
            assign_compartments(
                problem.truck(trip.truck_id),
                trip.volumes_by_product(),
                problem.params.compartment_safety_margin_pct,
            )
            or []
        )
        for resource in resources:
            last_return[resource] = trip.return_s
    served = {d.order_id for t in trips for s in t.stops for d in s.deliveries}
    unserved = [UnservedD(o.id, UnservedReason.OTHER) for o in problem.orders if o.id not in served]
    return sum(t.distance_m for t in trips), rules.check_plan(problem, trips, unserved, matrix)


def workbook(problem: PlanningProblem, trips: list[TripD]) -> bytes:
    stations = {s.id: s.code for s in problem.stations}
    products = {p.id: p.code for p in problem.products}
    depots = {d.id: d.code for d in problem.depots}

    def hm(window: tuple[int, int] | None, index: int) -> str | None:
        if window is None:
            return None
        return f"{window[index] // 3600:02d}:{(window[index] % 3600) // 60:02d}"

    order_rows = [
        (
            stations[o.station_id],
            products[o.product_id],
            export_fixture._num(o.requested_l),
            o.priority.value,
            hm(o.window, 0),
            hm(o.window, 1),
            o.id,
        )
        for o in problem.orders
    ]
    trip_rows = []
    for trip in trips:
        first = True
        for stop in trip.stops:
            for delivery in stop.deliveries:
                head = (
                    (
                        problem.truck(trip.truck_id).plate,
                        export_fixture.license_no(trip.driver_id) if trip.driver_id else None,
                        depots[trip.depot_id],
                    )
                    if first
                    else (None, None, None)
                )
                km = round(trip.distance_m * ACTUAL_KM_FACTOR / 1000) if first else None
                trip_rows.append(
                    (
                        trip.seq,
                        *head,
                        stop.seq,
                        stations[stop.station_id],
                        products[delivery.product_id],
                        export_fixture._num(delivery.planned_l),
                        km,
                        None,
                        None,
                        None,
                        None,
                    )
                )
                first = False
    return build_workbook(
        day=problem.day.isoformat(),
        prep_time_min=PREP_TIME_MIN,
        label="Journée A — plan manuel fabriqué (démonstration)",
        orders=order_rows,
        trips=trip_rows,
        readme=TEMPLATE_README,
    )


def build(name: str) -> tuple[bytes, dict]:
    """Classeur de la journée fabriquée et résumé (km estimés, camions, violations)."""
    problem = load_problem(name)
    trips = naive_trips(problem)
    distance_m, violations = schedule_and_check(problem, trips)
    served = {d.order_id for t in trips for s in t.stops for d in s.deliveries}
    summary = {
        "trips": len(trips),
        "trucks": len({t.truck_id for t in trips}),
        "distance_km": round(distance_m / 1000, 1),
        "orders_served": len(served),
        "orders_total": len(problem.orders),
        "blocking": [v for v in violations if v.severity == Severity.BLOCKING],
        "warnings": [v for v in violations if v.severity == Severity.WARNING],
        "trips_detail": [
            (t.seq, problem.truck(t.truck_id).plate, [problem.station(s.station_id).code for s in t.stops])
            for t in trips
        ],
    }
    return workbook(problem, trips), summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Fabrique une journée de référence manuelle.")
    parser.add_argument("name", nargs="?", default="demo_douala", choices=export_fixture.FIXTURES)
    parser.add_argument("--out", type=Path, help="fichier de sortie (défaut : <jeu>/import/)")
    args = parser.parse_args()
    content, summary = build(args.name)
    target = args.out or export_fixture.import_dir(args.name) / REFERENCE_FILE
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
    print(
        f"✔ {target} : {summary['trips']} tournées, {summary['trucks']} camions, "
        f"{summary['distance_km']} km estimés (haversine), "
        f"{summary['orders_served']}/{summary['orders_total']} commandes livrées, "
        f"{len(summary['blocking'])} violation(s) bloquante(s), {len(summary['warnings'])} avertissement(s)"
    )
    for seq, plate, codes in summary["trips_detail"]:
        print(f"   tournée {seq} — {plate} : {' → '.join(codes)}")
    for violation in [*summary["blocking"], *summary["warnings"]]:
        print(f"   {violation.severity.value} {violation.rule_code} : {violation.message}")


if __name__ == "__main__":
    main()
