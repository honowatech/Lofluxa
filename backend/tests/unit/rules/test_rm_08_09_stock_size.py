"""RM-08 (stock dépôt) et RM-09 (gabarit accepté par la station)."""

from app.core.enums import Severity, TruckSize, TruckStatus
from app.planning.violations import rules

from .builders import GASOIL, SUPER, H, driver, make_problem, simple_trip, station, stop, trip, truck

# ------------------------------------------------------------------ RM-08


def test_RM_08_volume_planifie_sous_le_stock_conforme():
    assert rules.rm_08_depot_stock(make_problem(), [simple_trip()]) == []


def test_RM_08_egalite_au_stock_conforme():
    problem = make_problem(depot_stocks={("D1", SUPER): 5_000.0, ("D1", GASOIL): 4_000.0})
    assert rules.rm_08_depot_stock(problem, [simple_trip()]) == []


def test_RM_08_depassement_du_stock_cumule_sur_plusieurs_tournees_bloquant():
    problem = make_problem(
        trucks=[truck("T1"), truck("T2", "LT-002-BB")],
        drivers=[driver("DR1"), driver("DR2", "Paul")],
        depot_stocks={("D1", SUPER): 8_000.0},
    )
    trips = [
        trip(1, stops=[stop("S1", [("O1", SUPER, 5_000)])]),
        trip(2, truck_id="T2", driver_id="DR2", stops=[stop("S2", [("O9", SUPER, 4_000)])]),
    ]
    violations = rules.rm_08_depot_stock(problem, trips)
    assert len(violations) == 1
    v = violations[0]
    assert (v.rule_code, v.severity, v.trip_seq) == ("RM-08", Severity.BLOCKING, None)
    assert "DLA" in v.message and "9 000 L de SUPER" in v.message and "8 000 L" in v.message
    assert "1 000 L" in v.message and "1, 2" in v.message


def test_RM_08_stock_non_renseigne_avertissement():
    problem = make_problem(depot_stocks={("D1", SUPER): 50_000.0})
    violations = rules.rm_08_depot_stock(problem, [simple_trip()])
    assert len(violations) == 1
    v = violations[0]
    assert (v.rule_code, v.severity) == ("RM-08", Severity.WARNING)
    assert "stock non renseigné" in v.message and "GASOIL" in v.message
    assert not rules.has_blocking(violations)


def test_RM_08_stock_saisi_a_zero_bloquant():
    problem = make_problem(depot_stocks={("D1", SUPER): 0.0, ("D1", GASOIL): 10_000.0})
    violations = rules.rm_08_depot_stock(problem, [simple_trip()])
    assert [v.severity for v in violations] == [Severity.BLOCKING]


# ------------------------------------------------------------------ RM-09


def test_RM_09_gabarit_egal_au_maximum_accepte_conforme():
    problem = make_problem(stations=[station("S1", max_truck_size=TruckSize.MEDIUM), station("S2", "BONA")])
    assert rules.rm_09_truck_size(problem, [simple_trip()]) == []


def test_RM_09_camion_trop_grand_pour_la_station_bloquant():
    problem = make_problem(stations=[station("S1"), station("S2", "BONA", max_truck_size=TruckSize.SMALL)])
    violations = rules.rm_09_truck_size(problem, [simple_trip(2)])
    assert len(violations) == 1
    v = violations[0]
    assert (v.rule_code, v.severity, v.trip_seq, v.stop_seq) == ("RM-09", Severity.BLOCKING, 2, 2)
    assert "LT-001-AA" in v.message and "BONA" in v.message and "petit" in v.message


def test_RM_09_predicat_camion_peut_livrer_la_station():
    small, large = truck("T1", size=TruckSize.SMALL), truck("T2", "LT-002-BB", size=TruckSize.LARGE)
    broken = truck("T3", "LT-003-CC", size=TruckSize.SMALL, status=TruckStatus.BROKEN)
    narrow = station("S1", max_truck_size=TruckSize.SMALL)
    assert rules.truck_can_serve_station(small, narrow)
    assert not rules.truck_can_serve_station(large, narrow)
    assert rules.truck_can_serve_station(large, station("S2"))
    problem = make_problem(trucks=[small, large, broken], stations=[narrow])
    assert rules.trucks_for_station(problem, narrow) == [small]


def test_RM_09_station_inconnue_ignoree():
    t = trip(stops=[stop("S?", [], arrival_s=9 * H)])
    assert rules.rm_09_truck_size(make_problem(), [t]) == []
