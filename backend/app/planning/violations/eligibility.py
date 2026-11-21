"""Affectabilité des ressources (RM-03, RM-04) — socle, livré.

Fonctions minimales partagées par la disponibilité du jour (F2.2, F2.3), le moteur (filtrage) et
les règles (`rules.py`, qui s'appuie dessus pour RM-03 et RM-04). Renvoient le motif de blocage
en français, ou `None` si la ressource est affectable.
"""

from __future__ import annotations

from datetime import date

from app.core.enums import TruckStatus
from app.planning.domain import DriverD, TruckD

_TRUCK_STATUS_FR = {
    TruckStatus.MAINTENANCE: "en maintenance",
    TruckStatus.BROKEN: "en panne",
    TruckStatus.RESERVED: "réservé",
}


def driver_block_reason(driver: DriverD, day: date) -> str | None:
    """RM-03 : permis ou habilitation matières dangereuses expirés à la date J → non affectable.

    Une date d'expiration non renseignée n'est pas bloquante (voir docs/QUESTIONS.md, S8).
    """
    if driver.license_expiry is not None and driver.license_expiry < day:
        return f"Permis de conduire expiré depuis le {driver.license_expiry:%d/%m/%Y}."
    if not driver.hazmat_cert:
        return "Habilitation matières dangereuses absente."
    if driver.hazmat_expiry is not None and driver.hazmat_expiry < day:
        return f"Habilitation matières dangereuses expirée depuis le {driver.hazmat_expiry:%d/%m/%Y}."
    return None


def driver_unavailable_reason(driver: DriverD, day: date) -> str | None:
    """Motif d'indisponibilité d'un chauffeur pour J : RM-03, statut du référentiel ou statut du jour."""
    reason = driver_block_reason(driver, day)
    if reason:
        return reason
    if driver.status != "available":
        return f"Chauffeur indisponible (statut : {driver.status})."
    if not driver.available_today:
        return "Chauffeur marqué indisponible pour la journée."
    return None


def truck_block_reason(truck: TruckD) -> str | None:
    """RM-04 : camion en maintenance, en panne, réservé ou marqué indisponible pour J → non affectable."""
    if truck.status != TruckStatus.AVAILABLE:
        return f"Camion {_TRUCK_STATUS_FR.get(truck.status, truck.status)}."
    if not truck.available_today:
        return "Camion marqué indisponible pour la journée."
    return None
