"""Repêchage des commandes laissées de côté par le solveur ou retirées au contrôle.

Insertion au moindre coût dans une tournée existante ou dans une nouvelle tournée, avec les mêmes
contrôles que le reste du moteur (compartiments, stocks, horaires, chauffeurs). C'est aussi ici que
la livraison partielle (RM-16) est tentée : volume maximal livrable, s'il atteint le seuil paramétré.
"""

from __future__ import annotations

import copy
import math

from app.planning.domain import DeliveryD, StopD, TripD, TruckD
from app.planning.engine import objective
from app.planning.engine.context import Candidate, Context
from app.planning.engine.drivers import assign_drivers
from app.planning.engine.plan_builder import Plan, can_share_stop
from app.planning.engine.scheduling import schedule_truck_day

# Nombre maximal d'insertions essayées par commande (borne technique du temps de calcul).
MAX_TRIES_PER_ORDER = 40


def deliverable_l(
    ctx: Context, truck: TruckD, depot_id: str, volumes: dict[str, float], cand: Candidate
) -> float:
    """Volume maximal de la commande livrable par ce camion depuis ce dépôt (0 si sous le seuil RM-16)."""
    product_id = cand.order.product_id
    ceiling = min(cand.volume_l, ctx.stock_left(depot_id, product_id))
    if ceiling <= 0 or ceiling + 1e-6 < cand.min_volume_l:
        return 0.0

    def fits(volume: float) -> bool:
        trial = dict(volumes)
        trial[product_id] = trial.get(product_id, 0.0) + volume
        return ctx.fits(truck, trial)

    if fits(ceiling):
        return ceiling
    low, high = math.ceil(cand.min_volume_l), math.floor(ceiling)
    if low > high or not fits(low):
        return 0.0
    while low < high:
        middle = (low + high + 1) // 2
        if fits(middle):
            low = middle
        else:
            high = middle - 1
    return float(low)


def _positions(ctx: Context, trip: TripD, cand: Candidate) -> list[tuple[int, str, int]]:
    """Insertions possibles dans une tournée : (surcoût, type, position)."""
    matrix, params = ctx.matrix, ctx.params
    station_id = cand.order.station_id
    options: list[tuple[int, str, int]] = []
    for index, stop in enumerate(trip.stops):
        if can_share_stop(ctx, stop, cand):
            options.append((0, "merge", index))
    path = [trip.depot_id, *[s.station_id for s in trip.stops], trip.depot_id]
    for index in range(len(trip.stops) + 1):
        before, after = path[index], path[index + 1]
        extra = (
            matrix.distance(before, station_id)
            + matrix.distance(station_id, after)
            - matrix.distance(before, after)
        )
        options.append((objective.arc_cost(extra, params), "stop", index))
    return options


def _try(ctx: Context, plan: Plan, cand: Candidate, option) -> bool:
    volume, _, truck_id, trip_index, kind, position = option
    volume = -volume
    order = cand.order
    day = copy.deepcopy(plan.days.get(truck_id, []))
    delivery = DeliveryD(order.id, order.product_id, volume)
    if kind == "new":
        trip = TripD(seq=0, truck_id=truck_id, depot_id=position)
        trip.stops = [StopD(seq=1, station_id=order.station_id, deliveries=[delivery])]
        day.append(trip)
    elif kind == "merge":
        day[trip_index].stops[int(position)].deliveries.append(delivery)
    else:
        stops = day[trip_index].stops
        stops.insert(int(position), StopD(seq=0, station_id=order.station_id, deliveries=[delivery]))
    if schedule_truck_day(ctx, day):
        return False

    others = [t for other_id, trips in plan.days.items() if other_id != truck_id for t in trips]
    saved = [(t, t.driver_id) for t in others]
    if assign_drivers(ctx.problem, others + day, ctx.problem.locked_trips):
        for trip, driver_id in saved:
            trip.driver_id = driver_id
        return False
    plan.days[truck_id] = day
    depot_id = position if kind == "new" else day[trip_index].depot_id
    key = (depot_id, order.product_id)
    if key in ctx.stock:
        ctx.stock[key] = max(0.0, ctx.stock[key] - volume)
    return True


def _place(ctx: Context, plan: Plan, cand: Candidate) -> bool:
    matrix, params = ctx.matrix, ctx.params
    station_id = cand.order.station_id
    options: list[tuple] = []
    for truck_id, day in plan.days.items():
        if truck_id not in cand.truck_ids:
            continue
        truck = ctx.trucks[truck_id]
        for trip_index, trip in enumerate(day):
            volume = deliverable_l(ctx, truck, trip.depot_id, trip.volumes_by_product(), cand)
            if volume <= 0:
                continue
            for cost, kind, position in _positions(ctx, trip, cand):
                options.append((-volume, cost, truck_id, trip_index, kind, str(position)))
    for truck in ctx.usable_trucks:
        if truck.id not in cand.truck_ids:
            continue
        day = plan.days.get(truck.id, [])
        tied = {t.depot_id for t in day} | {t.depot_id for t in ctx.locked_by_truck.get(truck.id, [])}
        for depot in ctx.problem.depots:
            if tied and depot.id not in tied:
                continue  # un seul dépôt par camion et par jour
            if not ctx.depot_start_windows(depot.id):
                continue
            if sum(1 for t in day if t.depot_id == depot.id) >= ctx.free_loadings(truck.id, depot.id):
                continue  # RM-14
            volume = deliverable_l(ctx, truck, depot.id, {}, cand)
            if volume <= 0:
                continue
            distance = matrix.distance(depot.id, station_id) + matrix.distance(station_id, depot.id)
            cost = objective.arc_cost(distance, params) + objective.vehicle_fixed_cost(params)
            options.append((-volume, cost, truck.id, len(day), "new", depot.id))
    options.sort()
    return any(_try(ctx, plan, cand, option) for option in options[:MAX_TRIES_PER_ORDER])


def rescue(ctx: Context, plan: Plan, pending: list[Candidate]) -> list[Candidate]:
    """Tente de servir les commandes en attente (urgentes d'abord) ; renvoie celles qui restent."""
    left: list[Candidate] = []
    for cand in sorted(pending, key=lambda c: not c.urgent):  # tri stable : ordre d'entrée conservé
        if not _place(ctx, plan, cand):
            left.append(cand)
    return left
