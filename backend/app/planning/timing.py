"""Calcul des horaires d'une tournée à partir de sa séquence d'arrêts — source unique.

Utilisé par le moteur (horaires finaux d'une solution) ET par l'édition manuelle (F5.2 : toute
modification recalcule immédiatement distances, durées et heures estimées). Les deux chemins
produisent ainsi exactement les mêmes heures pour une même séquence.

Ce module ne juge pas : il calcule. Les dépassements (RM-10, RM-11) sont constatés par
`app.planning.violations.rules`.
"""

from __future__ import annotations

from app.planning.domain import Matrix, PlanningProblem, StopD, TripD, Window


def stop_windows(problem: PlanningProblem, stop: StopD) -> tuple[Window, ...]:
    """Fenêtres admissibles d'un arrêt : horaires de la station ∩ fenêtres des commandes livrées."""
    windows = list(problem.station(stop.station_id).windows)
    orders_by_id = {o.id: o for o in problem.orders}
    for delivery in stop.deliveries:
        order = orders_by_id.get(delivery.order_id)
        if order is None or order.window is None:
            continue
        o_start, o_end = order.window
        windows = [(max(s, o_start), min(e, o_end)) for s, e in windows if max(s, o_start) <= min(e, o_end)]
    return tuple(sorted(windows))


def earliest_service_start(arrival_s: int, windows: tuple[Window, ...], tolerance_s: int) -> int:
    """Heure de début de service : on attend l'ouverture si on arrive en avance.

    Si l'arrivée dépasse la fin de toutes les fenêtres (tolérance comprise), on sert à l'arrivée :
    la violation RM-10 sera constatée par les règles.
    """
    for start, end in windows:
        if arrival_s <= end + tolerance_s:
            return max(arrival_s, start)
    return arrival_s


def lateness_s(arrival_s: int, windows: tuple[Window, ...]) -> int:
    """Retard par rapport à la fenêtre la plus favorable (0 si l'arrivée tombe dans une fenêtre).

    Renvoie un grand nombre s'il n'existe aucune fenêtre (station fermée ce jour-là)."""
    if not windows:
        return 10**9
    best = None
    for start, end in windows:
        if start <= arrival_s <= end:
            return 0
        if arrival_s > end:
            late = arrival_s - end
            best = late if best is None else min(best, late)
    return best or 0


def schedule_trip(
    trip: TripD,
    problem: PlanningProblem,
    matrix: Matrix,
    *,
    start_s: int | None = None,
) -> TripD:
    """Recalcule en place les horaires et distances de `trip` et la renvoie.

    `start_s` : arrivée au dépôt pour chargement. Par défaut `trip.start_s`, borné par le début
    de journée et l'ouverture du dépôt. Chronologie :

        start_s → (attente dépôt + chargement) → depart_s → arrêt 1 … arrêt n → return_s

    À chaque arrêt : `arrival_s` = début de service (après attente éventuelle de l'ouverture),
    `departure_s` = arrival_s + temps de dépotage de la station.
    """
    depot = problem.depot(trip.depot_id)
    params = problem.params
    tolerance_s = params.window_tolerance_min * 60

    begin = trip.start_s if start_s is None else start_s
    begin = max(begin, params.day_start_s)
    begin = earliest_service_start(begin, depot.windows, 0)

    trip.start_s = begin
    trip.depart_s = begin + problem.depot_wait_s(depot) + problem.loading_s()

    clock = trip.depart_s
    previous = depot.id
    total_distance = 0
    for index, stop in enumerate(trip.stops, start=1):
        station = problem.station(stop.station_id)
        leg_distance = matrix.distance(previous, station.id)
        raw_arrival = clock + matrix.duration(previous, station.id)
        stop.seq = index
        stop.distance_from_prev_m = leg_distance
        stop.arrival_s = earliest_service_start(raw_arrival, stop_windows(problem, stop), tolerance_s)
        stop.departure_s = stop.arrival_s + problem.unload_s(station)
        total_distance += leg_distance
        clock = stop.departure_s
        previous = station.id

    total_distance += matrix.distance(previous, depot.id)
    trip.return_s = clock + matrix.duration(previous, depot.id)
    trip.distance_m = total_distance
    trip.duration_s = trip.return_s - trip.depart_s
    return trip
