"""Prédicats de filtrage partagés par le moteur (lot L2) et l'édition manuelle (lot L5).

Fonctions pures, sans effet de bord, qui répondent par oui/non (ou par une valeur) à une question
élémentaire d'une règle métier. Les fonctions `rm_xx_…` de `rules.py` s'appuient dessus : filtrer en
amont avec un prédicat ou contrôler en aval avec la règle donne donc toujours le même verdict.

Tout est réexporté par `app.planning.violations.rules` (point d'entrée unique).
"""

from __future__ import annotations

from datetime import date

from app.core.enums import OrderPriority, Severity
from app.planning.domain import (
    CompartmentD,
    DriverD,
    OrderD,
    Params,
    PlanningProblem,
    StationD,
    TripD,
    TruckD,
    UnservedD,
)
from app.planning.violations.eligibility import driver_unavailable_reason, truck_block_reason

# Tolérance d'arrondi des comparaisons de volumes en virgule flottante (litres). Ce n'est pas un
# seuil métier : elle évite seulement qu'une somme comme 3 333,33 + 3 333,33 + 3 333,34 soit jugée
# supérieure à 10 000 à cause de la représentation binaire.
VOLUME_EPSILON_L = 1e-6


# --------------------------------------------------------------------------- ressources (RM-03, RM-04)


def is_truck_assignable(truck: TruckD) -> bool:
    """RM-04 : le camion peut-il être affecté à une tournée du jour J ?"""
    return truck_block_reason(truck) is None


def assignable_trucks(problem: PlanningProblem) -> list[TruckD]:
    """RM-04 : camions affectables du problème, dans l'ordre d'origine."""
    return [t for t in problem.trucks if is_truck_assignable(t)]


def is_driver_assignable(driver: DriverD, day: date) -> bool:
    """RM-03 (+ statut du référentiel et disponibilité du jour) : chauffeur affectable pour J ?"""
    return driver_unavailable_reason(driver, day) is None


def assignable_drivers(problem: PlanningProblem) -> list[DriverD]:
    """RM-03 : chauffeurs affectables pour `problem.day`, dans l'ordre d'origine."""
    return [d for d in problem.drivers if is_driver_assignable(d, problem.day)]


# --------------------------------------------------------------------------- gabarit (RM-09)


def truck_can_serve_station(truck: TruckD, station: StationD) -> bool:
    """RM-09 : gabarit du camion ≤ gabarit maximal accepté par la station."""
    return truck.size.rank <= station.max_truck_size.rank


def trucks_for_station(problem: PlanningProblem, station: StationD) -> list[TruckD]:
    """Camions affectables (RM-04) dont le gabarit est accepté par la station (RM-09)."""
    return [t for t in assignable_trucks(problem) if truck_can_serve_station(t, station)]


# --------------------------------------------------------------------------- compartiments (RM-05/06/07)


def compartment_usable_capacity_l(compartment: CompartmentD, params: Params) -> float:
    """RM-05 : capacité utile = capacité × (1 − marge de sécurité)."""
    return compartment.capacity_l * (1.0 - params.compartment_safety_margin_pct / 100.0)


def compartment_accepts_product(
    compartment: CompartmentD, product_id: str, current_product_id: str | None = None
) -> bool:
    """RM-07 (liste autorisée) et RM-06 (mono-produit) : le compartiment peut-il recevoir ce produit ?

    `current_product_id` : produit déjà chargé dans ce compartiment pour la tournée, s'il y en a un.
    """
    if current_product_id is not None and current_product_id != product_id:
        return False
    return compartment.accepts(product_id)


def compartment_accepts_volume(
    compartment: CompartmentD, volume_l: float, params: Params, already_loaded_l: float = 0.0
) -> bool:
    """RM-05 : le volume (ajouté à ce qui est déjà chargé) tient-il dans la capacité utile ?"""
    usable = compartment_usable_capacity_l(compartment, params)
    return already_loaded_l + volume_l <= usable + VOLUME_EPSILON_L


def compartment_can_load(
    compartment: CompartmentD,
    product_id: str,
    volume_l: float,
    params: Params,
    *,
    current_product_id: str | None = None,
    already_loaded_l: float = 0.0,
) -> bool:
    """RM-05 + RM-06 + RM-07 : ce compartiment accepte-t-il ce produit et ce volume ?"""
    return compartment_accepts_product(
        compartment, product_id, current_product_id
    ) and compartment_accepts_volume(compartment, volume_l, params, already_loaded_l)


def truck_product_capacity_l(truck: TruckD, product_id: str, params: Params) -> float:
    """Volume maximal d'un produit transportable par le camion sur une tournée : somme des capacités
    utiles (RM-05) des compartiments compatibles (RM-07). Borne de la dimension de capacité (§7.3)."""
    return sum(compartment_usable_capacity_l(c, params) for c in truck.compartments if c.accepts(product_id))


# --------------------------------------------------------------------------- temps (RM-02, RM-10, RM-11)


def intervals_overlap(a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
    """RM-02 : deux intervalles se chevauchent-ils ? Se toucher (fin de l'un = début de l'autre)
    n'est pas un chevauchement."""
    return a_start < b_end and b_start < a_end


def trips_overlap(a: TripD, b: TripD) -> bool:
    """RM-02 : deux tournées se chevauchent-elles dans le temps ?

    Une tournée occupe ses ressources de `start_s` (arrivée au dépôt) à `return_s` (retour au dépôt).
    """
    return intervals_overlap(a.start_s, a.return_s, b.start_s, b.return_s)


def window_severity(lateness_s: int, params: Params) -> Severity | None:
    """RM-10 : sévérité d'un retard sur une fenêtre horaire.

    `None` si pas de retard, avertissement jusqu'à `window_tolerance_min` inclus, bloquant au-delà.
    """
    if lateness_s <= 0:
        return None
    if lateness_s <= params.window_tolerance_min * 60:
        return Severity.WARNING
    return Severity.BLOCKING


def service_duration_exceeded(duration_s: int, params: Params) -> bool:
    """RM-11 : la durée (d'une tournée ou cumulée d'un chauffeur) dépasse-t-elle le maximum ?"""
    return duration_s > params.max_service_s


# --------------------------------------------------------------------------- commandes (RM-15, RM-16)


def min_partial_volume_l(order: OrderD, params: Params) -> float:
    """RM-16 : volume minimal d'une livraison partielle autorisée."""
    return order.requested_l * params.partial_delivery_min_pct / 100.0


def delivery_volume_allowed(order: OrderD, volume_l: float, params: Params) -> bool:
    """RM-16 : le volume planifié pour la commande est-il admissible (entre le minimum partiel et
    le volume demandé, bornes comprises) ?"""
    return (
        min_partial_volume_l(order, params) - VOLUME_EPSILON_L
        <= volume_l
        <= order.requested_l + VOLUME_EPSILON_L
    )


def is_urgent(order: OrderD) -> bool:
    """RM-15 : la commande est-elle urgente ?"""
    return order.priority == OrderPriority.URGENT


def sort_unserved(problem: PlanningProblem, unserved: list[UnservedD]) -> list[UnservedD]:
    """RM-15 : commandes non servies triées, urgentes en tête (tri stable : l'ordre d'origine est
    conservé à priorité égale). Une commande inconnue du problème est traitée comme non urgente."""
    urgent_ids = {o.id for o in problem.orders if is_urgent(o)}
    return sorted(unserved, key=lambda u: 0 if u.order_id in urgent_ids else 1)
