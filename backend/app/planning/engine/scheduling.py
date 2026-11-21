"""Horaires finaux des tournées calculées — toujours via `timing.schedule_trip` (source unique).

Le moteur ne choisit que l'heure d'arrivée au dépôt (`start_s`) : au plus tôt pour rentrer au plus
tôt, puis retardée tant que le retour ne bouge pas, afin de ne pas faire attendre le camion devant
une station fermée (durée de service minimale, RM-11).
"""

from __future__ import annotations

from dataclasses import replace

from app.core.enums import UnservedReason
from app.planning.domain import PlanningProblem, TripD
from app.planning.engine.context import Context
from app.planning.timing import lateness_s, schedule_trip, stop_windows


def trip_problem(ctx: Context, trip: TripD) -> PlanningProblem:
    """Vue réduite du problème (stations et commandes de la tournée) : mêmes résultats, calcul plus rapide."""
    station_ids = {stop.station_id for stop in trip.stops}
    order_ids = {d.order_id for stop in trip.stops for d in stop.deliveries}
    return replace(
        ctx.problem,
        stations=[ctx.stations[s] for s in station_ids],
        orders=[ctx.orders[o] for o in order_ids if o in ctx.orders],
        depots=[ctx.depots[trip.depot_id]],
        locked_trips=[],
    )


def _in_windows(value: int, windows) -> bool:
    return any(start <= value <= end for start, end in windows)


def _waiting_s(ctx: Context, trip: TripD) -> int:
    """Attente cumulée devant les stations (arrivée avant l'ouverture)."""
    total, clock, previous = 0, trip.depart_s, trip.depot_id
    for stop in trip.stops:
        total += stop.arrival_s - (clock + ctx.matrix.duration(previous, stop.station_id))
        clock, previous = stop.departure_s, stop.station_id
    return total


def _shift_to_next_window(problem: PlanningProblem, trip: TripD, tolerance_s: int) -> int | None:
    """Décalage du départ qui amène le premier arrêt « en retard toléré » dans sa plage suivante."""
    for stop in trip.stops:
        windows = stop_windows(problem, stop)
        if lateness_s(stop.arrival_s, windows) <= 0:
            continue
        missed = max((w for w in windows if w[1] < stop.arrival_s), key=lambda w: w[1], default=None)
        if missed is None or not any(start > stop.arrival_s for start, _ in windows):
            return None
        return missed[1] + tolerance_s + 1 - stop.arrival_s
    return None


def schedule_packed(ctx: Context, trip: TripD, min_start_s: int) -> TripD:
    """Planifie `trip` au plus tôt à partir de `min_start_s`, puis retarde l'arrivée au dépôt tant
    que l'heure de retour reste la même."""
    problem = trip_problem(ctx, trip)
    matrix = ctx.matrix
    schedule_trip(trip, problem, matrix, start_s=min_start_s)
    # `timing` sert un arrêt atteint juste après la fermeture (tolérance RM-10) au lieu d'attendre la
    # plage suivante de la station : on décale alors le départ pour arriver dans cette plage suivante.
    tolerance_s = ctx.params.window_tolerance_min * 60
    for _ in range(sum(len(stop_windows(problem, stop)) for stop in trip.stops)):
        shift = _shift_to_next_window(problem, trip, tolerance_s)
        if shift is None:
            break
        schedule_trip(trip, problem, matrix, start_s=trip.start_s + shift)
    waiting = _waiting_s(ctx, trip)
    if waiting <= 0:
        return trip
    depot_windows = ctx.depot_start_windows(trip.depot_id)
    target_return = trip.return_s
    low, high = trip.start_s, trip.start_s + waiting
    while low < high:
        middle = (low + high + 1) // 2
        schedule_trip(trip, problem, matrix, start_s=middle)
        if trip.return_s == target_return and _in_windows(trip.start_s, depot_windows):
            low = max(middle, trip.start_s)
        else:
            high = middle - 1
    schedule_trip(trip, problem, matrix, start_s=low)
    return trip


def trip_issue(ctx: Context, trip: TripD) -> tuple[UnservedReason, int | None] | None:
    """Contrôle d'une tournée planifiée : `None` si faisable, sinon (raison, indice de l'arrêt fautif)."""
    if not _in_windows(trip.start_s, ctx.depot_start_windows(trip.depot_id)):
        return UnservedReason.TIME_WINDOW, None
    problem = trip_problem(ctx, trip)
    for index, stop in enumerate(trip.stops):
        if lateness_s(stop.arrival_s, stop_windows(problem, stop)) > 0:
            return UnservedReason.TIME_WINDOW, index
    if trip.return_s - trip.depart_s > ctx.params.max_service_s:
        return UnservedReason.SERVICE_DURATION, None
    return None


def overlaps(a: TripD, b: TripD) -> bool:
    return a.start_s < b.return_s and b.start_s < a.return_s


def schedule_truck_day(ctx: Context, trips: list[TripD]) -> list[tuple[TripD, UnservedReason, int | None]]:
    """Planifie dans l'ordre les tournées (non verrouillées) d'un même camion, sans chevauchement
    entre elles ni avec ses tournées verrouillées (RM-02), et renvoie les tournées infaisables."""
    issues: list[tuple[TripD, UnservedReason, int | None]] = []
    if not trips:
        return issues
    locked = sorted(ctx.locked_by_truck.get(trips[0].truck_id, []), key=lambda t: t.start_s)
    min_start = ctx.params.day_start_s
    for trip in trips:
        schedule_packed(ctx, trip, min_start)
        for _ in range(len(locked)):
            clash = next((other for other in locked if overlaps(trip, other)), None)
            if clash is None:
                break
            schedule_packed(ctx, trip, clash.return_s)
        issue = trip_issue(ctx, trip)
        if issue is None and any(overlaps(trip, other) for other in locked):
            issue = (UnservedReason.TIME_WINDOW, None)
        if issue is not None:
            issues.append((trip, issue[0], issue[1]))
        min_start = max(min_start, trip.return_s)
    return issues
