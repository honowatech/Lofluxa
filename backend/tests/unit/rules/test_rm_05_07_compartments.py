"""RM-05 à RM-07 : capacité, mono-produit et produits autorisés des compartiments."""

from app.core.enums import Severity
from app.planning.domain import Params
from app.planning.violations import rules

from .builders import GASOIL, SUPER, compartment, make_problem, order, simple_trip, stop, trip, truck

# ------------------------------------------------------------------ RM-05


def test_RM_05_chargement_sous_la_capacite_utile_conforme():
    assert rules.rm_05_compartment_capacity(make_problem(), [simple_trip()]) == []


def test_RM_05_egalite_a_la_capacite_utile_conforme():
    # 10 000 L × (1 − 2 %) = 9 800 L pile.
    problem = make_problem(orders=[order("O1", "S1", SUPER, 9_800)])
    t = trip(stops=[stop("S1", [("O1", SUPER, 9_800)])], loads=[("C1", SUPER, 9_800)])
    assert rules.rm_05_compartment_capacity(problem, [t]) == []


def test_RM_05_depassement_de_la_capacite_utile_bloquant():
    problem = make_problem(orders=[order("O1", "S1", SUPER, 9_801)])
    t = trip(4, stops=[stop("S1", [("O1", SUPER, 9_801)])], loads=[("C1", SUPER, 9_801)])
    violations = rules.rm_05_compartment_capacity(problem, [t])
    assert len(violations) == 1
    v = violations[0]
    assert (v.rule_code, v.severity, v.trip_seq) == ("RM-05", Severity.BLOCKING, 4)
    assert "LT-001-AA" in v.message and "9 801 L" in v.message and "9 800 L" in v.message


def test_RM_05_somme_des_chargements_d_un_meme_compartiment():
    t = trip(loads=[("C1", SUPER, 6_000), ("C1", SUPER, 4_000)])
    violations = rules.rm_05_compartment_capacity(make_problem(), [t])
    assert len(violations) == 1 and "10 000 L" in violations[0].message


def test_RM_05_marge_de_securite_lue_dans_les_parametres():
    problem = make_problem(params=Params(compartment_safety_margin_pct=0.0))
    t = trip(loads=[("C1", SUPER, 10_000)])
    assert rules.rm_05_compartment_capacity(problem, [t]) == []
    assert rules.compartment_usable_capacity_l(compartment(capacity_l=10_000), Params()) == 9_800


def test_RM_05_volume_a_livrer_sans_place_dans_les_compartiments_bloquant():
    # 5 000 L à livrer, 3 000 L seulement dans le plan de chargement.
    t = trip(stops=[stop("S1", [("O1", SUPER, 5_000)])], loads=[("C1", SUPER, 3_000)])
    violations = rules.rm_05_compartment_capacity(make_problem(), [t])
    assert len(violations) == 1
    assert violations[0].severity == Severity.BLOCKING
    assert "2 000 L de SUPER" in violations[0].message


def test_RM_05_compartiment_etranger_au_camion_bloquant():
    t = trip(loads=[("C-AUTRE", SUPER, 1_000)])
    violations = rules.rm_05_compartment_capacity(make_problem(), [t])
    assert len(violations) == 1 and "n'appartient pas" in violations[0].message


def test_RM_05_predicat_volume_accepte_par_un_compartiment():
    params = Params()
    c = compartment(capacity_l=10_000)
    assert rules.compartment_accepts_volume(c, 9_800, params)
    assert not rules.compartment_accepts_volume(c, 9_800.5, params)
    assert not rules.compartment_accepts_volume(c, 5_000, params, already_loaded_l=5_000)
    assert rules.truck_product_capacity_l(truck(), SUPER, params) == 9_800 + 7_840


# ------------------------------------------------------------------ RM-06


def test_RM_06_un_produit_par_compartiment_conforme():
    assert rules.rm_06_compartment_single_product(make_problem(), [simple_trip()]) == []


def test_RM_06_compartiment_mono_produit_viole():
    t = trip(2, loads=[("C1", SUPER, 3_000), ("C1", GASOIL, 2_000), ("C2", GASOIL, 1_000)])
    violations = rules.rm_06_compartment_single_product(make_problem(), [t])
    assert len(violations) == 1
    v = violations[0]
    assert (v.rule_code, v.severity, v.trip_seq) == ("RM-06", Severity.BLOCKING, 2)
    assert "compartiment 1" in v.message and "SUPER et GASOIL" in v.message


def test_RM_06_meme_compartiment_produits_differents_sur_deux_tournees_conforme():
    first = trip(1, loads=[("C1", SUPER, 3_000)])
    second = trip(2, start_s=13 * 3600, loads=[("C1", GASOIL, 3_000)])
    assert rules.rm_06_compartment_single_product(make_problem(), [first, second]) == []


# ------------------------------------------------------------------ RM-07


def _restricted_truck():
    return truck(compartments=(compartment("C1", 1, 10_000, allowed=[GASOIL]), compartment("C2", 2, 8_000)))


def test_RM_07_compartiment_produit_autorise_conforme():
    problem = make_problem(trucks=[_restricted_truck()])
    t = trip(loads=[("C1", GASOIL, 4_000), ("C2", SUPER, 5_000)])
    assert rules.rm_07_compartment_allowed_product(problem, [t]) == []


def test_RM_07_compartiment_sans_liste_accepte_tous_les_produits():
    assert rules.rm_07_compartment_allowed_product(make_problem(), [simple_trip()]) == []


def test_RM_07_compartiment_produit_non_autorise_bloquant():
    problem = make_problem(trucks=[_restricted_truck()])
    t = trip(5, loads=[("C1", SUPER, 4_000), ("C1", SUPER, 1_000)])
    violations = rules.rm_07_compartment_allowed_product(problem, [t])
    assert len(violations) == 1  # une seule violation par (compartiment, produit)
    v = violations[0]
    assert (v.rule_code, v.severity, v.trip_seq) == ("RM-07", Severity.BLOCKING, 5)
    assert "SUPER" in v.message and "GASOIL" in v.message and "LT-001-AA" in v.message


def test_RM_07_compartiment_mono_produit():
    """Prédicat combiné RM-05/06/07 utilisé par le moteur et l'édition manuelle."""
    params = Params()
    c = compartment("C1", 1, 10_000, allowed=[GASOIL])
    assert rules.compartment_accepts_product(c, GASOIL)
    assert not rules.compartment_accepts_product(c, SUPER)  # RM-07
    assert not rules.compartment_accepts_product(compartment(), SUPER, current_product_id=GASOIL)  # RM-06
    assert rules.compartment_can_load(c, GASOIL, 9_800, params)
    assert not rules.compartment_can_load(c, GASOIL, 9_900, params)  # RM-05
    assert not rules.compartment_can_load(c, SUPER, 100, params)
    assert not rules.compartment_can_load(c, GASOIL, 100, params, current_product_id=SUPER)
    assert rules.compartment_can_load(
        c, GASOIL, 800, params, current_product_id=GASOIL, already_loaded_l=9_000
    )
