"""RM-13 — écart chargé (à 15 °C) / planifié, par compartiment et au total de la tournée."""

from decimal import Decimal

import pytest

from app.loading.deviation import compute_gap, evaluate_rm_13

TOL = Decimal("2")


@pytest.mark.parametrize("loaded", ["9850", "10000", "10150"])
def test_RM_13_sous_la_tolerance_pas_d_avertissement(loaded):
    gap = compute_gap(Decimal(loaded), Decimal("10000"), TOL)
    assert gap.out_of_tolerance is False


@pytest.mark.parametrize(("loaded", "pct"), [("9800", "-2.00"), ("10200", "2.00")])
def test_RM_13_exactement_a_la_tolerance_pas_d_avertissement(loaded, pct):
    gap = compute_gap(Decimal(loaded), Decimal("10000"), TOL)
    assert gap.gap_pct == Decimal(pct)
    assert gap.out_of_tolerance is False


@pytest.mark.parametrize("loaded", ["9799.99", "10200.01", "9000", "11000"])
def test_RM_13_au_dessus_de_la_tolerance_avertissement(loaded):
    gap = compute_gap(Decimal(loaded), Decimal("10000"), TOL)
    assert gap.out_of_tolerance is True
    assert gap.gap_l == Decimal(loaded) - Decimal("10000")


def test_RM_13_tolerance_parametrable():
    assert compute_gap(Decimal("9700"), Decimal("10000"), Decimal("5")).out_of_tolerance is False
    assert compute_gap(Decimal("9950"), Decimal("10000"), Decimal("0.1")).out_of_tolerance is True


def test_RM_13_par_compartiment_et_total_dans_la_tolerance():
    result = evaluate_rm_13(
        {"c1": Decimal("10000"), "c2": Decimal("5000")}, {"c1": Decimal("10100"), "c2": Decimal("4950")}, TOL
    )
    assert result.warning is False
    assert result.message is None
    assert result.total.planned_l == Decimal("15000")
    assert result.total.loaded_15_l == Decimal("15050")
    assert result.total.gap_pct == Decimal("0.33")


def test_RM_13_un_compartiment_hors_tolerance_alors_que_le_total_se_compense():
    # +3 % et −3 % : le total est juste, mais chaque compartiment est hors tolérance.
    result = evaluate_rm_13(
        {"c1": Decimal("10000"), "c2": Decimal("10000")},
        {"c1": Decimal("10300"), "c2": Decimal("9700")},
        TOL,
        labels={"c1": "1", "c2": "2"},
    )
    assert result.total.out_of_tolerance is False
    assert result.by_compartment["c1"].out_of_tolerance is True
    assert result.by_compartment["c2"].out_of_tolerance is True
    assert result.warning is True
    assert "compartiment 1" in result.message and "compartiment 2" in result.message
    assert "total" not in result.message


def test_RM_13_total_hors_tolerance_quand_un_compartiment_planifie_n_est_pas_charge():
    result = evaluate_rm_13(
        {"c1": Decimal("10000"), "c2": Decimal("5000")},
        {"c1": Decimal("10100")},
        TOL,
        labels={"c1": "1", "c2": "2"},
    )
    assert result.by_compartment["c1"].out_of_tolerance is False
    assert result.by_compartment["c2"].loaded_15_l == Decimal("0")
    assert result.by_compartment["c2"].out_of_tolerance is True
    assert result.total.gap_l == Decimal("-4900")
    assert result.total.out_of_tolerance is True
    assert "total de la tournée" in result.message
    assert "RM-13" not in result.message  # le code est porté par `rule_code`, pas par le texte


def test_RM_13_volume_charge_sans_planifie_hors_tolerance():
    gap = compute_gap(Decimal("500"), Decimal("0"), TOL)
    assert gap.gap_pct is None
    assert gap.out_of_tolerance is True
    assert compute_gap(Decimal("0"), Decimal("0"), TOL).out_of_tolerance is False


def test_RM_13_message_en_francais_avec_tolerance_et_ecart():
    result = evaluate_rm_13({"c1": Decimal("10000")}, {"c1": Decimal("9700")}, TOL, labels={"c1": "1"})
    assert result.message == (
        "Écart entre volume chargé à 15 °C et volume planifié au-delà de la tolérance (2 %) — "
        "compartiment 1 : −300 L (−3 %) ; total de la tournée : −300 L (−3 %)."
    )
