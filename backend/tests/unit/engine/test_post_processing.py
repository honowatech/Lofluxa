"""Post-traitement du moteur, testé directement : arrêts, horaires, chauffeurs, repêchage."""

import copy

from app.core.enums import UnservedReason
from app.planning.domain import CompartmentLoadD, DeliveryD, StopD, TripD
from app.planning.engine import objective
from app.planning.engine.context import build_context, classify_orders
from app.planning.engine.drivers import assign_drivers, drivable_truck_ids, eligible_drivers
from app.planning.engine.plan_builder import build_plan, make_stops
from app.planning.engine.rescue import deliverable_l, rescue
from app.planning.engine.routing_model import Route, build_slots, solve_routing
from app.planning.engine.scheduling import schedule_packed, schedule_truck_day, trip_issue

from .helpers import FAST, H, driver, make_problem, order, station, truck

NEAR = [station("S1", 4.08, 9.72), station("S2", 4.02, 9.74), station("S3", 4.10, 9.68)]


def _context(**kwargs):
    problem, matrix = make_problem(**kwargs)
    ctx = build_context(problem, matrix)
    candidates, rejected = classify_orders(ctx)
    return ctx, {c.order.id: c for c in candidates}, rejected


def _trip(truck_id, order_ids, by_id, ctx, **kwargs):
    trip = TripD(seq=0, truck_id=truck_id, depot_id="DEP", **kwargs)
    trip.stops = make_stops(ctx, [by_id[o] for o in order_ids])
    return trip


def test_horaires_tasses_sans_attente_devant_la_station():
    # La station n'ouvre qu'à 10 h : le camion arrive au dépôt plus tard plutôt que d'attendre sur place.
    late = station("S1", 4.08, 9.72, opening=10)
    ctx, by_id, _ = _context(stations=[late, NEAR[1]], orders=[order("O1", "S1", 4000)], trucks=[truck("T1")])
    trip = schedule_packed(ctx, _trip("T1", ["O1"], by_id, ctx), ctx.params.day_start_s)
    assert trip.stops[0].arrival_s == 10 * H
    assert trip.depart_s + ctx.matrix.duration("DEP", "S1") == 10 * H
    assert trip.start_s == trip.depart_s - 75 * 60
    assert trip_issue(ctx, trip) is None


def test_controle_d_une_tournee_apres_recalcul():
    orders = [order("O1", "S1", 4000, window=(9, 9.5)), order("O2", "S2", 4000, window=(7.5, 8))]
    ctx, by_id, _ = _context(stations=NEAR, orders=orders, trucks=[truck("T1")])
    # O1 puis O2 : la fenêtre de O2 est déjà fermée quand le camion y arrive.
    report = build_plan(ctx, by_id, [Route("T1", "DEP", 0, ["O1", "O2"])])
    assert [(r.order_id, r.reason) for r in report.removals] == [("O2", UnservedReason.TIME_WINDOW)]
    assert [d.order_id for t in report.plan.trips() for s in t.stops for d in s.deliveries] == ["O1"]
    assert not report.excluded and not report.slot_caps


def test_duree_de_service_recontrolee_apres_recalcul():
    far = [station("F1", 4.90, 9.70, closing=23), station("F2", 3.20, 9.70, closing=23)]
    orders = [order("O1", "F1", 5000), order("O2", "F2", 5000, urgent=True)]
    ctx, by_id, _ = _context(stations=far, orders=orders, trucks=[truck("T1")])
    report = build_plan(ctx, by_id, [Route("T1", "DEP", 0, ["O1", "O2"])])
    # La commande normale est retirée avant l'urgente (RM-15).
    assert [(r.order_id, r.reason) for r in report.removals] == [("O1", UnservedReason.SERVICE_DURATION)]
    trip = report.plan.trips()[0]
    assert trip.return_s - trip.depart_s <= ctx.params.max_service_s and trip.driver_id is not None


def test_compartiments_recontroles_et_exclusion_pour_la_relance():
    orders = [
        order("O1", "S1", 4000, "SUPER"),
        order("O2", "S2", 4000, "GASOIL"),
        order("O3", "S3", 1000, "PETROLE"),
    ]
    ctx, by_id, _ = _context(stations=NEAR, orders=orders, trucks=[truck("T1", (5000, 5000))])
    report = build_plan(ctx, by_id, [Route("T1", "DEP", 0, ["O1", "O2", "O3"])])
    assert [(r.order_id, r.reason) for r in report.removals] == [("O3", UnservedReason.COMPARTMENT)]
    assert report.excluded == {("O3", "T1")}


def test_tournee_sans_chauffeur_retiree_et_camion_plafonne():
    orders = [order("O1", "S1", 4000), order("O2", "S2", 4000)]
    ctx, by_id, _ = _context(
        stations=NEAR, orders=orders, trucks=[truck("T1"), truck("T2")], drivers=[driver("SEUL")]
    )
    assert [t.id for t in ctx.usable_trucks] == ["T1"] and [t.id for t in ctx.driverless_trucks] == ["T2"]
    # Deux tournées simultanées pour un seul chauffeur : la seconde est retirée, jamais rendue sans chauffeur.
    report = build_plan(ctx, by_id, [Route("T1", "DEP", 0, ["O1"]), Route("T2", "DEP", 0, ["O2"])])
    assert [t.truck_id for t in report.plan.trips()] == ["T1"]
    assert [(r.order_id, r.reason) for r in report.removals] == [("O2", UnservedReason.NO_DRIVER)]
    assert report.slot_caps == {"T2": 0}
    # La relance tient compte du plafond : plus aucun véhicule pour T2.
    assert {s.truck.id for s in build_slots(ctx, report.slot_caps)} == {"T1"}


def test_affectation_des_chauffeurs_RM_02_RM_11():
    problem, _ = make_problem(
        stations=NEAR,
        orders=[],
        trucks=[truck("T1"), truck("T2")],
        drivers=[driver("A", default_truck="T1"), driver("B"), driver("EXTERNE", carrier="AUTRE")],
    )
    assert [d.id for d in eligible_drivers(problem)] == ["A", "B", "EXTERNE"]
    assert drivable_truck_ids(problem, problem.trucks) == {"T1", "T2"}

    def trip(seq, truck_id, start_h, end_h):
        return TripD(seq, truck_id, "DEP", start_s=start_h * H, depart_s=start_h * H, return_s=end_h * H)

    # RM-02 : A conduit T1 ; la tournée simultanée de T2 revient à B ; la suivante de T1 reste à A.
    trips = [trip(1, "T1", 6, 10), trip(2, "T2", 7, 11), trip(3, "T1", 10, 14)]
    assert assign_drivers(problem, trips) == []
    assert [t.driver_id for t in trips] == ["A", "B", "A"]
    # RM-11 : au-delà de 11 h cumulées, la tournée suivante passe à un collègue du même transporteur.
    trips = [trip(1, "T1", 6, 13), trip(2, "T1", 13, 19)]
    assert assign_drivers(problem, trips) == []
    assert [t.driver_id for t in trips] == ["A", "B"]
    # Chauffeur déjà pris par une tournée verrouillée : indisponible sur ce créneau.
    locked = trip(9, "T2", 6, 12)
    locked.driver_id = "A"
    trips = [trip(1, "T1", 8, 11), trip(2, "T2", 8, 11)]
    orphans = assign_drivers(problem, trips, [locked])
    assert [t.driver_id for t in trips] == ["B", None] and orphans == [trips[1]]


def test_tournee_verrouillee_definie_par_son_chargement_et_camion_occupe():
    locked = TripD(
        seq=1,
        truck_id="T1",
        depot_id="DEP",
        driver_id="DRV-T1",
        start_s=6 * H,
        depart_s=7 * H + 900,
        return_s=11 * H,
        locked=True,
        loads=[CompartmentLoadD("T1-C1", "SUPER", 5000.0)],
    )
    ctx, by_id, _ = _context(
        stations=NEAR,
        orders=[order("O1", "S1", 4000)],
        trucks=[truck("T1")],
        stocks={("DEP", "SUPER"): 12000.0},
        locked_trips=[locked],
    )
    assert ctx.stock[("DEP", "SUPER")] == 7000.0  # volume verrouillé déduit (RM-17)
    assert ctx.free_loadings("T1", "DEP") == 1 and ctx.locked_duration_s("T1") == 3 * H + 2700
    # La nouvelle tournée du même camion ne chevauche pas la tournée verrouillée (RM-02).
    new_trip = _trip("T1", ["O1"], by_id, ctx)
    assert schedule_truck_day(ctx, [new_trip]) == []
    assert new_trip.start_s >= locked.return_s


def test_volume_livrable_partiel_selon_les_compartiments_libres():
    ctx, by_id, _ = _context(
        stations=NEAR,
        orders=[order("O1", "S1", 8000)],
        trucks=[truck("T1", (5000, 5000)), truck("T2", (9000,))],
    )
    cand, small = by_id["O1"], ctx.trucks["T1"]
    assert deliverable_l(ctx, small, "DEP", {}, cand) == 8000  # camion vide : tout passe
    # Un compartiment déjà pris par du gasoil : au mieux 4 900 L de super (≥ 50 % de 8 000 L).
    assert deliverable_l(ctx, small, "DEP", {"GASOIL": 4000.0}, cand) == 4900
    # Les deux compartiments pris : rien.
    assert deliverable_l(ctx, small, "DEP", {"GASOIL": 4000.0, "PETROLE": 1000.0}, cand) == 0
    ctx.stock[("DEP", "SUPER")] = 3000.0  # stock restant sous le seuil partiel
    assert deliverable_l(ctx, small, "DEP", {}, cand) == 0


def test_repechage_insertion_dans_une_tournee_ou_nouvelle_tournee():
    orders = [
        order("O1", "S1", 4000),
        order("O2", "S1", 3000, "GASOIL"),
        order("O3", "S2", 4000),
        order("O4", "S3", 9000),
    ]
    ctx, by_id, _ = _context(stations=NEAR, orders=orders, trucks=[truck("T1"), truck("T2")])
    report = build_plan(ctx, by_id, [Route("T1", "DEP", 0, ["O1"])])
    plan = report.plan
    before = copy.deepcopy(plan.trips()[0])
    left = rescue(ctx, plan, [by_id["O2"], by_id["O3"], by_id["O4"]])
    assert left == []
    trips = plan.trips()
    # O2 rejoint l'arrêt existant de la même station (surcoût nul) : un seul arrêt à S1.
    shared = [s for t in trips for s in t.stops if s.station_id == "S1"]
    assert len(shared) == 1 and {d.order_id for d in shared[0].deliveries} == {"O1", "O2"}
    assert before.truck_id in {t.truck_id for t in trips}
    assert {d.order_id for t in trips for s in t.stops for d in s.deliveries} == {"O1", "O2", "O3", "O4"}
    assert all(t.driver_id is not None for t in trips)
    for trip in trips:
        assert ctx.fits(ctx.trucks[trip.truck_id], trip.volumes_by_product())


def test_solveur_sans_commande_ni_vehicule():
    ctx, by_id, _ = _context(stations=NEAR, orders=[order("O1", "S1", 4000)], trucks=[truck("T1")])
    assert solve_routing(ctx, [], time_limit_s=1).routes == []
    ctx.usable_trucks.clear()
    outcome = solve_routing(ctx, list(by_id.values()), time_limit_s=1)
    assert outcome.routes == [] and outcome.dropped == ["O1"]


def test_objectif_ponderations_lues_dans_les_parametres():
    from dataclasses import replace

    params = replace(
        FAST,
        objective_distance_weight=2.0,
        objective_vehicle_fixed_cost_km=40.0,
        objective_unserved_penalty_normal_km=500.0,
        objective_unserved_penalty_urgent_km=5000.0,
    )
    normal, urgent = order("N", "S1", 1000), order("U", "S1", 1000, urgent=True)
    assert objective.arc_cost(1500, params) == 3000
    assert objective.vehicle_fixed_cost(params) == 40_000
    assert objective.unserved_penalty(normal, params) == 500_000
    assert objective.unserved_penalty(urgent, params) == 5_000_000
    used = TripD(
        1, "T", "D", distance_m=10_000, stops=[StopD(1, "S1", deliveries=[DeliveryD("X", "SUPER", 1.0)])]
    )
    empty = TripD(2, "T", "D", distance_m=0)
    assert objective.objective_km([used, empty], [normal, urgent], params) == 20 + 40 + 500 + 5000
