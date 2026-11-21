"""RM-10 (fenêtres horaires) et RM-11 (durée de service)."""

from app.core.enums import Severity
from app.planning.domain import Matrix, Params
from app.planning.timing import schedule_trip
from app.planning.violations import rules

from .builders import (
    GASOIL,
    MIN,
    SUPER,
    H,
    depot,
    make_problem,
    order,
    simple_trip,
    station,
    stop,
    trip,
    truck,
)

# ------------------------------------------------------------------ RM-10


def _late_trip(arrival_s: int):
    return trip(2, stops=[stop("S1", [("O1", SUPER, 5_000)], seq=1, arrival_s=arrival_s)])


def test_RM_10_arrivee_dans_les_horaires_de_reception_conforme():
    assert rules.rm_10_time_windows(make_problem(), [simple_trip()]) == []


def test_RM_10_arrivee_a_l_heure_de_fermeture_conforme():
    assert rules.rm_10_time_windows(make_problem(), [_late_trip(17 * H)]) == []


def test_RM_10_retard_dans_la_tolerance_avertissement():
    violations = rules.rm_10_time_windows(make_problem(), [_late_trip(17 * H + 10 * MIN)])
    assert len(violations) == 1
    v = violations[0]
    assert (v.rule_code, v.severity, v.trip_seq, v.stop_seq) == ("RM-10", Severity.WARNING, 2, 1)
    assert "AKWA" in v.message and "17:10" in v.message and "10 min" in v.message and "17:00" in v.message


def test_RM_10_retard_egal_a_la_tolerance_de_30_min_avertissement():
    violations = rules.rm_10_time_windows(make_problem(), [_late_trip(17 * H + 30 * MIN)])
    assert [v.severity for v in violations] == [Severity.WARNING]


def test_RM_10_retard_au_dela_de_la_tolerance_bloquant():
    violations = rules.rm_10_time_windows(make_problem(), [_late_trip(17 * H + 30 * MIN + 1)])
    assert [v.severity for v in violations] == [Severity.BLOCKING]
    assert "LT-001-AA" in violations[0].message


def test_RM_10_tolerance_lue_dans_les_parametres():
    problem = make_problem(params=Params(window_tolerance_min=5))
    violations = rules.rm_10_time_windows(problem, [_late_trip(17 * H + 10 * MIN)])
    assert [v.severity for v in violations] == [Severity.BLOCKING]
    assert rules.window_severity(0, problem.params) is None
    assert rules.window_severity(5 * MIN, problem.params) == Severity.WARNING


def test_RM_10_fenetre_de_la_commande_depassee():
    problem = make_problem(orders=[order("O1", "S1", SUPER, 5_000, window=(8 * H, 10 * H))])
    on_time = rules.rm_10_time_windows(problem, [_late_trip(10 * H)])
    warning = rules.rm_10_time_windows(problem, [_late_trip(10 * H + 20 * MIN)])
    blocking = rules.rm_10_time_windows(problem, [_late_trip(11 * H)])
    assert on_time == []
    assert [(v.severity, v.order_id) for v in warning] == [(Severity.WARNING, "O1")]
    assert "fenêtre de livraison" in warning[0].message and "10:00" in warning[0].message
    assert [(v.severity, v.order_id) for v in blocking] == [(Severity.BLOCKING, "O1")]


def test_RM_10_fenetre_de_commande_incompatible_avec_les_horaires_de_la_station_bloquant():
    problem = make_problem(orders=[order("O1", "S1", SUPER, 5_000, window=(18 * H, 19 * H))])
    violations = rules.rm_10_time_windows(problem, [_late_trip(9 * H)])
    assert [(v.severity, v.order_id) for v in violations] == [(Severity.BLOCKING, "O1")]
    assert "aucun créneau commun" in violations[0].message


def test_RM_10_station_fermee_ce_jour_bloquant():
    problem = make_problem(stations=[station("S1", windows=()), station("S2", "BONA")])
    violations = rules.rm_10_time_windows(problem, [_late_trip(9 * H)])
    assert [v.severity for v in violations] == [Severity.BLOCKING]
    assert "aucun horaire de réception" in violations[0].message


def test_RM_10_horaires_du_depot():
    problem = make_problem()  # dépôt ouvert de 06:00 à 18:00
    assert rules.rm_10_time_windows(problem, [trip(1, start_s=18 * H)]) == []
    warning = rules.rm_10_time_windows(problem, [trip(1, start_s=18 * H + 30 * MIN)])
    blocking = rules.rm_10_time_windows(problem, [trip(1, start_s=19 * H)])
    assert [(v.severity, v.stop_seq) for v in warning] == [(Severity.WARNING, None)]
    assert "dépôt DLA" in warning[0].message and "18:30" in warning[0].message
    assert [v.severity for v in blocking] == [Severity.BLOCKING]


def test_RM_10_depot_ferme_ce_jour_bloquant():
    problem = make_problem(depots=[depot(windows=())])
    violations = rules.rm_10_time_windows(problem, [trip(1)])
    assert [v.severity for v in violations] == [Severity.BLOCKING]
    assert "fermé" in violations[0].message


def test_RM_10_coherent_avec_le_calcul_des_horaires():
    """Une tournée planifiée par `schedule_trip` dans les fenêtres ne produit aucune violation ;
    la même, partie trop tard, est signalée."""
    problem = make_problem(trucks=[truck()])
    matrix = Matrix(
        node_ids=("D1", "S1", "S2"),
        distance_m=[[0, 10_000, 20_000], [10_000, 0, 12_000], [20_000, 12_000, 0]],
        duration_s=[[0, 1200, 2400], [1200, 0, 1500], [2400, 1500, 0]],
    )
    t = schedule_trip(simple_trip(), problem, matrix)
    assert rules.check_plan(problem, [t], [], matrix) == []
    late = schedule_trip(simple_trip(), problem, matrix, start_s=14 * H + 30 * MIN)
    assert "RM-10" in [v.rule_code for v in rules.check_plan(problem, [late], [], matrix)]


# ------------------------------------------------------------------ RM-11


def test_RM_11_duree_de_service_egale_au_maximum_conforme():
    t = trip(1, start_s=6 * H, depart_s=7 * H, return_s=18 * H)  # 11 h pile
    assert rules.rm_11_service_duration(make_problem(), [t]) == []


def test_RM_11_duree_de_service_d_une_tournee_depassee_bloquant():
    t = trip(3, start_s=6 * H, depart_s=7 * H, return_s=18 * H + 1)
    violations = rules.rm_11_service_duration(make_problem(), [t])
    assert len(violations) == 1
    v = violations[0]
    assert (v.rule_code, v.severity, v.trip_seq) == ("RM-11", Severity.BLOCKING, 3)
    assert "LT-001-AA" in v.message and "11 h 00" in v.message


def test_RM_11_attente_et_chargement_au_depot_hors_duree_de_service():
    # 13 h entre l'arrivée au dépôt et le retour, mais 10 h seulement depuis le départ du dépôt.
    t = trip(1, start_s=6 * H, depart_s=9 * H, return_s=19 * H)
    assert rules.rm_11_service_duration(make_problem(), [t]) == []


def test_RM_11_cumul_journalier_du_chauffeur_sur_plusieurs_tournees():
    problem = make_problem(trucks=[truck("T1"), truck("T2", "LT-002-BB")])
    first = trip(1, truck_id="T1", start_s=5 * H, depart_s=6 * H, return_s=12 * H)  # 6 h
    second = trip(2, truck_id="T2", start_s=12 * H, depart_s=13 * H, return_s=18 * H)  # 5 h
    assert rules.rm_11_service_duration(problem, [first, second]) == []  # 11 h pile

    second.return_s += 60
    violations = rules.rm_11_service_duration(problem, [first, second])
    assert len(violations) == 1
    v = violations[0]
    assert (v.rule_code, v.severity, v.trip_seq) == ("RM-11", Severity.BLOCKING, 2)
    assert "Jean Mbarga" in v.message and "11 h 01" in v.message and "1, 2" in v.message


def test_RM_11_duree_maximale_lue_dans_les_parametres():
    problem = make_problem(params=Params(max_service_hours=3.0))
    violations = rules.rm_11_service_duration(problem, [simple_trip()])  # 4 h de service
    assert len(violations) == 1 and "3 h 00" in violations[0].message
    assert rules.service_duration_exceeded(3 * H + 1, problem.params)
    assert not rules.service_duration_exceeded(3 * H, problem.params)
    assert GASOIL  # jeu de base inchangé
