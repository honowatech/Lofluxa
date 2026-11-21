"""Affectation aux compartiments : RM-05, RM-06, RM-07 (spec §7.3)."""

import pytest

from app.planning.engine.compartments import (
    assign_compartments,
    product_capacity_l,
    total_capacity_l,
    usable_capacity_l,
)

from .helpers import truck

MARGIN = 2.0


def _by_compartment(loads):
    return {load.compartment_id: (load.product_id, load.planned_l) for load in loads}


def test_RM_05_marge_de_securite_par_compartiment():
    camion = truck("T", (5000, 4000))
    assert usable_capacity_l(camion.compartments[0], MARGIN) == pytest.approx(4900)
    assert total_capacity_l(camion, MARGIN) == pytest.approx(8820)
    # 4 900 L tiennent dans le compartiment de 5 000 L ; 5 000 L débordent sur le second.
    assert _by_compartment(assign_compartments(camion, {"SUPER": 4900}, MARGIN)) == {"T-C1": ("SUPER", 4900)}
    loads = assign_compartments(camion, {"SUPER": 5000}, MARGIN)
    assert _by_compartment(loads) == {"T-C1": ("SUPER", 4900), "T-C2": ("SUPER", 100)}
    for load in loads:
        capacity = next(c.capacity_l for c in camion.compartments if c.id == load.compartment_id)
        assert load.planned_l <= capacity * 0.98 + 1e-9
    # Au-delà de la capacité utile totale : impossible.
    assert assign_compartments(camion, {"SUPER": 8821}, MARGIN) is None
    assert assign_compartments(camion, {"SUPER": 8820}, MARGIN) is not None


def test_RM_06_compartiment_mono_produit():
    camion = truck("T", (5000, 5000))
    loads = assign_compartments(camion, {"SUPER": 4000, "GASOIL": 3000}, MARGIN)
    assert _by_compartment(loads) == {"T-C1": ("SUPER", 4000), "T-C2": ("GASOIL", 3000)}
    assert len({load.compartment_id for load in loads}) == len(loads)
    # Trois produits pour deux compartiments : le volume total tiendrait, mais pas sans mélange.
    assert assign_compartments(camion, {"SUPER": 3000, "GASOIL": 3000, "PETROLE": 1000}, MARGIN) is None


def test_RM_07_compartiment_produits_autorises():
    camion = truck("T", (6000, 4000), allowed={1: {"GASOIL"}})
    assert product_capacity_l(camion, "SUPER", MARGIN) == pytest.approx(3920)
    assert product_capacity_l(camion, "GASOIL", MARGIN) == pytest.approx(9800)
    # Le super ne peut aller que dans le second compartiment.
    assert _by_compartment(assign_compartments(camion, {"SUPER": 3000}, MARGIN)) == {"T-C2": ("SUPER", 3000)}
    assert assign_compartments(camion, {"SUPER": 4500}, MARGIN) is None
    loads = assign_compartments(camion, {"SUPER": 3000, "GASOIL": 5000}, MARGIN)
    assert _by_compartment(loads) == {"T-C1": ("GASOIL", 5000), "T-C2": ("SUPER", 3000)}
    # Aucun compartiment n'accepte le pétrole si les deux sont réservés.
    reserve = truck("R", (6000, 4000), allowed={1: {"GASOIL"}, 2: {"SUPER"}})
    assert assign_compartments(reserve, {"PETROLE": 1000}, MARGIN) is None


def test_glouton_plus_gros_volume_dans_plus_gros_compartiment():
    camion = truck("T", (3000, 7000, 5000))
    loads = assign_compartments(camion, {"SUPER": 2500, "GASOIL": 6000}, MARGIN)
    assert _by_compartment(loads) == {"T-C2": ("GASOIL", 6000), "T-C3": ("SUPER", 2500)}
    assert [load.compartment_id for load in loads] == ["T-C2", "T-C3"]  # trié par position


def test_recherche_exhaustive_quand_le_glouton_echoue():
    # Glouton : le gasoil (plus gros volume) prend le compartiment de 6 000 L, seul admis pour le super.
    camion = truck("T", (6000, 5000), allowed={2: {"GASOIL"}})
    loads = assign_compartments(camion, {"GASOIL": 4500, "SUPER": 4000}, MARGIN)
    assert _by_compartment(loads) == {"T-C1": ("SUPER", 4000), "T-C2": ("GASOIL", 4500)}
    # Un produit réparti sur deux compartiments quand il le faut.
    autre = truck("U", (4000, 4000, 4000), allowed={3: {"SUPER"}})
    loads = assign_compartments(autre, {"GASOIL": 7000, "SUPER": 3000}, MARGIN)
    assert sum(x.planned_l for x in loads if x.product_id == "GASOIL") == pytest.approx(7000)
    assert _by_compartment(loads)["U-C3"] == ("SUPER", 3000)


def test_rien_a_charger():
    assert assign_compartments(truck("T"), {}, MARGIN) == []
    assert assign_compartments(truck("T"), {"SUPER": 0.0}, MARGIN) == []
