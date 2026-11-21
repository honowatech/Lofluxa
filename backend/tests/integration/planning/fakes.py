"""Doublures du moteur (lot L2) et des règles (lot L1) pour les tests du service de plans.

Tant que les lots L1 et L2 ne sont pas intégrés, `engine.solve`, `assign_compartments`,
`build_matrix`, `coord_hash` et `rules.check_plan` lèvent `NotImplementedError`. Ces doublures
respectent les signatures de docs/CONTRATS.md ; `install(monkeypatch)` les branche.

À l'intégration : supprimer l'appel à `install` (fixture `fakes` de `conftest.py`) pour faire
tourner les mêmes tests avec le vrai moteur et les vraies règles — les assertions qui dépendent
du comportement exact des doublures sont signalées par `fakes.` dans les tests.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from app.core.enums import OrderPriority, Severity, UnservedReason
from app.core.geo import haversine_m
from app.planning import timing
from app.planning.domain import (
    CompartmentLoadD,
    DeliveryD,
    Matrix,
    Params,
    PlanningProblem,
    PlanningResult,
    StopD,
    TripD,
    TruckD,
    UnservedD,
    ViolationD,
)
from app.planning.engine import compartments, distance_matrix
from app.planning.violations import eligibility, rules

FAKE_ENGINE_VERSION = "fake-1.0"


def fake_coord_hash(lat: float, lon: float) -> str:
    return f"{lat:.5f},{lon:.5f}"


def fake_build_matrix(nodes, params: Params, *, osrm_url=None, cache=None) -> Matrix:
    """Matrice haversine × coefficient, construite à la main ; alimente le cache s'il est fourni."""
    ids = tuple(node_id for node_id, _, _ in nodes)
    hashes = {node_id: fake_coord_hash(lat, lon) for node_id, lat, lon in nodes}
    pairs = [(hashes[a], hashes[b]) for a in ids for b in ids if a != b]
    known = cache.get_many(pairs) if cache is not None else {}
    fresh = {}
    distance, duration = [], []
    speed_ms = params.default_avg_speed_kmh / 3.6
    for a, lat_a, lon_a in nodes:
        row_d, row_t = [], []
        for b, lat_b, lon_b in nodes:
            if a == b:
                row_d.append(0)
                row_t.append(0)
                continue
            pair = (hashes[a], hashes[b])
            if pair in known:
                meters, seconds = known[pair]
            else:
                meters = int(haversine_m(lat_a, lon_a, lat_b, lon_b) * params.haversine_factor)
                seconds = int(meters / speed_ms)
                fresh[pair] = (meters, seconds)
            row_d.append(meters)
            row_t.append(seconds)
        distance.append(row_d)
        duration.append(row_t)
    if cache is not None and fresh:
        cache.put_many(fresh)
    return Matrix(node_ids=ids, distance_m=distance, duration_s=duration, approximate=True)


def fake_assign_compartments(
    truck: TruckD, volumes_by_product: dict[str, float], safety_margin_pct: float
) -> list[CompartmentLoadD] | None:
    """Glouton : plus gros volume → plus gros compartiment compatible encore libre (RM-05/06/07)."""
    free = sorted(truck.compartments, key=lambda c: -c.capacity_l)
    loads: list[CompartmentLoadD] = []
    for product_id, volume in sorted(volumes_by_product.items(), key=lambda kv: (-kv[1], kv[0])):
        remaining = volume
        while remaining > 0.005:
            compartment = next((c for c in free if c.accepts(product_id)), None)
            if compartment is None:
                return None
            free.remove(compartment)
            usable = compartment.capacity_l * (1 - safety_margin_pct / 100)
            loaded = min(remaining, usable)
            loads.append(
                CompartmentLoadD(compartment_id=compartment.id, product_id=product_id, planned_l=loaded)
            )
            remaining -= loaded
    return sorted(
        loads, key=lambda x: next(c.position for c in truck.compartments if c.id == x.compartment_id)
    )


@dataclass
class FakeRules:
    """Faux `check_plan` paramétrable.

    - `extra` : violations renvoyées telles quelles à chaque contrôle (ex. une bloquante, un avertissement) ;
    - `auto` : applique en plus trois contrôles simplifiés — RM-01 (tournée sans chauffeur), RM-04
      (camion non affectable) et RM-15 (commande urgente non servie), bloquants."""

    extra: list[ViolationD] = field(default_factory=list)
    auto: bool = True
    calls: int = 0

    def check_plan(self, problem: PlanningProblem, trips, unserved=None, matrix=None) -> list[ViolationD]:
        self.calls += 1
        violations = list(self.extra)
        if not self.auto:
            return violations
        for trip in trips:
            if trip.driver_id is None:
                violations.append(
                    ViolationD("RM-01", Severity.BLOCKING, f"Tournée {trip.seq} : aucun chauffeur.", trip.seq)
                )
            reason = eligibility.truck_block_reason(problem.truck(trip.truck_id))
            if reason:
                violations.append(
                    ViolationD("RM-04", Severity.BLOCKING, f"Tournée {trip.seq} : {reason}", trip.seq)
                )
        orders = {o.id: o for o in problem.orders}
        for item in unserved or []:
            order = orders.get(item.order_id)
            if order is not None and order.priority == OrderPriority.URGENT:
                violations.append(
                    ViolationD(
                        "RM-15",
                        Severity.BLOCKING,
                        "Commande urgente non servie : à servir ou à reporter explicitement.",
                        order_id=item.order_id,
                    )
                )
        return violations


@dataclass
class FakeEngine:
    """Faux moteur déterministe : une tournée par camion affectable (ordre des immatriculations),
    commandes prises dans l'ordre des codes de station tant que le camion a de la capacité, arrêts
    dans cet ordre. Les tournées verrouillées sont renvoyées telles quelles (RM-17)."""

    rules: FakeRules
    calls: list[PlanningProblem] = field(default_factory=list)
    partial: dict[str, float] = field(default_factory=dict)  # order_id → volume à livrer (RM-16)
    skip: set[str] = field(default_factory=set)  # commandes laissées non servies

    def solve(
        self, problem: PlanningProblem, matrix: Matrix, progress: Callable | None = None
    ) -> PlanningResult:
        self.calls.append(problem)
        if progress:
            progress(10, "Préparation")
        locked = list(problem.locked_trips)
        busy_trucks = {t.truck_id for t in locked}
        served = {d.order_id for t in locked for s in t.stops for d in s.deliveries}
        stations = {s.id: s for s in problem.stations}
        pending = sorted(
            (o for o in problem.orders if o.id not in served),
            key=lambda o: (stations[o.station_id].code, o.id),
        )
        unserved = [
            UnservedD(o.id, UnservedReason.OTHER, "Écartée par la doublure")
            for o in pending
            if o.id in self.skip
        ]
        pending = [o for o in pending if o.id not in self.skip]
        depot = problem.depots[0]
        margin = problem.params.compartment_safety_margin_pct
        trips: list[TripD] = list(locked)
        seq = max((t.seq for t in locked), default=0)
        drivers_used = {t.driver_id for t in locked}

        for truck in problem.trucks:
            if not pending:
                break
            if not truck.affectable or truck.id in busy_trucks:
                continue
            capacity = truck.total_capacity_l * (1 - margin / 100)
            taken, volumes = [], {}
            for order in list(pending):
                volume = self.partial.get(order.id, order.requested_l)
                candidate = {**volumes, order.product_id: volumes.get(order.product_id, 0.0) + volume}
                if sum(candidate.values()) > capacity:
                    continue
                if compartments.assign_compartments(truck, candidate, margin) is None:
                    continue
                volumes = candidate
                taken.append((order, volume))
                pending.remove(order)
            if not taken:
                continue
            seq += 1
            stops: list[StopD] = []
            for order, volume in taken:
                stop = next((s for s in stops if s.station_id == order.station_id), None)
                if stop is None:
                    stop = StopD(seq=len(stops) + 1, station_id=order.station_id)
                    stops.append(stop)
                stop.deliveries.append(
                    DeliveryD(order_id=order.id, product_id=order.product_id, planned_l=volume)
                )
            driver_id = problem.driver_by_truck.get(truck.id) or next(
                (d.id for d in problem.drivers if d.default_truck_id == truck.id), None
            )
            if driver_id in drivers_used:
                driver_id = None
            drivers_used.add(driver_id)
            trip = TripD(seq=seq, truck_id=truck.id, depot_id=depot.id, driver_id=driver_id, stops=stops)
            timing.schedule_trip(trip, problem, matrix, start_s=problem.params.day_start_s)
            trip.loads = compartments.assign_compartments(truck, volumes, margin) or []
            trips.append(trip)

        unserved += [UnservedD(o.id, UnservedReason.NO_TRUCK, "Capacité de flotte épuisée") for o in pending]
        orders = {o.id: o for o in problem.orders}
        unserved.sort(key=lambda u: (orders[u.order_id].priority != OrderPriority.URGENT, u.order_id))
        if progress:
            progress(100, "Terminé")
        return PlanningResult(
            trips=trips,
            unserved=unserved,
            violations=rules.check_plan(problem, trips, unserved, matrix),
            approximate=matrix.approximate,
            engine_version=FAKE_ENGINE_VERSION,
            computed_in_ms=12,
            solver_log={"status": "FAKE", "iterations": 1},
            metrics={"objective_km": 123.4},
        )


@dataclass
class Fakes:
    rules: FakeRules
    engine: FakeEngine


def install(monkeypatch) -> Fakes:
    """Remplace le moteur et les règles par les doublures (signatures du contrat)."""
    import app.planning.engine as engine_pkg

    fake_rules = FakeRules()
    fake_engine = FakeEngine(rules=fake_rules)
    monkeypatch.setattr(distance_matrix, "coord_hash", fake_coord_hash)
    monkeypatch.setattr(distance_matrix, "build_matrix", fake_build_matrix)
    monkeypatch.setattr(compartments, "assign_compartments", fake_assign_compartments)
    monkeypatch.setattr(rules, "check_plan", fake_rules.check_plan)
    monkeypatch.setattr(engine_pkg, "solve", fake_engine.solve)
    monkeypatch.setattr(engine_pkg, "ENGINE_VERSION", FAKE_ENGINE_VERSION)
    return Fakes(rules=fake_rules, engine=fake_engine)
