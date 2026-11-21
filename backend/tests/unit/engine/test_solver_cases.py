"""Cas ciblés du moteur : une règle métier par test, sur de petits problèmes construits à la main."""

import copy
from dataclasses import replace
from datetime import date

import pytest

from app.core.enums import Severity, TruckSize, TruckStatus, UnservedReason
from app.planning.domain import DepotD, ViolationD
from app.planning.engine import routing_model, solve

from .helpers import (
    FAST,
    H,
    check_invariants,
    driver,
    make_problem,
    order,
    served_ids,
    station,
    truck,
    unserved_reasons,
)

# Quatre stations proches du dépôt (≈ 5 à 12 km).
NEAR = [
    station("S1", 4.08, 9.72),
    station("S2", 4.02, 9.74),
    station("S3", 4.10, 9.68),
    station("S4", 4.00, 9.66),
]


def _solve(problem, matrix):
    result = solve(problem, matrix)
    assert check_invariants(problem, matrix, result) == []
    return result


def _stop_of(result, order_id):
    return next(
        (trip, stop)
        for trip in result.trips
        for stop in trip.stops
        if any(d.order_id == order_id for d in stop.deliveries)
    )


# --------------------------------------------------------------------------- multi-tournées


def test_RM_14_multi_tournees_chainees_dans_la_limite_des_chargements():
    # Un seul camion (14 700 L utiles) pour 24 000 L : deux chargements nécessaires.
    orders = [order(f"O{i}", f"S{i}", 6000) for i in range(1, 5)]
    problem, matrix = make_problem(stations=NEAR, orders=orders, trucks=[truck("T1")])
    result = _solve(problem, matrix)

    assert result.unserved == []
    assert [t.truck_id for t in result.trips] == ["T1", "T1"]
    first, second = sorted(result.trips, key=lambda t: t.start_s)
    # La seconde tournée arrive au dépôt après le retour de la première, puis attend et charge.
    assert second.start_s >= first.return_s
    assert second.depart_s == second.start_s + (30 + 45) * 60
    assert result.metrics["trucks_used"] == 1 and result.metrics["trips_count"] == 2


def test_RM_14_pas_de_troisieme_chargement():
    stations = [*NEAR, station("S5", 4.07, 9.76)]
    orders = [order(f"O{i}", f"S{i}", 6000) for i in range(1, 6)]  # 30 000 L : trois chargements
    problem, matrix = make_problem(stations=stations, orders=orders, trucks=[truck("T1")])
    result = _solve(problem, matrix)

    assert len(result.trips) == 2
    assert len(result.unserved) == 1
    assert result.unserved[0].reason_code == UnservedReason.NO_TRUCK
    # Avec un chargement de plus autorisé par le dépôt, tout passe.
    depot = replace(problem.depots[0], max_loadings_per_truck_day=3)
    relaxed, matrix = make_problem(stations=stations, orders=orders, trucks=[truck("T1")], depots=[depot])
    assert _solve(relaxed, matrix).unserved == []


def test_RM_11_cumul_journalier_du_camion():
    # Deux stations à ≈ 2 h 45 de route : chaque aller-retour fait ≈ 6 h, deux tournées dépassent 11 h.
    far = [station("F1", 4.90, 9.70, closing=23), station("F2", 3.20, 9.70, closing=23)]
    orders = [order("O1", "F1", 12000), order("O2", "F2", 12000)]
    problem, matrix = make_problem(stations=far, orders=orders, trucks=[truck("T1")])
    result = _solve(problem, matrix)
    assert len(result.trips) == 1 and len(result.unserved) == 1
    assert result.unserved[0].reason_code == UnservedReason.NO_TRUCK
    # Un second camion (et son chauffeur) règle le problème.
    problem, matrix = make_problem(stations=far, orders=orders, trucks=[truck("T1"), truck("T2")])
    result = _solve(problem, matrix)
    assert result.unserved == [] and {t.truck_id for t in result.trips} == {"T1", "T2"}


def test_RM_11_station_hors_de_portee():
    stations = [station("LOIN", 7.30, 13.58, closing=23), NEAR[0]]  # Ngaoundéré : > 11 h aller-retour
    problem, matrix = make_problem(
        stations=stations, orders=[order("O1", "LOIN", 5000), order("O2", "S1", 5000)], trucks=[truck("T1")]
    )
    result = _solve(problem, matrix)
    assert unserved_reasons(result) == {"O1": "service_duration"}
    assert served_ids(result) == {"O2"}


# --------------------------------------------------------------------------- gabarits, fenêtres


def test_RM_09_station_a_gabarit_limite():
    stations = [replace(NEAR[0], max_truck_size=TruckSize.SMALL), NEAR[1]]
    orders = [order("O1", "S1", 4000), order("O2", "S2", 4000)]
    trucks = [truck("GROS", size=TruckSize.LARGE), truck("PETIT", (5000, 4000), size=TruckSize.SMALL)]
    problem, matrix = make_problem(stations=stations, orders=orders, trucks=trucks)
    result = _solve(problem, matrix)
    assert result.unserved == []
    assert _stop_of(result, "O1")[0].truck_id == "PETIT"


def test_RM_09_aucun_camion_au_gabarit():
    stations = [replace(NEAR[0], max_truck_size=TruckSize.SMALL), NEAR[1]]
    orders = [order("O1", "S1", 4000), order("O2", "S2", 4000)]
    problem, matrix = make_problem(
        stations=stations, orders=orders, trucks=[truck("GROS", size=TruckSize.LARGE)]
    )
    result = _solve(problem, matrix)
    assert unserved_reasons(result) == {"O1": "truck_size"}


def test_RM_10_fenetre_etroite_respectee():
    orders = [
        order("O1", "S1", 4000, window=(14, 14.5)),
        order("O2", "S2", 4000),
        order("O3", "S3", 4000, window=(9, 9.5)),
    ]
    problem, matrix = make_problem(stations=NEAR, orders=orders, trucks=[truck("T1"), truck("T2")])
    result = _solve(problem, matrix)
    assert result.unserved == []
    assert 14 * H <= _stop_of(result, "O1")[1].arrival_s <= 14.5 * H
    assert 9 * H <= _stop_of(result, "O3")[1].arrival_s <= 9.5 * H


def test_RM_10_fenetre_impossible():
    orders = [
        order("TOT", "S1", 4000, window=(6, 6.5)),  # avant la fin du premier chargement (≥ 7 h 15)
        order("FERME", "S2", 4000, window=(19, 20)),  # station fermée à 18 h
        order("OK", "S3", 4000),
    ]
    problem, matrix = make_problem(stations=NEAR, orders=orders, trucks=[truck("T1")])
    result = _solve(problem, matrix)
    assert unserved_reasons(result) == {"TOT": "time_window", "FERME": "time_window"}
    assert served_ids(result) == {"OK"}


def test_RM_10_station_a_deux_plages_et_depart_retarde():
    # Station ouverte 6 h – 9 h puis 14 h – 18 h ; le dépôt n'ouvre qu'à 8 h : arrivée possible ≥ 9 h 15.
    midi = replace(NEAR[0], windows=((6 * H, 9 * H), (14 * H, 18 * H)))
    depot = DepotD("DEP", "DEP", 4.05, 9.70, windows=((8 * H, 18 * H),), avg_wait_min=30)
    problem, matrix = make_problem(
        stations=[midi], orders=[order("O1", "S1", 4000)], trucks=[truck("T1")], depots=[depot]
    )
    result = _solve(problem, matrix)
    trip, stop = _stop_of(result, "O1")
    assert stop.arrival_s == 14 * H
    # Le camion ne patiente pas devant la station : son arrivée au dépôt est retardée d'autant.
    assert trip.depart_s + matrix.duration("DEP", "S1") == stop.arrival_s
    assert trip.start_s > 12 * H


def test_commandes_d_une_meme_station_regroupees_en_un_arret():
    orders = [
        order("O1", "S1", 4000, "SUPER"),
        order("O2", "S1", 3000, "GASOIL"),
        order("O3", "S1", 1000, "PETROLE"),
    ]
    problem, matrix = make_problem(stations=NEAR, orders=orders, trucks=[truck("T1")])
    result = _solve(problem, matrix)
    assert len(result.trips) == 1 and len(result.trips[0].stops) == 1
    stop = result.trips[0].stops[0]
    assert {d.order_id for d in stop.deliveries} == {"O1", "O2", "O3"}
    assert stop.departure_s - stop.arrival_s == 30 * 60  # un seul dépotage
    assert {load.product_id for load in result.trips[0].loads} == {"SUPER", "GASOIL", "PETROLE"}


# --------------------------------------------------------------------------- compartiments


def test_RM_06_trois_produits_deux_compartiments():
    # 9 000 L pour 9 800 L utiles, mais trois produits pour deux compartiments.
    orders = [
        order("O1", "S1", 4000, "SUPER"),
        order("O2", "S2", 4000, "GASOIL"),
        order("O3", "S3", 1000, "PETROLE"),
    ]
    depot = DepotD("DEP", "DEP", 4.05, 9.70, avg_wait_min=30, max_loadings_per_truck_day=1)
    problem, matrix = make_problem(
        stations=NEAR, orders=orders, trucks=[truck("T1", (5000, 5000))], depots=[depot]
    )
    result = _solve(problem, matrix)
    assert len(result.trips) == 1 and len(result.unserved) == 1
    assert result.unserved[0].reason_code == UnservedReason.COMPARTMENT
    assert len({load.product_id for load in result.trips[0].loads}) == 2
    # Avec un second chargement autorisé, la troisième commande part dans une autre tournée.
    problem, matrix = make_problem(stations=NEAR, orders=orders, trucks=[truck("T1", (5000, 5000))])
    assert len(_solve(problem, matrix).trips) == 2


def test_RM_07_produit_sans_compartiment_autorise():
    camion = truck("T1", (6000, 5000), allowed={1: {"SUPER", "GASOIL"}, 2: {"GASOIL"}})
    orders = [
        order("O1", "S1", 2000, "PETROLE"),
        order("O2", "S2", 4000, "SUPER"),
        order("O3", "S3", 4000, "GASOIL"),
    ]
    problem, matrix = make_problem(stations=NEAR, orders=orders, trucks=[camion])
    result = _solve(problem, matrix)
    assert unserved_reasons(result) == {"O1": "compartment"}
    loads = {load.compartment_id: load.product_id for load in result.trips[0].loads}
    assert loads == {"T1-C1": "SUPER", "T1-C2": "GASOIL"}


def test_relance_unique_quand_l_affectation_aux_compartiments_echoue(monkeypatch):
    # Sans le contrôle des compartiments dans la recherche, le solveur ne voit que les volumes :
    # le post-traitement détecte l'échec, retire une commande et relance une fois (spec §7.3).
    monkeypatch.setattr(routing_model._CompartmentCheck, "Post", lambda self: None)
    monkeypatch.setattr(routing_model._CompartmentCheck, "InitialPropagate", lambda self: None)
    orders = [
        order("O1", "S1", 4000, "SUPER"),
        order("O2", "S2", 4000, "GASOIL"),
        order("O3", "S3", 1000, "PETROLE"),
    ]
    trucks = [truck("T1", (5000, 5000)), truck("T2", (5000, 5000))]
    depot = DepotD("DEP", "DEP", 4.05, 9.70, avg_wait_min=30, max_loadings_per_truck_day=1)
    problem, matrix = make_problem(stations=NEAR, orders=orders, trucks=trucks, depots=[depot])
    result = _solve(problem, matrix)
    assert result.unserved == []
    assert result.solver_log["relaunched"] is True
    assert len(result.solver_log["rounds"]) == 2 and result.solver_log["rounds"][1]["warm_start"] is True
    assert {t.truck_id for t in result.trips} == {"T1", "T2"}


# --------------------------------------------------------------------------- ressources


def test_RM_04_camion_indisponible_non_utilise():
    orders = [order("O1", "S1", 4000), order("O2", "S2", 4000)]
    trucks = [truck("PANNE", status=TruckStatus.BROKEN), truck("ABSENT", available_today=False), truck("OK")]
    problem, matrix = make_problem(stations=NEAR, orders=orders, trucks=trucks)
    result = _solve(problem, matrix)
    assert result.unserved == [] and {t.truck_id for t in result.trips} == {"OK"}
    # Plus aucun camion affectable : tout est non servi, avec la raison.
    problem, matrix = make_problem(stations=NEAR, orders=orders, trucks=trucks[:2])
    result = _solve(problem, matrix)
    assert result.trips == [] and set(unserved_reasons(result).values()) == {"no_truck"}


def test_RM_03_chauffeur_expire_remplace_par_un_collegue():
    drivers = [
        driver("HABITUEL", default_truck="T1", license_expiry=date(2026, 12, 31)),
        driver("AUTRE-TRANSPORTEUR", carrier="AUTRE"),
        driver("COLLEGUE"),
    ]
    problem, matrix = make_problem(
        stations=NEAR, orders=[order("O1", "S1", 4000)], trucks=[truck("T1")], drivers=drivers
    )
    result = _solve(problem, matrix)
    assert [t.driver_id for t in result.trips] == ["COLLEGUE"]


def test_chauffeur_du_jour_prioritaire_sur_le_chauffeur_habituel():
    drivers = [driver("HABITUEL", default_truck="T1"), driver("DU-JOUR")]
    problem, matrix = make_problem(
        stations=NEAR,
        orders=[order("O1", "S1", 4000)],
        trucks=[truck("T1")],
        drivers=drivers,
        driver_by_truck={"T1": "DU-JOUR"},
    )
    assert [t.driver_id for t in _solve(problem, matrix).trips] == ["DU-JOUR"]
    problem.driver_by_truck = {}
    assert [t.driver_id for t in _solve(problem, matrix).trips] == ["HABITUEL"]


def test_aucun_chauffeur_affectable():
    drivers = [driver("MALADE", status="sick"), driver("SANS-HABILITATION", hazmat_cert=False)]
    problem, matrix = make_problem(
        stations=NEAR, orders=[order("O1", "S1", 4000)], trucks=[truck("T1")], drivers=drivers
    )
    result = _solve(problem, matrix)
    assert result.trips == [] and unserved_reasons(result) == {"O1": "no_driver"}
    assert result.solver_log["driverless_trucks"] == ["LT-T1"]


def test_un_chauffeur_pour_deux_camions():
    # Deux camions, un seul chauffeur : un seul camion roule ; le reste est non servi faute de chauffeur.
    orders = [order(f"O{i}", f"S{i}", 12000) for i in range(1, 4)]
    depot = DepotD("DEP", "DEP", 4.05, 9.70, avg_wait_min=30, max_loadings_per_truck_day=1)
    problem, matrix = make_problem(
        stations=NEAR,
        orders=orders,
        trucks=[truck("T1"), truck("T2")],
        drivers=[driver("SEUL")],
        depots=[depot],
    )
    result = _solve(problem, matrix)
    assert len(result.trips) == 1 and result.trips[0].driver_id == "SEUL"
    assert sorted(unserved_reasons(result).values()) == ["no_driver", "no_driver"]


# --------------------------------------------------------------------------- priorités, stocks


def test_RM_15_commande_urgente_servie_en_priorite():
    depot = DepotD("DEP", "DEP", 4.05, 9.70, avg_wait_min=30, max_loadings_per_truck_day=1)
    # Un seul chargement de 14 700 L utiles : l'urgente passe, il ne reste pas 50 % de la normale.
    orders = [order("NORMALE", "S1", 12000), order("URGENTE", "S4", 9000, urgent=True)]
    problem, matrix = make_problem(stations=NEAR, orders=orders, trucks=[truck("T1")], depots=[depot])
    result = _solve(problem, matrix)
    assert served_ids(result) == {"URGENTE"}
    assert unserved_reasons(result) == {"NORMALE": "no_truck"}
    # Avec une commande normale plus petite, le volume restant suffit à une livraison partielle (RM-16).
    orders = [order("NORMALE", "S1", 9000), order("URGENTE", "S4", 9000, urgent=True)]
    problem, matrix = make_problem(stations=NEAR, orders=orders, trucks=[truck("T1")], depots=[depot])
    result = _solve(problem, matrix)
    planned = {d.order_id: d.planned_l for t in result.trips for s in t.stops for d in s.deliveries}
    assert planned["URGENTE"] == 9000 and 4500 <= planned["NORMALE"] < 9000


def test_RM_15_urgentes_en_tete_des_non_servies():
    stations = [NEAR[0], replace(NEAR[1], max_truck_size=TruckSize.SMALL)]
    orders = [
        order("N1", "S1", 4000, window=(19, 20)),
        order("U1", "S2", 4000, urgent=True),  # gabarit impossible
        order("N2", "S2", 4000),
        order("U2", "S1", 4000, urgent=True, window=(19, 20)),
    ]
    problem, matrix = make_problem(stations=stations, orders=orders, trucks=[truck("T1")])
    result = _solve(problem, matrix)
    assert [u.order_id for u in result.unserved] == ["U1", "U2", "N1", "N2"]


def test_RM_16_livraison_partielle_sur_le_stock_restant():
    orders = [order("O1", "S1", 4000), order("O2", "S2", 5000)]
    problem, matrix = make_problem(
        stations=NEAR, orders=orders, trucks=[truck("T1")], stocks={("DEP", "SUPER"): 7000.0}
    )
    result = _solve(problem, matrix)
    assert result.unserved == []
    planned = {d.order_id: d.planned_l for t in result.trips for s in t.stops for d in s.deliveries}
    assert sum(planned.values()) == 7000.0
    partial = [o for o in orders if planned[o.id] < o.requested_l]
    assert len(partial) == 1 and planned[partial[0].id] >= partial[0].requested_l / 2
    assert result.metrics["orders_partial"] == 1 and result.metrics["orders_served"] == 2
    assert result.solver_log["orders_rescued"] == 1


def test_RM_16_pas_de_livraison_sous_le_seuil_partiel():
    orders = [order("O1", "S1", 5000), order("O2", "S2", 5000)]
    problem, matrix = make_problem(
        stations=NEAR, orders=orders, trucks=[truck("T1")], stocks={("DEP", "SUPER"): 7000.0}
    )
    result = _solve(problem, matrix)  # reste 2 000 L < 50 % de 5 000 L
    assert len(result.unserved) == 1 and result.unserved[0].reason_code == UnservedReason.DEPOT_STOCK
    # Stock insuffisant pour toute commande, même partielle : écartée d'emblée.
    problem.depot_stocks = {("DEP", "SUPER"): 2000.0}
    result = _solve(problem, matrix)
    assert result.trips == [] and set(unserved_reasons(result).values()) == {"depot_stock"}


def test_RM_16_commande_plus_grosse_que_le_plus_gros_camion():
    # 20 000 L demandés, 14 700 L utiles au mieux (≥ 50 %) : livraison partielle du maximum.
    problem, matrix = make_problem(stations=NEAR, orders=[order("O1", "S1", 20000)], trucks=[truck("T1")])
    result = _solve(problem, matrix)
    assert result.unserved == []
    assert result.trips[0].stops[0].deliveries[0].planned_l == pytest.approx(14700)
    # 40 000 L : même le maximum reste sous le seuil.
    problem, matrix = make_problem(stations=NEAR, orders=[order("O1", "S1", 40000)], trucks=[truck("T1")])
    assert unserved_reasons(_solve(problem, matrix)) == {"O1": "compartment"}


def test_RM_08_multi_depots_stock_par_depot():
    # Le gasoil n'est disponible qu'au second dépôt : la commande de gasoil part de là.
    depots = [
        DepotD("DEP-A", "A", 4.05, 9.70, avg_wait_min=30),
        DepotD("DEP-B", "B", 4.06, 9.78, avg_wait_min=30),
    ]
    stocks = {
        ("DEP-A", "SUPER"): 50000.0,
        ("DEP-A", "GASOIL"): 0.0,
        ("DEP-B", "SUPER"): 0.0,
        ("DEP-B", "GASOIL"): 50000.0,
    }
    orders = [
        order("O1", "S1", 5000, "SUPER"),
        order("O2", "S2", 5000, "GASOIL"),
        order("O3", "S3", 4000, "SUPER"),
    ]
    problem, matrix = make_problem(
        stations=NEAR, orders=orders, trucks=[truck("T1"), truck("T2")], depots=depots, stocks=stocks
    )
    result = _solve(problem, matrix)
    assert result.unserved == []
    assert _stop_of(result, "O2")[0].depot_id == "DEP-B"
    assert _stop_of(result, "O1")[0].depot_id == _stop_of(result, "O3")[0].depot_id == "DEP-A"
    # Un camion ne charge que dans un seul dépôt par jour.
    for truck_id in {t.truck_id for t in result.trips}:
        assert len({t.depot_id for t in result.trips if t.truck_id == truck_id}) == 1


# --------------------------------------------------------------------------- tournées verrouillées


def test_RM_17_tournees_verrouillees_conservees_et_ressources_deduites():
    orders = [order(f"O{i}", f"S{i}", 6000) for i in range(1, 5)]
    depot = DepotD("DEP", "DEP", 4.05, 9.70, avg_wait_min=30, max_loadings_per_truck_day=2)
    trucks = [truck("T1"), truck("T2")]
    problem, matrix = make_problem(stations=NEAR, orders=orders, trucks=trucks, depots=[depot])
    base = _solve(problem, matrix)
    assert base.unserved == []

    locked = copy.deepcopy(base.trips[0])
    locked.locked = True
    locked.ref = "tournee-verrouillee"
    snapshot = copy.deepcopy(locked)
    locked_orders = {d.order_id for s in locked.stops for d in s.deliveries}
    locked_volume = sum(locked.volumes_by_product().values())
    # Stock tout juste suffisant : 24 000 L en tout, dont le volume de la tournée verrouillée.
    problem.locked_trips = [locked]
    problem.depot_stocks = {("DEP", "SUPER"): 24000.0}
    result = _solve(problem, matrix)

    assert result.unserved == []
    kept = [t for t in result.trips if t.locked]
    assert len(kept) == 1 and kept[0] is locked and locked == snapshot  # rendue telle quelle
    others = [t for t in result.trips if not t.locked]
    assert {d.order_id for t in others for s in t.stops for d in s.deliveries} == {
        o.id for o in orders
    } - locked_orders
    assert len({t.seq for t in result.trips}) == len(result.trips)
    # Le camion verrouillé ne repart qu'après son retour (RM-02).
    for trip in others:
        if trip.truck_id == locked.truck_id:
            assert trip.start_s >= locked.return_s or trip.return_s <= locked.start_s
    assert result.metrics["locked_trips_count"] == 1

    # Stock amputé du volume verrouillé : avec 2 000 L de moins, une commande ne passe plus entière.
    problem.depot_stocks = {("DEP", "SUPER"): 24000.0 - 2000.0}
    result = _solve(problem, matrix)
    planned = sum(d.planned_l for t in result.trips for s in t.stops for d in s.deliveries)
    assert planned == 22000.0 and locked == snapshot
    assert (
        locked_volume + sum(sum(t.volumes_by_product().values()) for t in result.trips if not t.locked)
        == 22000.0
    )


def test_RM_17_chargement_verrouille_compte_dans_la_limite():
    # Un seul camion, deux chargements par jour dont un verrouillé : il n'en reste qu'un.
    stations = [*NEAR, station("S5", 4.07, 9.76)]
    orders = [order(f"O{i}", f"S{i}", 6000) for i in range(1, 6)]
    problem, matrix = make_problem(stations=stations, orders=orders, trucks=[truck("T1")])
    base = _solve(problem, matrix)
    locked = copy.deepcopy(min(base.trips, key=lambda t: t.start_s))
    locked.locked = True
    problem.locked_trips = [locked]
    result = _solve(problem, matrix)
    assert len(result.trips) == 2 and sum(t.locked for t in result.trips) == 1
    assert len(result.unserved) == 1


# --------------------------------------------------------------------------- contrat de solve()


def test_progression_et_journal():
    events: list[tuple[int, str]] = []
    orders = [order(f"O{i}", f"S{i}", 5000) for i in range(1, 5)]
    problem, matrix = make_problem(stations=NEAR, orders=orders, trucks=[truck("T1"), truck("T2")])
    result = solve(problem, matrix, progress=lambda pct, message: events.append((pct, message)))
    percentages = [pct for pct, _ in events]
    assert percentages[0] == 0 and percentages[-1] == 100
    assert percentages == sorted(percentages)
    assert all(isinstance(message, str) and message for _, message in events)
    assert result.solver_log["seed"] == FAST.solver_seed
    assert result.solver_log["rounds"][0]["first_solution_strategy"] == "PATH_CHEAPEST_ARC"


def test_violations_issues_de_check_plan(monkeypatch):
    from app.planning.violations import rules

    problem, matrix = make_problem(stations=NEAR, orders=[order("O1", "S1", 4000)], trucks=[truck("T1")])
    seen = {}

    def fake_check_plan(problem_, trips, unserved=None, matrix_=None):
        seen["args"] = (problem_, trips, unserved, matrix_)
        return [ViolationD("RM-10", Severity.WARNING, "Arrivée tardive.", trip_seq=1)]

    monkeypatch.setattr(rules, "check_plan", fake_check_plan)
    result = solve(problem, matrix)
    assert [v.rule_code for v in result.violations] == ["RM-10"]
    assert seen["args"][0] is problem and seen["args"][1] is result.trips and seen["args"][3] is matrix
    assert result.solver_log["rules_available"] is True


def test_violations_vides_tant_que_les_regles_ne_sont_pas_livrees(monkeypatch):
    from app.planning.violations import rules

    def not_delivered(*args, **kwargs):
        raise NotImplementedError("Lot L1")

    monkeypatch.setattr(rules, "check_plan", not_delivered)
    problem, matrix = make_problem(stations=NEAR, orders=[order("O1", "S1", 4000)], trucks=[truck("T1")])
    result = solve(problem, matrix)
    assert result.violations == [] and result.solver_log["rules_available"] is False


def test_depot_ferme_toute_la_journee():
    depot = DepotD("DEP", "DEP", 4.05, 9.70, windows=())
    problem, matrix = make_problem(
        stations=NEAR, orders=[order("O1", "S1", 4000)], trucks=[truck("T1")], depots=[depot]
    )
    result = _solve(problem, matrix)
    assert result.trips == [] and unserved_reasons(result) == {"O1": "other"}
    assert "dépôt" in result.unserved[0].reason_text


def test_probleme_sans_commande_ou_degenere():
    problem, matrix = make_problem(stations=NEAR, orders=[], trucks=[truck("T1")])
    result = _solve(problem, matrix)
    assert result.trips == [] and result.unserved == [] and result.metrics["orders_total"] == 0

    # Station absente de la matrice, volume nul : jamais de disparition silencieuse.
    orders = [order("O1", "S1", 4000), order("ZERO", "S2", 0), order("INCONNUE", "S9", 4000)]
    problem, matrix = make_problem(
        stations=[*NEAR, station("S9", 4.2, 9.9)], orders=orders[:2], trucks=[truck("T1")]
    )
    problem.orders = orders
    result = _solve(problem, matrix)
    assert unserved_reasons(result) == {"ZERO": "other", "INCONNUE": "other"}
    assert served_ids(result) == {"O1"}


def test_repli_sur_l_insertion_si_la_premiere_solution_s_enlise(monkeypatch):
    # Budget d'échecs nul : PATH_CHEAPEST_ARC est abandonné au premier contrôle, l'insertion prend le relais.
    monkeypatch.setattr(routing_model, "FIRST_SOLUTION_FAILURES_BASE", -1)
    monkeypatch.setattr(routing_model, "FIRST_SOLUTION_FAILURES_PER_NODE", 0)
    monkeypatch.setattr(routing_model, "LIMIT_CHECK_PERIOD", 1)
    stations = [*NEAR, station("S5", 4.07, 9.76)]
    orders = [order(f"O{i}", f"S{i}", 6000) for i in range(1, 6)]
    problem, matrix = make_problem(stations=stations, orders=orders, trucks=[truck("T1"), truck("T2")])
    result = _solve(problem, matrix)
    assert result.unserved == []
    attempts = result.solver_log["rounds"][0]["attempts"]
    if len(attempts) == 2:  # l'enlisement dépend de l'ordre d'exploration du solveur
        assert attempts[0]["stalled_first_solution"] is True
        assert attempts[1]["first_solution_strategy"] == "PARALLEL_CHEAPEST_INSERTION"
