"""Calcul des horaires d'une tournée (source unique moteur + édition manuelle)."""

from datetime import date

from app.core.enums import TruckSize
from app.planning.domain import (
    CompartmentD,
    DeliveryD,
    DepotD,
    Matrix,
    OrderD,
    Params,
    PlanningProblem,
    ProductD,
    StationD,
    StopD,
    TripD,
    TruckD,
)
from app.planning.timing import lateness_s, schedule_trip, stop_windows

H = 3600


def _problem() -> tuple[PlanningProblem, Matrix]:
    problem = PlanningProblem(
        day=date(2027, 1, 12),
        products=[ProductD("P1", "SUPER")],
        depots=[DepotD("D", "D", 4.05, 9.70, windows=((6 * H, 18 * H),), avg_wait_min=60)],
        stations=[
            StationD("S1", "S1", 4.06, 9.71, windows=((7 * H, 17 * H),), unload_time_min=30),
            StationD("S2", "S2", 4.07, 9.72, windows=((12 * H, 17 * H),), unload_time_min=30),
        ],
        trucks=[TruckD("T", "LT-1", TruckSize.MEDIUM, (CompartmentD("C1", 1, 10000),))],
        drivers=[],
        orders=[
            OrderD("O1", "S1", "P1", 5000),
            OrderD("O2", "S2", "P1", 4000, window=(13 * H, 14 * H)),
        ],
        params=Params(depot_loading_time_min=30, day_start_time="06:00"),
    )
    matrix = Matrix(
        node_ids=("D", "S1", "S2"),
        distance_m=[[0, 10_000, 20_000], [10_000, 0, 12_000], [20_000, 12_000, 0]],
        duration_s=[[0, 1200, 2400], [1200, 0, 1500], [2400, 1500, 0]],
    )
    return problem, matrix


def test_horaires_distances_et_attente_de_l_ouverture():
    problem, matrix = _problem()
    trip = TripD(
        seq=1,
        truck_id="T",
        depot_id="D",
        stops=[
            StopD(0, "S1", deliveries=[DeliveryD("O1", "P1", 5000)]),
            StopD(0, "S2", deliveries=[DeliveryD("O2", "P1", 4000)]),
        ],
    )
    schedule_trip(trip, problem, matrix)

    assert trip.start_s == 6 * H  # début de journée
    assert trip.depart_s == 6 * H + 60 * 60 + 30 * 60  # attente 60 min + chargement 30 min
    s1, s2 = trip.stops
    assert (s1.seq, s2.seq) == (1, 2)
    assert s1.arrival_s == trip.depart_s + 1200
    assert s1.departure_s == s1.arrival_s + 30 * 60
    # Arrivée brute à S2 vers 08:25 : on attend l'ouverture de la fenêtre de commande (13:00).
    assert stop_windows(problem, s2) == ((13 * H, 14 * H),)
    assert s2.arrival_s == 13 * H
    assert trip.return_s == s2.departure_s + 2400
    assert trip.distance_m == 10_000 + 12_000 + 20_000
    assert trip.duration_s == trip.return_s - trip.depart_s


def test_retard_mesure_par_rapport_a_la_fenetre():
    assert lateness_s(10 * H, ((7 * H, 17 * H),)) == 0
    assert lateness_s(17 * H + 600, ((7 * H, 17 * H),)) == 600
    assert lateness_s(6 * H, ((7 * H, 17 * H),)) == 0  # en avance : on attend, pas de retard
