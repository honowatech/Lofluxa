"""Fonction objectif du moteur (spec §7.3).

    objectif = distance totale × poids
             + nombre de véhicules (tournées) utilisés × coût fixe
             + pénalités des commandes non servies (normale / urgente)

Tout est exprimé en « kilomètres équivalents » dans les paramètres ; le solveur travaille en
entiers, l'unité interne est le mètre équivalent. Aucune pondération n'est en dur : tout vient
de `Params` (table `settings`).
"""

from __future__ import annotations

from collections.abc import Iterable

from app.core.enums import OrderPriority
from app.planning.domain import OrderD, Params, TripD

METERS_PER_KM = 1000


def arc_cost(distance_m: int, params: Params) -> int:
    """Coût d'un arc, en mètres équivalents."""
    return int(round(distance_m * params.objective_distance_weight))


def vehicle_fixed_cost(params: Params) -> int:
    """Coût fixe d'un véhicule virtuel (une tournée) utilisé, en mètres équivalents."""
    return int(round(params.objective_vehicle_fixed_cost_km * METERS_PER_KM))


def unserved_penalty(order: OrderD, params: Params) -> int:
    """Pénalité d'une commande non servie, en mètres équivalents (RM-15 : urgente ≫ normale)."""
    km = (
        params.objective_unserved_penalty_urgent_km
        if order.priority == OrderPriority.URGENT
        else params.objective_unserved_penalty_normal_km
    )
    return int(round(km * METERS_PER_KM))


def objective_km(trips: Iterable[TripD], unserved_orders: Iterable[OrderD], params: Params) -> float:
    """Valeur de l'objectif d'un plan complet, en kilomètres équivalents."""
    total = 0
    for trip in trips:
        if trip.stops:
            total += arc_cost(trip.distance_m, params) + vehicle_fixed_cost(params)
    for order in unserved_orders:
        total += unserved_penalty(order, params)
    return total / METERS_PER_KM
