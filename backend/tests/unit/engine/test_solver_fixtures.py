"""Tests du moteur sur les jeux de la spec §7.5."""

import copy
import time
from dataclasses import replace

import pytest

from app.core.enums import Severity, UnservedReason
from app.planning.engine import ENGINE_VERSION, solve
from app.planning.engine.distance_matrix import build_matrix, problem_nodes
from app.planning.fixtures import load_problem

from .helpers import check_invariants, served_ids


def _load(name: str):
    problem = load_problem(name)
    return problem, build_matrix(problem_nodes(problem), problem.params)


def test_demo_douala_toutes_commandes_servies_sans_violation_en_moins_de_10_s():
    problem, matrix = _load("demo_douala")
    started = time.monotonic()
    result = solve(problem, matrix)
    elapsed = time.monotonic() - started

    assert elapsed <= 10.0
    assert result.unserved == []
    assert served_ids(result) == {o.id for o in problem.orders}
    assert check_invariants(problem, matrix, result) == []
    assert result.violations == []

    # Station à gabarit limité (RM-09) : livrée par un petit porteur.
    small_only = next(s for s in problem.stations if s.max_truck_size.value == "small")
    for trip in result.trips:
        if any(stop.station_id == small_only.id for stop in trip.stops):
            assert problem.truck(trip.truck_id).size.value == "small"
    # Fenêtre étroite (RM-10) : arrivée dans la fenêtre de la commande.
    narrow = next(o for o in problem.orders if o.window is not None)
    stop = next(
        s for t in result.trips for s in t.stops if any(d.order_id == narrow.id for d in s.deliveries)
    )
    assert narrow.window[0] <= stop.arrival_s <= narrow.window[1]

    # Sorties de la spec §7.4 : métriques et journal de résolution.
    metrics = result.metrics
    assert metrics["orders_served"] == metrics["orders_total"] == 20
    assert metrics["orders_unserved"] == 0 and metrics["orders_partial"] == 0
    assert metrics["volume_planned_l"] == metrics["volume_requested_l"] == 100000.0
    assert metrics["total_distance_km"] == pytest.approx(
        sum(t.distance_m for t in result.trips) / 1000, abs=1e-3
    )
    assert metrics["trips_count"] == len(result.trips)
    assert metrics["trucks_used"] == len({t.truck_id for t in result.trips}) <= 4
    assert metrics["drivers_used"] == len({t.driver_id for t in result.trips})
    assert metrics["total_service_duration_s"] == sum(t.return_s - t.depart_s for t in result.trips)
    assert 0 < metrics["avg_fill_rate_pct"] <= 100
    assert result.engine_version == ENGINE_VERSION != "0.0.0-gabarit"
    assert result.approximate is True  # matrice de repli (pas d'OSRM dans les tests)
    log = result.solver_log
    assert log["status"] == "ROUTING_SUCCESS"
    assert log["wall_time_s"] > 0 and log["objective_km"] > metrics["total_distance_km"]
    assert log["rounds"][0]["solutions"] >= 1
    assert result.computed_in_ms > 0


def test_demo_shortage_non_servies_pour_stock_depot():
    problem, matrix = _load("demo_shortage")
    result = solve(problem, matrix)

    assert check_invariants(problem, matrix, result) == []
    assert result.unserved, "le stock de gasoil ne permet pas de tout servir"
    assert {u.reason_code for u in result.unserved} == {UnservedReason.DEPOT_STOCK}
    assert all(u.reason_text for u in result.unserved)
    assert {problem.order(u.order_id).product_id for u in result.unserved} == {"GASOIL"}
    # RM-08 : le gasoil planifié ne dépasse pas le stock ; RM-15 : l'urgente de gasoil est servie.
    gasoil = sum(t.volumes_by_product().get("GASOIL", 0.0) for t in result.trips)
    assert gasoil <= problem.depot_stocks[("DEP-DLA", "GASOIL")]
    urgent = {o.id for o in problem.orders if o.priority == "urgent"}
    assert urgent <= served_ids(result)
    # Les autres produits ne sont pas touchés par la pénurie.
    assert all(o.id in served_ids(result) for o in problem.orders if o.product_id != "GASOIL")


def test_determinisme_meme_entree_meme_graine_meme_sortie():
    problem, matrix = _load("demo_douala")
    # Seul le critère d'arrêt indépendant de l'horloge doit jouer, quelle que soit la machine.
    problem.params = replace(
        problem.params,
        solver_time_limit_s=120,
        solver_no_improvement_s=120,
        solver_no_improvement_solutions=300,
    )
    first = solve(copy.deepcopy(problem), matrix)
    second = solve(copy.deepcopy(problem), matrix)
    assert first.trips == second.trips
    assert first.unserved == second.unserved
    assert first.metrics == second.metrics
    assert first.solver_log["objective_km"] == second.solver_log["objective_km"]
    for log in (first.solver_log, second.solver_log):
        assert log["rounds"][0]["early_stop_plateau"] is True
        assert log["rounds"][0]["solutions"] == first.solver_log["rounds"][0]["solutions"]


@pytest.mark.slow
def test_demo_scale_moins_de_60_s_sans_violation_bloquante():
    problem, matrix = _load("demo_scale")
    started = time.monotonic()
    result = solve(problem, matrix)
    elapsed = time.monotonic() - started

    assert elapsed < 60.0
    assert check_invariants(problem, matrix, result) == []
    assert not any(v.severity == Severity.BLOCKING for v in result.violations)
    # RM-15 : aucune urgente laissée de côté (elle bloquerait la publication).
    assert not any(problem.order(u.order_id).priority == "urgent" for u in result.unserved)
    # Jeu faisable par construction : tout est servi.
    assert result.unserved == []
    assert result.metrics["orders_served"] == 120
    assert {t.depot_id for t in result.trips} == {"DEP-DLA", "DEP-YDE"}
