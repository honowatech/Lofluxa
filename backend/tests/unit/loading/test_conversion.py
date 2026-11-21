"""RM-12 — conversion à 15 °C. Valeurs attendues calculées à la main."""

from decimal import Decimal

import pytest

from app.loading.conversion import ASTM_NOTE, correction_factor, volume_at_15

# Coefficients par défaut de la spec (insérés par le seed dans `products.thermal_coeff`).
SUPER = Decimal("0.00120")
GASOIL = Decimal("0.00085")
PETROLE = Decimal("0.00095")


@pytest.mark.parametrize(
    ("observed", "temp", "coeff", "expected"),
    [
        # 10 000 × (1 − 0,00120 × 10) = 10 000 × 0,988
        ("10000", "25", SUPER, "9880.00"),
        # 15 000 × (1 − 0,00085 × 15) = 15 000 × 0,98725
        ("15000", "30", GASOIL, "14808.75"),
        # 8 000 × (1 − 0,00095 × 13) = 8 000 × 0,98765
        ("8000", "28", PETROLE, "7901.20"),
    ],
)
def test_RM_12_temperature_superieure_a_15(observed, temp, coeff, expected):
    assert volume_at_15(Decimal(observed), Decimal(temp), coeff) == Decimal(expected)


@pytest.mark.parametrize(
    ("observed", "temp", "coeff", "expected"),
    [
        # 10 000 × (1 + 0,00120 × 5) = 10 000 × 1,006
        ("10000", "10", SUPER, "10060.00"),
        # 12 000 × (1 + 0,00085 × 2,5) = 12 000 × 1,002125
        ("12000", "12.5", GASOIL, "12025.50"),
        # 5 000 × (1 + 0,00095 × 10) = 5 000 × 1,0095
        ("5000", "5", PETROLE, "5047.50"),
    ],
)
def test_RM_12_temperature_inferieure_a_15(observed, temp, coeff, expected):
    assert volume_at_15(Decimal(observed), Decimal(temp), coeff) == Decimal(expected)


@pytest.mark.parametrize("coeff", [SUPER, GASOIL, PETROLE])
def test_RM_12_temperature_egale_a_15_volume_inchange(coeff):
    assert volume_at_15(Decimal("12345.67"), Decimal("15"), coeff) == Decimal("12345.67")


def test_RM_12_arrondi_au_centieme_de_litre():
    # 3 333,33 × (1 − 0,00120 × 12,4) = 3 333,33 × 0,98512 = 3 283,7300496
    assert volume_at_15(Decimal("3333.33"), Decimal("27.4"), SUPER) == Decimal("3283.73")
    # Demi vers le haut : 103 × 0,995 = 102,485 → 102,49 (et non 102,48 de l'arrondi bancaire).
    assert volume_at_15(Decimal("103"), Decimal("25"), Decimal("0.0005")) == Decimal("102.49")


def test_RM_12_calcul_decimal_exact_depuis_des_flottants():
    # Les valeurs de l'API arrivent en `float` : pas de bruit binaire dans le résultat.
    assert volume_at_15(10000.0, 25.0, 0.0012) == Decimal("9880.00")
    assert volume_at_15(0.1 + 0.2, 15, SUPER) == Decimal("0.30")
    assert isinstance(volume_at_15(1, 20, SUPER), Decimal)


def test_RM_12_coefficient_du_produit_pris_en_compte():
    # Même volume, même température : le résultat dépend du seul coefficient du produit.
    results = {volume_at_15(Decimal("20000"), Decimal("35"), c) for c in (SUPER, GASOIL, PETROLE)}
    assert results == {Decimal("19520.00"), Decimal("19660.00"), Decimal("19620.00")}
    assert correction_factor(Decimal("35"), SUPER) == Decimal("0.976")


def test_RM_12_mention_astm_exacte():
    assert ASTM_NOTE == (
        "volume corrigé à 15 °C selon coefficient de dilatation, tables ASTM non appliquées dans le prototype"
    )
