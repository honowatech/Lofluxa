"""Affectation fine des volumes aux compartiments (spec §7.3) — gabarit, LOT L2."""

from __future__ import annotations

from app.planning.domain import CompartmentLoadD, TruckD


def assign_compartments(
    truck: TruckD,
    volumes_by_product: dict[str, float],
    safety_margin_pct: float,
) -> list[CompartmentLoadD] | None:
    """Répartit les volumes (litres par produit) dans les compartiments du camion.

    Glouton : plus gros volume → plus gros compartiment compatible, en respectant RM-05 (marge de
    sécurité), RM-06 (un seul produit par compartiment) et RM-07 (produits autorisés).
    Renvoie `None` si aucune affectation n'est possible. Appelée par le moteur ET par l'édition
    manuelle (recalcul du plan de chargement après déplacement d'un arrêt).
    """
    raise NotImplementedError("Lot L2 — compartiments")
