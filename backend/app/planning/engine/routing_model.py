"""Modèle OR-Tools Routing du problème de tournées (spec §7.3).

Un « véhicule » OR-Tools = (camion, dépôt, rang de la tournée dans la journée). Dimensions :
  - `time`  : cumul au départ = arrivée au dépôt (`start_s`) ; le premier trajet inclut l'attente et
              le chargement ; cumul à un arrêt = début du dépotage ; cumul à l'arrivée = retour ;
  - `work`  : conduite + dépotage, sans les attentes — borne le cumul journalier par camion (RM-11) ;
  - une dimension de volume par produit + une dimension de volume total (capacités, RM-05/RM-07).
Contraintes transversales : chaînage temporel des tournées d'un camion, un seul dépôt par camion et
par jour, stocks dépôt (RM-08), tournées verrouillées (RM-17), compartiments exacts (RM-05/06/07).
"""

from __future__ import annotations

import math
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

from app.planning.domain import DAY_S, DepotD, TruckD
from app.planning.engine import objective
from app.planning.engine.compartments import product_capacity_l, total_capacity_l
from app.planning.engine.context import Candidate, Context

# Garde-fou de la première solution : PATH_CHEAPEST_ARC explore en profondeur et peut s'enliser quand
# toutes les commandes ne peuvent pas être servies. Au-delà de ce nombre d'échecs sans première
# solution, on bascule sur une heuristique d'insertion (constante technique, sans portée métier).
FIRST_SOLUTION_FAILURES_BASE = 2_000
FIRST_SOLUTION_FAILURES_PER_NODE = 100
# Le solveur interroge sa limite très souvent : on ne regarde l'horloge qu'une fois sur N.
LIMIT_CHECK_PERIOD = 64

_STATUS_NAMES = {
    0: "ROUTING_NOT_SOLVED",
    1: "ROUTING_SUCCESS",
    2: "ROUTING_PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED",
    3: "ROUTING_FAIL",
    4: "ROUTING_FAIL_TIMEOUT",
    5: "ROUTING_INVALID",
    6: "ROUTING_INFEASIBLE",
    7: "ROUTING_OPTIMAL",
}


@dataclass(frozen=True, slots=True)
class VehicleSlot:
    truck: TruckD
    depot: DepotD
    rank: int  # rang chronologique parmi les tournées du camion à ce dépôt (0 = la première)


@dataclass(slots=True)
class Route:
    truck_id: str
    depot_id: str
    rank: int
    order_ids: list[str]


@dataclass(slots=True)
class RoutingOutcome:
    routes: list[Route]
    dropped: list[str]  # commandes candidates non routées
    log: dict = field(default_factory=dict)


def build_slots(ctx: Context, slot_caps: dict[str, int] | None = None) -> list[VehicleSlot]:
    """Véhicules virtuels : pour chaque camion utilisable et chaque dépôt, autant de rangs que de
    chargements encore permis (RM-14), tournées verrouillées déduites."""
    slots: list[VehicleSlot] = []
    for truck in ctx.usable_trucks:
        locked = ctx.locked_by_truck.get(truck.id, [])
        locked_depots = {t.depot_id for t in locked}
        cap = (slot_caps or {}).get(truck.id)
        for depot in ctx.problem.depots:
            if locked_depots and depot.id not in locked_depots:
                continue  # un seul dépôt par camion et par jour
            if not ctx.depot_start_windows(depot.id):
                continue
            count = ctx.free_loadings(truck.id, depot.id)
            if cap is not None:
                count = min(count, cap)
            # Indices décroissants dans le temps : les heuristiques remplissent d'abord la dernière
            # tournée de la journée, qui n'est contrainte par aucune tournée suivante.
            slots.extend(VehicleSlot(truck, depot, rank) for rank in range(count - 1, -1, -1))
    return slots


class _CompartmentCheck(pywrapcp.PyConstraint):
    """RM-05/06/07 dans la recherche : dès qu'une commande est attribuée à un véhicule, les volumes
    connus de ce véhicule doivent tenir dans les compartiments du camion."""

    def __init__(self, solver, vehicle_vars, node_loads, slots, ctx: Context) -> None:
        super().__init__(solver)
        self._solver = solver
        self._vars = vehicle_vars
        self._loads = node_loads  # (produit, volume) par commande
        self._slots = slots
        self._ctx = ctx

    def Post(self) -> None:  # noqa: N802 (API OR-Tools)
        demon = self.DelayedDemon(_CompartmentCheck._check)
        for var in self._vars:
            var.WhenBound(demon)

    def InitialPropagate(self) -> None:  # noqa: N802 (API OR-Tools)
        self._check()

    def _check(self) -> None:
        per_vehicle: dict[int, dict[str, float]] = {}
        for var, (product_id, volume) in zip(self._vars, self._loads, strict=True):
            if var.Bound():
                vehicle = var.Min()
                if vehicle >= 0:
                    volumes = per_vehicle.setdefault(vehicle, {})
                    volumes[product_id] = volumes.get(product_id, 0.0) + volume
        for vehicle, volumes in per_vehicle.items():
            if not self._ctx.fits(self._slots[vehicle].truck, volumes):
                self._solver.Fail()


def _mergeable(a: Candidate, b: Candidate) -> bool:
    """Deux commandes consécutives d'une même station forment un seul arrêt si leurs fenêtres se recoupent."""
    if a.order.station_id != b.order.station_id:
        return False
    return any(max(s1, s2) <= min(e1, e2) for s1, e1 in a.windows for s2, e2 in b.windows)


def _restrict(var, windows) -> None:
    """Restreint une variable de temps à une union d'intervalles."""
    var.SetRange(int(windows[0][0]), int(windows[-1][1]))
    for (_, end), (start, _) in zip(windows, windows[1:], strict=False):
        if start - end > 1:
            var.RemoveInterval(int(end) + 1, int(start) - 1)


def solve_routing(
    ctx: Context,
    candidates: list[Candidate],
    *,
    time_limit_s: float,
    excluded: set[tuple[str, str]] | None = None,
    slot_caps: dict[str, int] | None = None,
    warm_start: list[Route] | None = None,
    tick: Callable[[float, str], None] | None = None,
) -> RoutingOutcome:
    """Construit et résout le modèle. `excluded` : couples (commande, camion) interdits ;
    `slot_caps` : nombre maximal de tournées par camion ; `warm_start` : tournées de départ."""
    slots = build_slots(ctx, slot_caps)
    if not candidates or not slots:
        return RoutingOutcome([], [c.order.id for c in candidates], {"status": "SANS_OBJET", "rounds": []})

    outcome: RoutingOutcome | None = None
    attempts = []
    for strategy in ("PATH_CHEAPEST_ARC", "PARALLEL_CHEAPEST_INSERTION"):
        model = _Model(ctx, candidates, slots, excluded or set())
        outcome, stalled = model.run(strategy, time_limit_s, warm_start, tick)
        attempts.append(outcome.log)
        if not stalled:
            break
        warm_start = None
    assert outcome is not None
    outcome.log = {**attempts[-1], "attempts": attempts}
    return outcome


class _Model:
    def __init__(self, ctx: Context, candidates: list[Candidate], slots: list[VehicleSlot], excluded) -> None:
        self.ctx = ctx
        self.candidates = candidates
        self.slots = slots
        params, matrix = ctx.params, ctx.matrix
        depots = ctx.problem.depots
        self.n_depots = len(depots)
        depot_index = {d.id: i for i, d in enumerate(depots)}
        n_orders = len(candidates)
        size = self.n_depots + n_orders
        place = [d.id for d in depots] + [c.order.station_id for c in candidates]

        starts = [depot_index[s.depot.id] for s in slots]
        self.manager = pywrapcp.RoutingIndexManager(size, len(slots), starts, starts)
        self.routing = pywrapcp.RoutingModel(self.manager)
        routing, manager = self.routing, self.manager
        solver = routing.solver()
        self.solver = solver

        # ------------------------------------------------------------------ matrices
        nd = self.n_depots
        unload = [0] * nd + [ctx.unload_s(c.order.station_id) for c in candidates]
        wait_load = [ctx.wait_load_s(d.id) for d in depots]
        cost_m = [[0] * size for _ in range(size)]
        time_m = [[0] * size for _ in range(size)]
        work_m = [[0] * size for _ in range(size)]
        for a in range(size):
            for b in range(size):
                if a == b or (a < nd and b < nd):
                    continue
                travel = matrix.duration(place[a], place[b])
                cost_m[a][b] = objective.arc_cost(matrix.distance(place[a], place[b]), params)
                if a < nd:
                    service = 0
                elif b >= nd and _mergeable(candidates[a - nd], candidates[b - nd]):
                    service = 0  # même arrêt : un seul dépotage, compté en quittant la station
                else:
                    service = unload[a]
                work_m[a][b] = service + travel
                time_m[a][b] = service + travel + (wait_load[a] if a < nd else 0)

        cost_cb = routing.RegisterTransitMatrix(cost_m)
        time_cb = routing.RegisterTransitMatrix(time_m)
        work_cb = routing.RegisterTransitMatrix(work_m)
        routing.SetArcCostEvaluatorOfAllVehicles(cost_cb)
        routing.SetFixedCostOfAllVehicles(objective.vehicle_fixed_cost(params))

        # ------------------------------------------------------------------ temps
        horizon = DAY_S + params.max_service_s
        routing.AddDimension(time_cb, horizon, horizon, False, "time")
        time_dim = routing.GetDimensionOrDie("time")
        self.time_dim = time_dim
        for i, candidate in enumerate(candidates):
            _restrict(time_dim.CumulVar(manager.NodeToIndex(nd + i)), candidate.windows)
        for v, slot in enumerate(slots):
            _restrict(time_dim.CumulVar(routing.Start(v)), ctx.depot_start_windows(slot.depot.id))
            # RM-11 : retour − départ ≤ durée max ; l'attente et le chargement précèdent le départ.
            time_dim.SetSpanUpperBoundForVehicle(params.max_service_s + wait_load[starts[v]], v)

        routing.AddDimension(work_cb, 0, params.max_service_s, True, "work")
        work_dim = routing.GetDimensionOrDie("work")

        # ------------------------------------------------------------------ volumes
        products = sorted({c.order.product_id for c in candidates})
        liters = [int(math.ceil(c.volume_l - 1e-9)) for c in candidates]
        margin = ctx.margin_pct
        self.volume_dims = {}
        for product_id in products:
            demand = [0] * nd + [
                liters[i] if c.order.product_id == product_id else 0 for i, c in enumerate(candidates)
            ]
            callback = routing.RegisterUnaryTransitVector(demand)
            capacities = [
                int(math.floor(product_capacity_l(s.truck, product_id, margin) + 1e-9)) for s in slots
            ]
            name = f"volume_{product_id}"
            routing.AddDimensionWithVehicleCapacity(callback, 0, capacities, True, name)
            self.volume_dims[product_id] = routing.GetDimensionOrDie(name)
        callback = routing.RegisterUnaryTransitVector([0] * nd + liters)
        capacities = [int(math.floor(total_capacity_l(s.truck, margin) + 1e-9)) for s in slots]
        routing.AddDimensionWithVehicleCapacity(callback, 0, capacities, True, "volume_total")

        # ------------------------------------------------------------------ commandes
        for i, candidate in enumerate(candidates):
            index = manager.NodeToIndex(nd + i)
            station = ctx.stations[candidate.order.station_id]
            allowed = [
                v
                for v, slot in enumerate(slots)
                if slot.truck.id in candidate.truck_ids
                and (candidate.order.id, slot.truck.id) not in excluded
                and product_capacity_l(slot.truck, candidate.order.product_id, margin) + 1e-6
                >= candidate.volume_l
                and slot.truck.size.rank <= station.max_truck_size.rank  # RM-09
                and ctx.stock_left(slot.depot.id, candidate.order.product_id) + 1e-6 >= candidate.volume_l
            ]
            if len(allowed) < len(slots):
                routing.VehicleVar(index).SetValues([-1, *allowed])  # −1 : commande non servie
            routing.AddDisjunction([index], objective.unserved_penalty(candidate.order, params))

        # ------------------------------------------------------------------ contraintes par camion
        by_truck: dict[str, dict[str, list[int]]] = {}
        for v, slot in enumerate(slots):
            by_truck.setdefault(slot.truck.id, {}).setdefault(slot.depot.id, []).append(v)
        finalize_order: list[int] = []
        for truck_id, per_depot in by_truck.items():
            vehicles = [v for group in per_depot.values() for v in group]
            # Chaînage : la tournée de rang n+1 arrive au dépôt après le retour de la tournée de rang n.
            for group in per_depot.values():
                chronological = sorted(group, key=lambda v: slots[v].rank)
                finalize_order.extend(chronological)
                for earlier, later in zip(chronological, chronological[1:], strict=False):
                    solver.Add(
                        time_dim.CumulVar(routing.Start(later)) >= time_dim.CumulVar(routing.End(earlier))
                    )
            # Un seul dépôt de chargement par camion et par jour.
            groups = list(per_depot.values())
            for g, group in enumerate(groups):
                for other in groups[g + 1 :]:
                    for v in group:
                        for w in other:
                            solver.Add(routing.ActiveVehicleVar(v) + routing.ActiveVehicleVar(w) <= 1)
            # RM-11 : cumul journalier du camion (donc de son chauffeur), tournées verrouillées déduites.
            budget = max(0, params.max_service_s - ctx.locked_duration_s(truck_id))
            if len(vehicles) > 1:
                solver.Add(solver.Sum([work_dim.CumulVar(routing.End(v)) for v in vehicles]) <= budget)
            else:
                work_dim.CumulVar(routing.End(vehicles[0])).SetMax(budget)
            # RM-02 / RM-17 : pas de chevauchement avec les tournées verrouillées du camion.
            for locked in ctx.locked_by_truck.get(truck_id, []):
                for v in vehicles:
                    before = time_dim.CumulVar(routing.End(v)) <= int(locked.start_s)
                    after = time_dim.CumulVar(routing.Start(v)) >= int(locked.return_s)
                    solver.Add(before + after >= 1)
        for v in finalize_order:
            routing.AddVariableMinimizedByFinalizer(time_dim.CumulVar(routing.End(v)))
            routing.AddVariableMaximizedByFinalizer(time_dim.CumulVar(routing.Start(v)))

        # ------------------------------------------------------------------ stocks dépôt (RM-08)
        for depot in depots:
            for product_id in products:
                stock = ctx.stock.get((depot.id, product_id))
                if stock is None:
                    continue
                demand = sum(liters[i] for i, c in enumerate(candidates) if c.order.product_id == product_id)
                vehicles = [v for v, slot in enumerate(slots) if slot.depot.id == depot.id]
                if demand <= stock or not vehicles:
                    continue  # contrainte inactive : inutile de l'ajouter
                dimension = self.volume_dims[product_id]
                solver.Add(
                    solver.Sum([dimension.CumulVar(routing.End(v)) for v in vehicles])
                    <= int(math.floor(stock + 1e-9))
                )

        # ------------------------------------------------------------------ compartiments exacts
        self.compartment_check = False
        if any(len(slot.truck.compartments) > 1 for slot in slots):
            try:
                if not hasattr(solver, "_Solver__python_constraints"):
                    # Le solveur d'un RoutingModel n'initialise pas ce registre côté Python.
                    solver._Solver__python_constraints = []
                vehicle_vars = [routing.VehicleVar(manager.NodeToIndex(nd + i)) for i in range(n_orders)]
                loads = [(c.order.product_id, float(liters[i])) for i, c in enumerate(candidates)]
                solver.Add(_CompartmentCheck(solver, vehicle_vars, loads, slots, ctx))
                self.compartment_check = True
            except Exception:  # pragma: no cover — dépend de la version d'OR-Tools
                self.compartment_check = False  # le contrôle a posteriori du moteur prend le relais

    # ---------------------------------------------------------------------- résolution

    def run(self, strategy: str, time_limit_s: float, warm_start, tick) -> tuple[RoutingOutcome, bool]:
        routing, manager, solver, ctx = self.routing, self.manager, self.solver, self.ctx
        params = ctx.params
        nd = self.n_depots
        n_nodes = len(self.candidates)

        search = pywrapcp.DefaultRoutingSearchParameters()
        search.first_solution_strategy = getattr(routing_enums_pb2.FirstSolutionStrategy, strategy)
        search.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
        limit_ms = max(200, int(time_limit_s * 1000))
        search.time_limit.FromMilliseconds(limit_ms)
        search.log_search = False
        solver.ReSeed(int(params.solver_seed))

        started = time.monotonic()
        state = {
            "best": None,
            "best_at": started,
            "solutions": 0,
            "stalled": False,
            "early_stop": False,
            "calls": 0,
            "best_index": 0,
            "plateau": False,
        }
        failure_budget = FIRST_SOLUTION_FAILURES_BASE + FIRST_SOLUTION_FAILURES_PER_NODE * n_nodes
        guard_first_solution = strategy == "PATH_CHEAPEST_ARC" and warm_start is None
        plateau = int(params.solver_no_improvement_solutions)

        def on_solution() -> None:
            cost = routing.CostVar().Max()
            state["solutions"] += 1
            if state["best"] is None or cost < state["best"]:
                state["best"] = cost
                state["best_at"] = time.monotonic()
                state["best_index"] = state["solutions"]
            elif plateau > 0 and state["solutions"] - state["best_index"] >= plateau:
                # Critère indépendant de l'horloge : même entrée → même arrêt → même sortie.
                state["plateau"] = True

        def should_stop() -> bool:
            if state["plateau"]:
                return True
            state["calls"] += 1
            if state["calls"] % LIMIT_CHECK_PERIOD:
                return False
            now = time.monotonic()
            if tick is not None:
                tick(now - started, self._progress_text(state))
            if state["best"] is None:
                if guard_first_solution and solver.Failures() > failure_budget:
                    state["stalled"] = True
                    return True
                return False
            if now - state["best_at"] > params.solver_no_improvement_s:
                state["early_stop"] = True
                return True
            return False

        routing.AddAtSolutionCallback(on_solution)
        routing.AddSearchMonitor(solver.CustomLimit(should_stop))

        assignment = None
        warm_used = False
        if warm_start:
            initial = self._initial_assignment(warm_start)
            if initial is not None:
                assignment = routing.SolveFromAssignmentWithParameters(initial, search)
                warm_used = assignment is not None
        if assignment is None and not warm_used:
            assignment = routing.SolveWithParameters(search)

        status = routing.status()
        log = {
            "first_solution_strategy": strategy,
            "status": _STATUS_NAMES.get(status, str(status)),
            "wall_time_s": round(time.monotonic() - started, 3),
            "time_limit_s": round(limit_ms / 1000, 3),
            "solutions": state["solutions"],
            "branches": solver.Branches(),
            "failures": solver.Failures(),
            "early_stop_no_improvement": state["early_stop"],
            "stalled_first_solution": state["stalled"],
            "warm_start": warm_used,
            "vehicles": len(self.slots),
            "nodes": n_nodes,
            "compartment_check_in_search": self.compartment_check,
            "objective_km": None,
            "early_stop_plateau": state["plateau"],
        }
        if assignment is None:
            return RoutingOutcome([], [c.order.id for c in self.candidates], log), bool(state["stalled"])

        log["objective_km"] = assignment.ObjectiveValue() / objective.METERS_PER_KM
        routes: list[Route] = []
        routed: set[str] = set()
        for v, slot in enumerate(self.slots):
            order_ids = []
            index = assignment.Value(routing.NextVar(routing.Start(v)))
            while not routing.IsEnd(index):
                order_ids.append(self.candidates[manager.IndexToNode(index) - nd].order.id)
                index = assignment.Value(routing.NextVar(index))
            if order_ids:
                routes.append(Route(slot.truck.id, slot.depot.id, slot.rank, order_ids))
                routed.update(order_ids)
        dropped = [c.order.id for c in self.candidates if c.order.id not in routed]
        # Une première solution vide obtenue par enlisement ne vaut pas mieux qu'un échec.
        stalled = bool(state["stalled"]) and not routes
        return RoutingOutcome(routes, dropped, log), stalled

    @staticmethod
    def _progress_text(state) -> str:
        if state["best"] is None:
            return "Recherche d'une première solution…"
        return f"Optimisation en cours ({state['solutions']} solutions explorées)…"

    def _initial_assignment(self, warm_start: list[Route]):
        """Tournées de départ d'une relance : celles du passage précédent, recalées sur les véhicules."""
        node_of = {c.order.id: self.n_depots + i for i, c in enumerate(self.candidates)}
        vehicle_of = {(s.truck.id, s.depot.id, s.rank): v for v, s in enumerate(self.slots)}
        ranks: dict[tuple[str, str], int] = {}
        for slot in self.slots:
            key = (slot.truck.id, slot.depot.id)
            ranks[key] = max(ranks.get(key, 0), slot.rank + 1)
        routes: list[list[int]] = [[] for _ in self.slots]
        grouped: dict[tuple[str, str], list[Route]] = {}
        for route in warm_start:
            grouped.setdefault((route.truck_id, route.depot_id), []).append(route)
        for key, group in grouped.items():
            group.sort(key=lambda r: r.rank)
            available = ranks.get(key, 0)
            kept = group[-available:] if available else []
            for offset, route in enumerate(kept):
                vehicle = vehicle_of[(key[0], key[1], available - len(kept) + offset)]
                routes[vehicle] = [node_of[o] for o in route.order_ids if o in node_of]
        try:
            return self.routing.ReadAssignmentFromRoutes(routes, True)
        except Exception:  # pragma: no cover — tournées de départ refusées : résolution classique
            return None
