"""Conversion des volumes à 15 °C (RM-12) — module pur, sans base ni réseau.

Formule exacte de la spec :

    volume à 15 °C = volume observé × [1 − coefficient_produit × (température observée − 15)]

- Le coefficient de dilatation vient de `products.thermal_coeff` (paramétrable, jamais en dur ici).
- La densité observée est stockée et affichée mais n'entre PAS dans le calcul du prototype
  (tables ASTM hors périmètre).
- Tout le calcul est fait en `Decimal` ; le résultat est arrondi au centième de litre
  (précision de la colonne `numeric(12,2)`), arrondi arithmétique « au plus proche, demi vers le haut »
  (`ROUND_HALF_UP`) : 102,485 L → 102,49 L.
"""

from decimal import ROUND_HALF_UP, Decimal

# Température de référence de la formule RM-12 (définition même du « volume à 15 °C », pas un réglage).
REFERENCE_TEMP_C = Decimal("15")
CENTILITER = Decimal("0.01")

ASTM_NOTE = (
    "volume corrigé à 15 °C selon coefficient de dilatation, tables ASTM non appliquées dans le prototype"
)


def to_decimal(value: Decimal | int | float | str) -> Decimal:
    """Convertit sans bruit binaire (un `float` passe par sa représentation décimale courte)."""
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def round_liters(value: Decimal) -> Decimal:
    """Arrondi au centième de litre, demi vers le haut."""
    return value.quantize(CENTILITER, rounding=ROUND_HALF_UP)


def correction_factor(
    observed_temp_c: Decimal | float | str, thermal_coeff: Decimal | float | str
) -> Decimal:
    """Facteur [1 − coefficient × (température − 15)], non arrondi."""
    return Decimal(1) - to_decimal(thermal_coeff) * (to_decimal(observed_temp_c) - REFERENCE_TEMP_C)


def volume_at_15(
    observed_l: Decimal | float | str,
    observed_temp_c: Decimal | float | str,
    thermal_coeff: Decimal | float | str,
) -> Decimal:
    """RM-12 : volume à 15 °C, en litres, arrondi au centième."""
    return round_liters(to_decimal(observed_l) * correction_factor(observed_temp_c, thermal_coeff))
