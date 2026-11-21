"""Affectation des chauffeurs en post-traitement (spec §7.3).

Ordre de préférence pour chaque tournée :
  1. le chauffeur affecté au camion pour la journée (`problem.driver_by_truck`, F2.4) ;
  2. le chauffeur habituel du camion (`DriverD.default_truck_id`) ;
  3. un chauffeur qui conduit déjà ce camion dans la journée, sinon le premier chauffeur
     disponible du même transporteur ;
en respectant RM-02 (pas de chevauchement), RM-03 (permis, habilitation) et RM-11 (cumul journalier).
"""

from __future__ import annotations

from app.planning.domain import DriverD, PlanningProblem, TripD, TruckD
from app.planning.violations.eligibility import driver_unavailable_reason


def eligible_drivers(problem: PlanningProblem) -> list[DriverD]:
    """Chauffeurs affectables le jour J (RM-03, statut, disponibilité du jour), dans l'ordre du problème."""
    return [d for d in problem.drivers if driver_unavailable_reason(d, problem.day) is None]


def _preferred(
    problem: PlanningProblem, truck_id: str, eligible: dict[str, DriverD]
) -> tuple[str | None, list[str]]:
    assigned = problem.driver_by_truck.get(truck_id)
    assigned = assigned if assigned in eligible else None
    usual = [d.id for d in eligible.values() if d.default_truck_id == truck_id and d.id != assigned]
    return assigned, usual


def drivable_truck_ids(problem: PlanningProblem, trucks: list[TruckD]) -> set[str]:
    """Camions pouvant recevoir un chauffeur pour la journée (un chauffeur distinct par camion).

    Évite au solveur de bâtir des tournées sur des camions que personne ne pourra conduire.
    Même ordre de préférence que l'affectation finale ; les camions sans chauffeur désigné ni
    habituel se partagent ensuite les chauffeurs restants de leur transporteur.
    """
    eligible = {d.id: d for d in eligible_drivers(problem)}
    taken: set[str] = set()
    matched: set[str] = set()
    preferences = {t.id: _preferred(problem, t.id, eligible) for t in trucks}
    for truck in trucks:  # 1. chauffeur du jour
        assigned = preferences[truck.id][0]
        if assigned is not None and assigned not in taken:
            taken.add(assigned)
            matched.add(truck.id)
    for truck in trucks:  # 2. chauffeur habituel
        if truck.id in matched:
            continue
        usual = next((d for d in preferences[truck.id][1] if d not in taken), None)
        if usual is not None:
            taken.add(usual)
            matched.add(truck.id)
    for truck in trucks:  # 3. premier chauffeur libre du même transporteur
        if truck.id in matched:
            continue
        spare = next(
            (d.id for d in eligible.values() if d.id not in taken and d.carrier_id == truck.carrier_id), None
        )
        if spare is not None:
            taken.add(spare)
            matched.add(truck.id)
    return matched


class _Agenda:
    """Occupation des chauffeurs : intervalles [arrivée dépôt, retour dépôt] et cumul de service."""

    def __init__(self, max_service_s: int) -> None:
        self._max_service_s = max_service_s
        self._slots: dict[str, list[tuple[int, int, str]]] = {}
        self._worked: dict[str, int] = {}

    def book(self, driver_id: str, trip: TripD) -> None:
        self._slots.setdefault(driver_id, []).append((trip.start_s, trip.return_s, trip.truck_id))
        self._worked[driver_id] = self._worked.get(driver_id, 0) + max(0, trip.return_s - trip.depart_s)

    def can_take(self, driver_id: str, trip: TripD) -> bool:
        duration = max(0, trip.return_s - trip.depart_s)
        if self._worked.get(driver_id, 0) + duration > self._max_service_s:  # RM-11
            return False
        return all(  # RM-02
            trip.return_s <= start or end <= trip.start_s for start, end, _ in self._slots.get(driver_id, [])
        )

    def drives(self, driver_id: str, truck_id: str) -> bool:
        return any(truck == truck_id for _, _, truck in self._slots.get(driver_id, []))


def assign_drivers(
    problem: PlanningProblem, trips: list[TripD], fixed_trips: list[TripD] | None = None
) -> list[TripD]:
    """Affecte un chauffeur à chaque tournée de `trips` (horaires à jour) et renvoie celles restées sans.

    `fixed_trips` : tournées déjà pourvues qu'on ne touche pas (verrouillées, RM-17) mais dont les
    chauffeurs sont occupés d'autant. Les affectations existantes de `trips` sont recalculées.
    """
    eligible = {d.id: d for d in eligible_drivers(problem)}
    trucks = {t.id: t for t in problem.trucks}
    agenda = _Agenda(problem.params.max_service_s)
    for trip in fixed_trips or []:
        if trip.driver_id is not None:
            agenda.book(trip.driver_id, trip)

    ordered = sorted(trips, key=lambda t: (t.start_s, t.truck_id, t.seq))
    for trip in ordered:
        trip.driver_id = None

    def take(trip: TripD, driver_id: str | None) -> bool:
        if driver_id is None or driver_id not in eligible or not agenda.can_take(driver_id, trip):
            return False
        agenda.book(driver_id, trip)
        trip.driver_id = driver_id
        return True

    preferences = {t.truck_id: _preferred(problem, t.truck_id, eligible) for t in ordered}
    for trip in ordered:  # 1. chauffeur du jour
        take(trip, preferences[trip.truck_id][0])
    for trip in ordered:  # 2. chauffeur habituel
        if trip.driver_id is None:
            for driver_id in preferences[trip.truck_id][1]:
                if take(trip, driver_id):
                    break
    for trip in ordered:  # 3. même transporteur
        if trip.driver_id is not None:
            continue
        truck = trucks.get(trip.truck_id)
        carrier_id = truck.carrier_id if truck is not None else None
        pool = [d.id for d in eligible.values() if d.carrier_id == carrier_id]
        pool.sort(key=lambda d: not agenda.drives(d, trip.truck_id))  # tri stable : continuité d'abord
        for driver_id in pool:
            if take(trip, driver_id):
                break
    return [trip for trip in ordered if trip.driver_id is None]
