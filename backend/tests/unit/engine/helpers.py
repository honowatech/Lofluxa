"""Outils des tests du moteur : petits problèmes construits à la main et contrôles indépendants.

`check_invariants` revérifie un résultat SANS passer par `rules.check_plan` (lot L1) ni par le code
du moteur : les horaires sont recalculés à la main à partir de la matrice, les compartiments à
partir du plan de chargement.
"""

from __future__ import annotations

from datetime import date

from app.core.enums import OrderPriority, TruckSize, TruckStatus
from app.planning.domain import (
    CompartmentD,
    DepotD,
    DriverD,
    Matrix,
    OrderD,
    Params,
    PlanningProblem,
    PlanningResult,
    ProductD,
    StationD,
    TruckD,
)
from app.planning.engine.distance_matrix import build_matrix, problem_nodes

H = 3600
DAY = date(2027, 1, 12)
EPS = 1e-6

# Paramètres des petits cas : le solveur converge tout de suite, inutile d'attendre.
FAST = Params(solver_time_limit_s=5, solver_no_improvement_s=2, solver_no_improvement_solutions=200)


def truck(
    truck_id: str,
    capacities: tuple[float, ...] = (6000, 5000, 4000),
    *,
    size: TruckSize = TruckSize.MEDIUM,
    carrier: str | None = "TR",
    allowed: dict[int, set[str]] | None = None,
    status: TruckStatus = TruckStatus.AVAILABLE,
    available_today: bool = True,
) -> TruckD:
    compartments = tuple(
        CompartmentD(
            f"{truck_id}-C{pos}",
            pos,
            float(cap),
            frozenset(allowed[pos]) if allowed and pos in allowed else None,
        )
        for pos, cap in enumerate(capacities, start=1)
    )
    return TruckD(
        truck_id,
        f"LT-{truck_id}",
        size,
        compartments,
        carrier_id=carrier,
        status=status,
        available_today=available_today,
    )


def driver(
    driver_id: str, *, carrier: str | None = "TR", default_truck: str | None = None, **kwargs
) -> DriverD:
    return DriverD(
        driver_id, f"Chauffeur {driver_id}", carrier_id=carrier, default_truck_id=default_truck, **kwargs
    )


def station(
    station_id: str, lat: float, lon: float, *, opening: float = 6, closing: float = 18, **kwargs
) -> StationD:
    kwargs.setdefault("unload_time_min", 30)
    return StationD(
        station_id, station_id, lat, lon, windows=((int(opening * H), int(closing * H)),), **kwargs
    )


def order(
    order_id: str,
    station_id: str,
    volume: float,
    product: str = "SUPER",
    *,
    urgent: bool = False,
    window: tuple[float, float] | None = None,
) -> OrderD:
    return OrderD(
        order_id,
        station_id,
        product,
        float(volume),
        OrderPriority.URGENT if urgent else OrderPriority.NORMAL,
        None if window is None else (int(window[0] * H), int(window[1] * H)),
    )


def make_problem(
    *,
    stations: list[StationD],
    orders: list[OrderD],
    trucks: list[TruckD],
    drivers: list[DriverD] | None = None,
    depots: list[DepotD] | None = None,
    stocks: dict[tuple[str, str], float] | None = None,
    params: Params = FAST,
    **kwargs,
) -> tuple[PlanningProblem, Matrix]:
    """Problème minimal autour de Douala ; par défaut un chauffeur habituel par camion."""
    depots = depots or [DepotD("DEP", "DEP", 4.05, 9.70, windows=((6 * H, 18 * H),), avg_wait_min=30)]
    if drivers is None:
        drivers = [driver(f"DRV-{t.id}", carrier=t.carrier_id, default_truck=t.id) for t in trucks]
    problem = PlanningProblem(
        day=DAY,
        products=[ProductD("SUPER", "SUPER"), ProductD("GASOIL", "GASOIL"), ProductD("PETROLE", "PETROLE")],
        depots=depots,
        stations=stations,
        trucks=trucks,
        drivers=drivers,
        orders=orders,
        depot_stocks=stocks or {},
        params=params,
        **kwargs,
    )
    return problem, build_matrix(problem_nodes(problem), params)


def served_ids(result: PlanningResult) -> set[str]:
    return {d.order_id for t in result.trips for s in t.stops for d in s.deliveries}


def unserved_reasons(result: PlanningResult) -> dict[str, str]:
    return {u.order_id: u.reason_code.value for u in result.unserved}


def _in_windows(value: int, windows) -> bool:
    return any(start <= value <= end for start, end in windows)


def check_invariants(problem: PlanningProblem, matrix: Matrix, result: PlanningResult) -> list[str]:
    """Contrôles indépendants d'un plan. Renvoie la liste des anomalies (vide = plan sain)."""
    errors: list[str] = []
    params = problem.params
    margin = 1 - params.compartment_safety_margin_pct / 100
    orders = {o.id: o for o in problem.orders}
    stations = {s.id: s for s in problem.stations}
    depots = {d.id: d for d in problem.depots}
    trucks = {t.id: t for t in problem.trucks}
    drivers = {d.id: d for d in problem.drivers}
    locked_ids = {id(t) for t in problem.locked_trips}

    # --- aucune commande ne disparaît ni n'est comptée deux fois (F4.4)
    planned: dict[str, float] = {}
    for trip in result.trips:
        for stop in trip.stops:
            for delivery in stop.deliveries:
                if delivery.order_id in planned:
                    errors.append(f"commande {delivery.order_id} livrée deux fois")
                planned[delivery.order_id] = planned.get(delivery.order_id, 0.0) + delivery.planned_l
    unserved = [u.order_id for u in result.unserved]
    if len(unserved) != len(set(unserved)):
        errors.append("commande en double dans unserved")
    for order_id in orders:
        if (order_id in planned) == (order_id in unserved):
            errors.append(f"commande {order_id} : ni servie ni non servie, ou les deux")
    for order_id in [*planned, *unserved]:
        if order_id not in orders:
            errors.append(f"commande inconnue {order_id}")
    urgent_flags = [orders[o].priority == OrderPriority.URGENT for o in unserved if o in orders]
    if urgent_flags != sorted(urgent_flags, reverse=True):
        errors.append("RM-15 : les urgentes ne sont pas en tête des non-servies")

    # --- RM-16 : volume livré ≤ demandé et ≥ seuil de livraison partielle
    for order_id, volume in planned.items():
        requested = orders[order_id].requested_l
        if volume > requested + EPS:
            errors.append(f"RM-16 : {order_id} livrée au-delà du volume demandé")
        if volume + EPS < requested * params.partial_delivery_min_pct / 100:
            errors.append(f"RM-16 : {order_id} livrée sous le seuil partiel")

    seqs = [t.seq for t in result.trips]
    if len(seqs) != len(set(seqs)):
        errors.append("numéros de tournée en double")

    stock_used: dict[tuple[str, str], float] = {}
    loadings: dict[tuple[str, str], int] = {}
    by_truck: dict[str, list] = {}
    by_driver: dict[str, list] = {}
    for trip in result.trips:
        label = f"tournée {trip.seq}"
        is_locked = id(trip) in locked_ids
        truck_d, depot = trucks.get(trip.truck_id), depots.get(trip.depot_id)
        # RM-01
        if truck_d is None or depot is None or trip.driver_id not in drivers:
            errors.append(f"RM-01 : {label} sans camion, chauffeur ou dépôt valide")
            continue
        if not trip.stops:
            errors.append(f"{label} sans arrêt")
        by_truck.setdefault(trip.truck_id, []).append(trip)
        by_driver.setdefault(trip.driver_id, []).append(trip)
        loadings[(trip.truck_id, trip.depot_id)] = loadings.get((trip.truck_id, trip.depot_id), 0) + 1
        for product_id, volume in trip.volumes_by_product().items():
            stock_used[(trip.depot_id, product_id)] = (
                stock_used.get((trip.depot_id, product_id), 0.0) + volume
            )
        if is_locked:
            continue  # RM-17 : rendue telle quelle, non recontrôlée ici

        driver_d = drivers[trip.driver_id]
        # RM-03 / RM-04
        if (
            (driver_d.license_expiry and driver_d.license_expiry < problem.day)
            or not driver_d.hazmat_cert
            or (driver_d.hazmat_expiry and driver_d.hazmat_expiry < problem.day)
            or driver_d.status != "available"
            or not driver_d.available_today
        ):
            errors.append(f"RM-03 : {label} confiée à un chauffeur non affectable")
        if truck_d.status != TruckStatus.AVAILABLE or not truck_d.available_today:
            errors.append(f"RM-04 : {label} sur un camion non affectable")

        # RM-05 / RM-06 / RM-07 : plan de chargement
        compartments = {c.id: c for c in truck_d.compartments}
        loaded: dict[str, float] = {}
        seen: set[str] = set()
        for load in trip.loads:
            compartment = compartments.get(load.compartment_id)
            if compartment is None:
                errors.append(f"{label} : compartiment inconnu {load.compartment_id}")
                continue
            if load.compartment_id in seen:
                errors.append(f"RM-06 : {label}, deux produits dans {load.compartment_id}")
            seen.add(load.compartment_id)
            if load.planned_l > compartment.capacity_l * margin + EPS:
                errors.append(f"RM-05 : {label}, {load.compartment_id} dépasse sa capacité utile")
            if (
                compartment.allowed_product_ids is not None
                and load.product_id not in compartment.allowed_product_ids
            ):
                errors.append(f"RM-07 : {label}, produit interdit dans {load.compartment_id}")
            loaded[load.product_id] = loaded.get(load.product_id, 0.0) + load.planned_l
        delivered = trip.volumes_by_product()
        for product_id in set(loaded) | set(delivered):
            if abs(loaded.get(product_id, 0.0) - delivered.get(product_id, 0.0)) > 1e-2:
                errors.append(f"{label} : chargement ≠ livraisons pour {product_id}")

        # Horaires recalculés à la main ; RM-09, RM-10, RM-11
        wait_min = depot.avg_wait_min if depot.avg_wait_min is not None else params.default_depot_wait_min
        if trip.start_s < params.day_start_s or not _in_windows(trip.start_s, depot.windows):
            errors.append(f"{label} : arrivée au dépôt hors horaires")
        if trip.depart_s != trip.start_s + (wait_min + params.depot_loading_time_min) * 60:
            errors.append(f"{label} : départ ≠ arrivée dépôt + attente + chargement")
        clock, previous, distance = trip.depart_s, depot.id, 0
        for position, stop in enumerate(trip.stops, start=1):
            station_d = stations[stop.station_id]
            if stop.seq != position:
                errors.append(f"{label} : arrêts mal numérotés")
            if truck_d.size.rank > station_d.max_truck_size.rank:
                errors.append(f"RM-09 : {label}, gabarit refusé par {station_d.id}")
            if stop.arrival_s < clock + matrix.duration(previous, station_d.id):
                errors.append(f"{label} : arrivée à {station_d.id} avant la fin du trajet")
            if not _in_windows(stop.arrival_s, station_d.windows):
                errors.append(f"RM-10 : {label}, arrivée à {station_d.id} hors horaires")
            for delivery in stop.deliveries:
                window = orders[delivery.order_id].window
                if orders[delivery.order_id].station_id != station_d.id:
                    errors.append(f"{label} : {delivery.order_id} livrée à la mauvaise station")
                if window is not None and not window[0] <= stop.arrival_s <= window[1]:
                    errors.append(f"RM-10 : {label}, {delivery.order_id} hors fenêtre de commande")
            unload_min = (
                station_d.unload_time_min
                if station_d.unload_time_min is not None
                else params.default_unload_time_min
            )
            if stop.departure_s != stop.arrival_s + unload_min * 60:
                errors.append(f"{label} : départ de {station_d.id} ≠ arrivée + dépotage")
            distance += matrix.distance(previous, station_d.id)
            clock, previous = stop.departure_s, station_d.id
        if trip.return_s != clock + matrix.duration(previous, depot.id):
            errors.append(f"{label} : heure de retour incohérente")
        if trip.distance_m != distance + matrix.distance(previous, depot.id):
            errors.append(f"{label} : distance incohérente")
        if trip.return_s - trip.depart_s > params.max_service_s:
            errors.append(f"RM-11 : {label} dépasse la durée max de service")

    # --- RM-02 : pas de chevauchement par camion ni par chauffeur
    for kind, groups in (("camion", by_truck), ("chauffeur", by_driver)):
        for key, trips in groups.items():
            ordered = sorted(trips, key=lambda t: t.start_s)
            for first, second in zip(ordered, ordered[1:], strict=False):
                if second.start_s < first.return_s:
                    errors.append(f"RM-02 : {kind} {key} sur deux tournées qui se chevauchent")
    # --- RM-11 : cumul journalier par chauffeur
    for driver_id, trips in by_driver.items():
        if sum(t.return_s - t.depart_s for t in trips) > params.max_service_s:
            errors.append(f"RM-11 : cumul journalier dépassé pour {driver_id}")
    # --- RM-14 : nombre de chargements par camion et par dépôt
    for (truck_id, depot_id), count in loadings.items():
        if count > problem.max_loadings(depots[depot_id]):
            errors.append(f"RM-14 : {truck_id} dépasse le nombre de chargements à {depot_id}")
    # --- RM-08 : stock dépôt
    for key, volume in stock_used.items():
        if key in problem.depot_stocks and volume > problem.depot_stocks[key] + EPS:
            errors.append(f"RM-08 : stock dépassé pour {key}")
    return errors
