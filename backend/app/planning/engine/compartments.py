"""Affectation fine des volumes aux compartiments (spec §7.3) — RM-05, RM-06, RM-07.

Fonctions pures, partagées par le moteur (contrôle des tournées calculées) et par l'édition
manuelle (recalcul du plan de chargement après déplacement d'un arrêt).
"""

from __future__ import annotations

from app.planning.domain import CompartmentD, CompartmentLoadD, TruckD

# Tolérance numérique sur les volumes (litres) : absorbe les erreurs d'arrondi des flottants.
EPSILON_L = 1e-6


def usable_capacity_l(compartment: CompartmentD, safety_margin_pct: float) -> float:
    """RM-05 : capacité utile d'un compartiment = capacité × (1 − marge de sécurité)."""
    return compartment.capacity_l * (1.0 - safety_margin_pct / 100.0)


def product_capacity_l(truck: TruckD, product_id: str, safety_margin_pct: float) -> float:
    """Borne haute du volume d'un produit dans le camion : compartiments compatibles (RM-07)."""
    return sum(usable_capacity_l(c, safety_margin_pct) for c in truck.compartments if c.accepts(product_id))


def total_capacity_l(truck: TruckD, safety_margin_pct: float) -> float:
    return sum(usable_capacity_l(c, safety_margin_pct) for c in truck.compartments)


def assign_compartments(
    truck: TruckD,
    volumes_by_product: dict[str, float],
    safety_margin_pct: float,
) -> list[CompartmentLoadD] | None:
    """Répartit les volumes (litres par produit) dans les compartiments du camion.

    Glouton de la spec : plus gros volume → plus gros compartiment compatible, en respectant RM-05
    (marge de sécurité), RM-06 (un seul produit par compartiment) et RM-07 (produits autorisés).
    Le glouton pouvant échouer alors qu'une répartition existe, une recherche exhaustive (les
    camions ont peu de compartiments) prend le relais avant de conclure.

    Renvoie la liste des chargements (triée par position de compartiment), une liste vide s'il
    n'y a rien à charger, ou `None` si aucune affectation n'est possible.
    """
    volumes = {p: float(v) for p, v in volumes_by_product.items() if v > EPSILON_L}
    if not volumes:
        return []
    usable = {c.id: usable_capacity_l(c, safety_margin_pct) for c in truck.compartments}
    # Conditions nécessaires rapides.
    if sum(volumes.values()) > sum(usable.values()) + EPSILON_L:
        return None
    for product_id, volume in volumes.items():
        if volume > product_capacity_l(truck, product_id, safety_margin_pct) + EPSILON_L:
            return None

    allocation = _greedy(truck, volumes, usable)
    if allocation is None:
        allocation = _exhaustive(truck, volumes, usable)
    if allocation is None:
        return None
    positions = {c.id: c.position for c in truck.compartments}
    loads = [
        CompartmentLoadD(compartment_id=cid, product_id=pid, planned_l=round(vol, 3))
        for cid, (pid, vol) in allocation.items()
        if vol > EPSILON_L
    ]
    loads.sort(key=lambda load: (positions[load.compartment_id], load.compartment_id))
    return loads


def _greedy(
    truck: TruckD, volumes: dict[str, float], usable: dict[str, float]
) -> dict[str, tuple[str, float]] | None:
    """Plus gros volume restant → plus gros compartiment libre compatible."""
    remaining = dict(volumes)
    free = sorted(truck.compartments, key=lambda c: (-usable[c.id], c.position, c.id))
    allocation: dict[str, tuple[str, float]] = {}
    while remaining:
        product_id = max(sorted(remaining), key=lambda p: remaining[p])
        compartment = next((c for c in free if c.accepts(product_id)), None)
        if compartment is None:
            return None
        loaded = min(remaining[product_id], usable[compartment.id])
        allocation[compartment.id] = (product_id, loaded)
        free.remove(compartment)
        remaining[product_id] -= loaded
        if remaining[product_id] <= EPSILON_L:
            del remaining[product_id]
    return allocation


def _exhaustive(
    truck: TruckD, volumes: dict[str, float], usable: dict[str, float]
) -> dict[str, tuple[str, float]] | None:
    """Retour arrière : attribue un produit (ou rien) à chaque compartiment, du plus gros au plus petit."""
    compartments = sorted(truck.compartments, key=lambda c: (-usable[c.id], c.position, c.id))
    products = sorted(volumes, key=lambda p: (-volumes[p], p))
    # Capacité compatible encore disponible à partir du rang i, par produit (élagage).
    suffix: list[dict[str, float]] = [dict.fromkeys(products, 0.0) for _ in range(len(compartments) + 1)]
    for i in range(len(compartments) - 1, -1, -1):
        for p in products:
            suffix[i][p] = suffix[i + 1][p] + (
                usable[compartments[i].id] if compartments[i].accepts(p) else 0
            )

    need = dict(volumes)
    choice: list[str | None] = [None] * len(compartments)

    def search(i: int) -> bool:
        if all(v <= EPSILON_L for v in need.values()):
            return True
        if i == len(compartments):
            return False
        if any(need[p] > suffix[i][p] + EPSILON_L for p in products):
            return False
        compartment = compartments[i]
        for p in products:
            if need[p] <= EPSILON_L or not compartment.accepts(p):
                continue
            before = need[p]
            need[p] = max(0.0, before - usable[compartment.id])
            choice[i] = p
            if search(i + 1):
                return True
            need[p] = before
            choice[i] = None
        return search(i + 1)

    if not search(0):
        return None
    remaining = dict(volumes)
    allocation: dict[str, tuple[str, float]] = {}
    for compartment, product_id in zip(compartments, choice, strict=True):
        if product_id is None or remaining[product_id] <= EPSILON_L:
            continue
        loaded = min(remaining[product_id], usable[compartment.id])
        allocation[compartment.id] = (product_id, loaded)
        remaining[product_id] -= loaded
    return allocation
