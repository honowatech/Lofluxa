"""Écart entre volume chargé (à 15 °C) et volume planifié (RM-13) — module pur.

Granularité retenue (voir docs/questions/l6-chargement.md) :

- l'écart est évalué **par compartiment** (volume à 15 °C chargé dans le compartiment contre le volume
  planifié pour ce compartiment) **et au total de la tournée** (somme des volumes à 15 °C contre somme
  des volumes planifiés) ;
- un compartiment planifié mais absent du chargement compte pour 0 L chargé ;
- la tournée reçoit **un seul** avertissement RM-13 dès qu'au moins un compartiment ou le total sort de
  la tolérance ; le message détaille les compartiments concernés.

« Au-delà de la tolérance » est strict : un écart exactement égal à la tolérance n'alerte pas.
L'écart est pris en valeur absolue (sur-chargement comme sous-chargement).
"""

from collections.abc import Hashable, Mapping
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal

from app.loading.conversion import to_decimal

RULE_CODE = "RM-13"
_PCT = Decimal("0.01")


@dataclass(frozen=True)
class Gap:
    """Écart d'un compartiment ou du total."""

    planned_l: Decimal
    loaded_15_l: Decimal
    gap_l: Decimal  # chargé à 15 °C − planifié
    gap_pct: Decimal | None  # en % du planifié, arrondi au centième ; None si rien n'était planifié
    out_of_tolerance: bool


def compute_gap(
    loaded_15_l: Decimal | float, planned_l: Decimal | float, tolerance_pct: Decimal | float
) -> Gap:
    loaded = to_decimal(loaded_15_l)
    planned = to_decimal(planned_l)
    tolerance = to_decimal(tolerance_pct)
    gap = loaded - planned
    if planned > 0:
        # Comparaison exacte, sans arrondi : |écart| × 100 > tolérance × planifié.
        out = abs(gap) * 100 > tolerance * planned
        pct = (gap * 100 / planned).quantize(_PCT, rounding=ROUND_HALF_UP)
    else:
        # Rien de planifié : tout volume chargé est hors tolérance, le pourcentage n'a pas de sens.
        out = loaded > 0
        pct = None
    return Gap(planned_l=planned, loaded_15_l=loaded, gap_l=gap, gap_pct=pct, out_of_tolerance=out)


@dataclass(frozen=True)
class Rm13Result:
    tolerance_pct: Decimal
    by_compartment: dict[Hashable, Gap]
    total: Gap
    labels: dict[Hashable, str] = field(default_factory=dict)

    @property
    def warning(self) -> bool:
        return self.total.out_of_tolerance or any(g.out_of_tolerance for g in self.by_compartment.values())

    @property
    def message(self) -> str | None:
        """Message en français destiné au dispatcher et à la fiche de chargement ; None si tout va bien."""
        if not self.warning:
            return None
        parts = [
            f"compartiment {self.labels.get(key, key)} : {_describe(gap)}"
            for key, gap in self.by_compartment.items()
            if gap.out_of_tolerance
        ]
        if self.total.out_of_tolerance:
            parts.append(f"total de la tournée : {_describe(self.total)}")
        return (
            f"Écart entre volume chargé à 15 °C et volume planifié au-delà de la tolérance "
            f"({_fr(self.tolerance_pct)} %) — " + " ; ".join(parts) + "."
        )


def evaluate_rm_13(
    planned_by_compartment: Mapping[Hashable, Decimal | float],
    loaded_15_by_compartment: Mapping[Hashable, Decimal | float],
    tolerance_pct: Decimal | float,
    labels: Mapping[Hashable, str] | None = None,
) -> Rm13Result:
    """RM-13 : écart par compartiment (union des compartiments planifiés et chargés) et au total."""
    tolerance = to_decimal(tolerance_pct)
    keys = list(planned_by_compartment) + [
        k for k in loaded_15_by_compartment if k not in planned_by_compartment
    ]
    by_compartment = {
        key: compute_gap(
            loaded_15_by_compartment.get(key, Decimal(0)),
            planned_by_compartment.get(key, Decimal(0)),
            tolerance,
        )
        for key in keys
    }
    total = compute_gap(
        sum((g.loaded_15_l for g in by_compartment.values()), Decimal(0)),
        sum((g.planned_l for g in by_compartment.values()), Decimal(0)),
        tolerance,
    )
    return Rm13Result(
        tolerance_pct=tolerance, by_compartment=by_compartment, total=total, labels=dict(labels or {})
    )


def _fr(value: Decimal) -> str:
    text = f"{value:f}"
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text.replace(".", ",")


def _describe(gap: Gap) -> str:
    sign = "+" if gap.gap_l >= 0 else "−"
    liters = f"{sign}{_fr(abs(gap.gap_l).quantize(_PCT))} L"
    if gap.gap_pct is None:
        return f"{liters} (aucun volume planifié)"
    return f"{liters} ({sign}{_fr(abs(gap.gap_pct))} %)"
