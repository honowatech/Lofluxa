"""RM-14 (chargements par jour), RM-15 (urgentes), RM-16 (volumes), RM-17 (verrouillage), check_plan."""

from app.core.enums import Severity, UnservedReason
from app.planning.domain import Params, UnservedD
from app.planning.violations import rules

from .builders import (
    GASOIL,
    SUPER,
    H,
    codes,
    depot,
    driver,
    make_problem,
    order,
    simple_trip,
    stop,
    trip,
    truck,
)

# ------------------------------------------------------------------ RM-14


def _three_trips(depot_ids=("D1", "D1", "D1")):
    return [
        trip(
            seq,
            depot_id=depot_id,
            start_s=(5 + 4 * i) * H,
            depart_s=(6 + 4 * i) * H,
            return_s=(9 + 4 * i) * H,
        )
        for i, (seq, depot_id) in enumerate(zip((1, 2, 3), depot_ids, strict=True))
    ]


def test_RM_14_nombre_de_chargements_egal_au_maximum_conforme():
    assert rules.rm_14_max_loadings(make_problem(), _three_trips()[:2]) == []


def test_RM_14_troisieme_chargement_du_meme_camion_bloquant():
    violations = rules.rm_14_max_loadings(make_problem(), _three_trips())
    assert len(violations) == 1
    v = violations[0]
    assert (v.rule_code, v.severity, v.trip_seq) == ("RM-14", Severity.BLOCKING, 3)
    assert "LT-001-AA" in v.message and "3 chargements" in v.message and "DLA" in v.message
    assert "maximum 2" in v.message


def test_RM_14_maximum_propre_au_depot_prioritaire_sur_le_parametre():
    generous = make_problem(depots=[depot(max_loadings_per_truck_day=3)])
    assert rules.rm_14_max_loadings(generous, _three_trips()) == []
    strict = make_problem(depots=[depot(max_loadings_per_truck_day=1)])
    assert [v.trip_seq for v in rules.rm_14_max_loadings(strict, _three_trips()[:2])] == [2]
    by_param = make_problem(params=Params(default_max_loadings_per_truck_day=3))
    assert rules.rm_14_max_loadings(by_param, _three_trips()) == []


def test_RM_14_chargements_comptes_par_depot_et_par_camion():
    problem = make_problem(
        depots=[depot("D1", "DLA"), depot("D2", "LIM")], trucks=[truck("T1"), truck("T2", "LT-002-BB")]
    )
    assert rules.rm_14_max_loadings(problem, _three_trips(("D1", "D1", "D2"))) == []
    trips = _three_trips()
    trips[2].truck_id = "T2"
    assert rules.rm_14_max_loadings(problem, trips) == []


# ------------------------------------------------------------------ RM-15


def _urgent_problem():
    return make_problem(
        orders=[
            order("O1", "S1", SUPER, 5_000),
            order("O2", "S2", GASOIL, 4_000),
            order("O3", "S2", SUPER, 6_000, urgent=True),
        ]
    )


def test_RM_15_commande_urgente_servie_conforme():
    t = simple_trip()
    t.stops[1].deliveries.append(rules_delivery("O3", SUPER, 6_000))
    unserved = [UnservedD("O1", UnservedReason.NO_TRUCK)]  # une commande normale non servie ne bloque pas
    assert rules.rm_15_urgent_orders(_urgent_problem(), [t], unserved) == []


def rules_delivery(order_id, product_id, volume):
    from app.planning.domain import DeliveryD

    return DeliveryD(order_id, product_id, volume)


def test_RM_15_commande_urgente_non_servie_bloquante():
    unserved = [UnservedD("O3", UnservedReason.DEPOT_STOCK, "Stock dépôt insuffisant.")]
    violations = rules.rm_15_urgent_orders(_urgent_problem(), [simple_trip()], unserved)
    assert len(violations) == 1
    v = violations[0]
    assert (v.rule_code, v.severity, v.order_id) == ("RM-15", Severity.BLOCKING, "O3")
    assert "BONA" in v.message and "6 000 L de SUPER" in v.message and "Stock dépôt insuffisant" in v.message
    assert rules.has_blocking(violations)


def test_RM_15_commande_urgente_oubliee_des_non_servies_bloquante():
    violations = rules.rm_15_urgent_orders(_urgent_problem(), [simple_trip()], None)
    assert [v.order_id for v in violations] == ["O3"]


def test_RM_15_commande_urgente_reportee_ne_bloque_plus():
    # Reportée explicitement : elle n'est plus dans les commandes à planifier.
    problem = make_problem()
    unserved = [UnservedD("O3", UnservedReason.DEPOT_STOCK)]
    assert rules.rm_15_urgent_orders(problem, [simple_trip()], unserved) == []


def test_RM_15_tri_des_non_servies_urgentes_en_tete():
    problem = _urgent_problem()
    unserved = [
        UnservedD("O1", UnservedReason.NO_TRUCK),
        UnservedD("O?", UnservedReason.OTHER),
        UnservedD("O3", UnservedReason.DEPOT_STOCK),
        UnservedD("O2", UnservedReason.TIME_WINDOW),
    ]
    assert [u.order_id for u in rules.sort_unserved(problem, unserved)] == ["O3", "O1", "O?", "O2"]
    assert rules.is_urgent(problem.order("O3")) and not rules.is_urgent(problem.order("O1"))


# ------------------------------------------------------------------ RM-16


def _partial(volume: float, requested: float = 10_000):
    problem = make_problem(orders=[order("O1", "S1", SUPER, requested)])
    return problem, [trip(2, stops=[stop("S1", [("O1", SUPER, volume)], seq=1)])]


def test_RM_16_livraison_complete_conforme():
    assert rules.rm_16_delivery_volume(*_partial(10_000)) == []


def test_RM_16_livraison_partielle_egale_au_seuil_de_50_pct_conforme():
    assert rules.rm_16_delivery_volume(*_partial(5_000)) == []


def test_RM_16_livraison_partielle_sous_le_seuil_avertissement():
    violations = rules.rm_16_delivery_volume(*_partial(4_999))
    assert len(violations) == 1
    v = violations[0]
    assert (v.rule_code, v.severity) == ("RM-16", Severity.WARNING)
    assert (v.trip_seq, v.stop_seq, v.order_id) == (2, 1, "O1")
    assert "AKWA" in v.message and "4 999 L" in v.message and "50 %" in v.message


def test_RM_16_volume_livre_superieur_au_demande_avertissement():
    violations = rules.rm_16_delivery_volume(*_partial(10_500))
    assert [(v.severity, v.order_id) for v in violations] == [(Severity.WARNING, "O1")]
    assert "500 L de plus" in violations[0].message


def test_RM_16_volume_cumule_sur_plusieurs_tournees():
    problem = make_problem(orders=[order("O1", "S1", SUPER, 10_000)])
    trips = [
        trip(1, stops=[stop("S1", [("O1", SUPER, 3_000)])]),
        trip(2, start_s=13 * H, stops=[stop("S1", [("O1", SUPER, 3_000)])]),
    ]
    assert rules.rm_16_delivery_volume(problem, trips) == []  # 6 000 L ≥ 50 %
    trips[1].stops[0].deliveries[0].planned_l = 8_000
    assert codes(rules.rm_16_delivery_volume(problem, trips)) == ["RM-16"]  # 11 000 L > demandé


def test_RM_16_seuil_lu_dans_les_parametres():
    problem, trips = _partial(7_000)
    problem.params = Params(partial_delivery_min_pct=80.0)
    assert codes(rules.rm_16_delivery_volume(problem, trips)) == ["RM-16"]
    assert rules.min_partial_volume_l(problem.order("O1"), problem.params) == 8_000
    assert rules.delivery_volume_allowed(problem.order("O1"), 8_000, problem.params)
    assert not rules.delivery_volume_allowed(problem.order("O1"), 10_001, problem.params)


# ------------------------------------------------------------------ RM-17


def test_RM_17_tournee_verrouillee_inchangee_conforme():
    before = [simple_trip(1, locked=True), trip(2, start_s=13 * H)]
    # Après recalcul : renumérotée et décalée dans le temps, mais contenu identique.
    after = [trip(1, start_s=12 * H), simple_trip(2, locked=True, start_s=7 * H)]
    assert rules.rm_17_locked_trips_unchanged(before, after) == []


def test_RM_17_tournee_non_verrouillee_modifiable():
    before = [simple_trip(1)]
    after = [simple_trip(1, driver_id="DR2")]
    assert rules.rm_17_locked_trips_unchanged(before, after) == []


def test_RM_17_tournee_verrouillee_modifiee_par_le_recalcul():
    problem = make_problem()
    before = [simple_trip(1, locked=True, ref="trip-a")]
    changed = simple_trip(4, locked=True, ref="trip-a", driver_id="DR2")
    changed.stops.reverse()
    violations = rules.rm_17_locked_trips_unchanged(before, [changed], problem)
    assert len(violations) == 1
    v = violations[0]
    assert (v.rule_code, v.severity, v.trip_seq) == ("RM-17", Severity.BLOCKING, 1)
    assert "LT-001-AA" in v.message and "le chauffeur" in v.message and "les arrêts" in v.message


def test_RM_17_volume_ou_chargement_modifie_sur_tournee_verrouillee():
    before = [simple_trip(1, locked=True)]
    after = [simple_trip(1, locked=True, loads=[("C2", SUPER, 5_000), ("C1", GASOIL, 4_000)])]
    violations = rules.rm_17_locked_trips_unchanged(before, after)
    assert len(violations) == 1 and "plan de chargement" in violations[0].message


def test_RM_17_tournee_verrouillee_disparue():
    violations = rules.rm_17_locked_trips_unchanged([simple_trip(1, locked=True)], [])
    assert len(violations) == 1 and "disparu" in violations[0].message


# ------------------------------------------------------------------ check_plan


def test_check_plan_plan_conforme_sans_violation():
    problem = make_problem()
    assert rules.check_plan(problem, [simple_trip()], []) == []
    assert not rules.has_blocking([])


def test_check_plan_agrege_toutes_les_regles():
    problem = make_problem(
        drivers=[driver(available_today=False)],
        depot_stocks={("D1", SUPER): 1_000.0},
        orders=[
            order("O1", "S1", SUPER, 5_000),
            order("O2", "S2", GASOIL, 4_000),
            order("O3", "S2", SUPER, 6_000, urgent=True),
        ],
    )
    t = simple_trip(loads=[("C1", SUPER, 5_000), ("C1", GASOIL, 4_000)])
    violations = rules.check_plan(problem, [t], [UnservedD("O3", UnservedReason.DEPOT_STOCK)])
    assert codes(violations) == ["RM-03", "RM-06", "RM-08", "RM-08", "RM-15"]
    assert rules.has_blocking(violations)


def test_check_plan_avertissements_seuls_non_bloquants():
    problem = make_problem(depot_stocks={})
    violations = rules.check_plan(problem, [simple_trip()])
    assert codes(violations) == ["RM-08", "RM-08"]
    assert not rules.has_blocking(violations)


def test_check_plan_RM_17_tournees_verrouillees_du_probleme():
    locked = simple_trip(1, locked=True)
    problem = make_problem(locked_trips=[locked])
    assert rules.check_plan(problem, [simple_trip(1, locked=True)], []) == []
    moved = simple_trip(1, locked=True)
    moved.stops.reverse()
    assert codes(rules.check_plan(problem, [moved], [])) == ["RM-17"]
