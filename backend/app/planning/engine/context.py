"""Préparation d'un calcul : ressources utilisables, déductions des tournées verrouillées (RM-17),
commandes planifiables et commandes écartées d'emblée avec leur raison (F4.4)."""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from app.core.enums import OrderPriority, UnservedReason
from app.planning.domain import (
    DeliveryD,
    DepotD,
    Matrix,
    OrderD,
    Params,
    PlanningProblem,
    StationD,
    StopD,
    TripD,
    TruckD,
    UnservedD,
    Window,
)
from app.planning.engine.compartments import assign_compartments, product_capacity_l
from app.planning.engine.drivers import drivable_truck_ids
from app.planning.timing import stop_windows


@dataclass(frozen=True, slots=True)
class Candidate:
    """Commande planifiable : volume retenu (≤ demandé, RM-16), fenêtres et camions compatibles."""

    order: OrderD
    volume_l: float
    min_volume_l: float  # plancher de livraison partielle (RM-16)
    windows: tuple[Window, ...]
    truck_ids: frozenset[str]

    @property
    def urgent(self) -> bool:
        return self.order.priority == OrderPriority.URGENT


@dataclass(slots=True)
class Context:
    problem: PlanningProblem
    matrix: Matrix
    params: Params
    stations: dict[str, StationD]
    depots: dict[str, DepotD]
    trucks: dict[str, TruckD]
    orders: dict[str, OrderD]
    usable_trucks: list[TruckD]  # affectables (RM-04) et pouvant recevoir un chauffeur (RM-03)
    driverless_trucks: list[TruckD]  # affectables mais sans chauffeur possible
    stock: dict[tuple[str, str], float]  # stock restant par (dépôt, produit), tournées verrouillées déduites
    locked_by_truck: dict[str, list[TripD]]
    locked_order_ids: set[str]
    _fit_cache: dict[tuple, bool] = field(default_factory=dict)

    @property
    def margin_pct(self) -> float:
        return self.params.compartment_safety_margin_pct

    def wait_load_s(self, depot_id: str) -> int:
        """Attente + chargement au dépôt : délai entre l'arrivée au dépôt et le départ."""
        return self.problem.depot_wait_s(self.depots[depot_id]) + self.problem.loading_s()

    def unload_s(self, station_id: str) -> int:
        return self.problem.unload_s(self.stations[station_id])

    def stock_left(self, depot_id: str, product_id: str) -> float:
        """Stock restant ; infini si non renseigné (RM-08 : simple avertissement)."""
        return self.stock.get((depot_id, product_id), math.inf)

    def fits(self, truck: TruckD, volumes: dict[str, float]) -> bool:
        """Vrai si les volumes tiennent dans les compartiments du camion (RM-05/06/07), avec mémoire."""
        key = (truck.id, tuple(sorted((p, round(v, 3)) for p, v in volumes.items() if v > 0)))
        cached = self._fit_cache.get(key)
        if cached is None:
            cached = assign_compartments(truck, volumes, self.margin_pct) is not None
            self._fit_cache[key] = cached
        return cached

    def locked_loadings(self, truck_id: str, depot_id: str) -> int:
        return sum(1 for t in self.locked_by_truck.get(truck_id, []) if t.depot_id == depot_id)

    def free_loadings(self, truck_id: str, depot_id: str) -> int:
        """RM-14 : chargements encore possibles pour ce camion à ce dépôt."""
        return self.problem.max_loadings(self.depots[depot_id]) - self.locked_loadings(truck_id, depot_id)

    def locked_duration_s(self, truck_id: str) -> int:
        return sum(max(0, t.return_s - t.depart_s) for t in self.locked_by_truck.get(truck_id, []))

    def depot_start_windows(self, depot_id: str) -> list[Window]:
        """Créneaux d'arrivée au dépôt admissibles : horaires du dépôt à partir du début de journée."""
        day_start = self.params.day_start_s
        return [
            (max(s, day_start), e) for s, e in sorted(self.depots[depot_id].windows) if e >= max(s, day_start)
        ]


def order_windows(problem: PlanningProblem, order: OrderD) -> tuple[Window, ...]:
    """Fenêtres d'arrivée admissibles d'une commande seule (RM-10) — même calcul que `timing`."""
    probe = StopD(seq=1, station_id=order.station_id, deliveries=[DeliveryD(order.id, order.product_id, 0.0)])
    return stop_windows(problem, probe)


def build_context(problem: PlanningProblem, matrix: Matrix) -> Context:
    stock = dict(problem.depot_stocks)
    locked_by_truck: dict[str, list[TripD]] = {}
    locked_order_ids: set[str] = set()
    for trip in problem.locked_trips:
        locked_by_truck.setdefault(trip.truck_id, []).append(trip)
        volumes = trip.volumes_by_product()
        if not volumes:  # tournée verrouillée décrite seulement par son plan de chargement
            for load in trip.loads:
                volumes[load.product_id] = volumes.get(load.product_id, 0.0) + load.planned_l
        for product_id, volume in volumes.items():
            key = (trip.depot_id, product_id)
            if key in stock:
                stock[key] = max(0.0, stock[key] - volume)
        for stop in trip.stops:
            locked_order_ids.update(d.order_id for d in stop.deliveries)

    affectable = [t for t in problem.trucks if t.affectable and t.compartments]
    drivable = drivable_truck_ids(problem, affectable)
    return Context(
        problem=problem,
        matrix=matrix,
        params=problem.params,
        stations={s.id: s for s in problem.stations},
        depots={d.id: d for d in problem.depots},
        trucks={t.id: t for t in problem.trucks},
        orders={o.id: o for o in problem.orders},
        usable_trucks=[t for t in affectable if t.id in drivable],
        driverless_trucks=[t for t in affectable if t.id not in drivable],
        stock=stock,
        locked_by_truck=locked_by_truck,
        locked_order_ids=locked_order_ids,
    )


def _liters(volume: float) -> str:
    return f"{volume:,.0f}".replace(",", " ") + " L"


def classify_orders(ctx: Context) -> tuple[list[Candidate], list[UnservedD]]:
    """Sépare les commandes planifiables de celles qu'aucune tournée ne peut servir, raison à l'appui."""
    problem, params, matrix = ctx.problem, ctx.params, ctx.matrix
    candidates: list[Candidate] = []
    rejected: list[UnservedD] = []
    known_nodes = set(matrix.node_ids)

    def reject(order: OrderD, reason: UnservedReason, text: str) -> None:
        rejected.append(UnservedD(order.id, reason, text))

    for order in problem.orders:
        if order.id in ctx.locked_order_ids:
            continue  # déjà servie par une tournée verrouillée (RM-17)
        station = ctx.stations.get(order.station_id)
        if station is None or order.station_id not in known_nodes:
            reject(
                order,
                UnservedReason.OTHER,
                "Station inconnue du calcul (référentiel ou matrice de distances).",
            )
            continue
        if order.requested_l <= 0:
            reject(order, UnservedReason.OTHER, "Volume demandé nul ou négatif.")
            continue
        min_volume = order.requested_l * params.partial_delivery_min_pct / 100.0

        # --- camions : RM-04, chauffeur, RM-09, RM-07/RM-05
        if not ctx.usable_trucks:
            if ctx.driverless_trucks:
                reject(
                    order,
                    UnservedReason.NO_DRIVER,
                    "Aucun chauffeur affectable pour les camions disponibles.",
                )
            else:
                reject(order, UnservedReason.NO_TRUCK, "Aucun camion affectable ce jour.")
            continue
        sized = [t for t in ctx.usable_trucks if t.size.rank <= station.max_truck_size.rank]
        if not sized:
            if any(t.size.rank <= station.max_truck_size.rank for t in ctx.driverless_trucks):
                reject(
                    order, UnservedReason.NO_DRIVER, "Les camions au gabarit accepté n'ont pas de chauffeur."
                )
            else:
                reject(
                    order,
                    UnservedReason.TRUCK_SIZE,
                    "Aucun camion disponible au gabarit accepté par la station "
                    f"({station.max_truck_size.value} au maximum).",
                )
            continue
        capacities = {t.id: product_capacity_l(t, order.product_id, ctx.margin_pct) for t in sized}
        best_capacity = max(capacities.values())
        if best_capacity < min_volume or best_capacity <= 0:
            reject(
                order,
                UnservedReason.COMPARTMENT,
                "Aucun camion compatible n'a de compartiments suffisants pour ce produit "
                f"(au mieux {_liters(best_capacity)}).",
            )
            continue

        # --- fenêtres (RM-10) et durée de service (RM-11), depuis le dépôt le plus favorable
        windows = order_windows(problem, order)
        if not windows:
            reject(
                order,
                UnservedReason.TIME_WINDOW,
                "La fenêtre de la commande ne recoupe pas les horaires de la station.",
            )
            continue
        unload = ctx.unload_s(station.id)
        in_time = False
        in_duration = False
        depot_open = False
        stocks: list[float] = []
        for depot in problem.depots:
            starts = ctx.depot_start_windows(depot.id)
            if not starts:
                continue
            depot_open = True
            go, back = matrix.duration(depot.id, station.id), matrix.duration(station.id, depot.id)
            duration_ok = go + unload + back <= params.max_service_s
            time_ok = starts[0][0] + ctx.wait_load_s(depot.id) + go <= windows[-1][1]
            in_time = in_time or time_ok
            in_duration = in_duration or duration_ok
            if time_ok and duration_ok:
                stocks.append(ctx.stock_left(depot.id, order.product_id))
        if not stocks:
            if not depot_open:
                reject(order, UnservedReason.OTHER, "Aucun dépôt n'est ouvert ce jour.")
            elif not in_duration:
                reject(
                    order,
                    UnservedReason.SERVICE_DURATION,
                    "L'aller-retour depuis le dépôt le plus proche dépasse la durée maximale de service.",
                )
            else:
                reject(
                    order,
                    UnservedReason.TIME_WINDOW,
                    "Impossible d'arriver dans la fenêtre de réception, même en partant dès l'ouverture.",
                )
            continue

        # --- stock dépôt (RM-08)
        best_stock = max(stocks)
        if best_stock < min_volume or best_stock <= 0:
            reject(
                order,
                UnservedReason.DEPOT_STOCK,
                f"Stock dépôt insuffisant pour ce produit (au mieux {_liters(best_stock)} disponibles).",
            )
            continue

        volume = min(order.requested_l, best_capacity, best_stock)
        candidates.append(
            Candidate(
                order=order,
                volume_l=volume,
                min_volume_l=min(min_volume, volume),
                windows=windows,
                truck_ids=frozenset(tid for tid, cap in capacities.items() if cap >= min_volume and cap > 0),
            )
        )
    return candidates, rejected
