"""Moteur de tournées (spec §7) : orchestration d'un calcul.

préparation → solveur OR-Tools → compartiments / horaires / chauffeurs
            → relance unique si une affectation a échoué (§7.3)
            → repêchage (dont livraison partielle, RM-16) → diagnostic des non-servies
            → contrôle par les règles, métriques, journal de résolution
"""

from __future__ import annotations

import time
from typing import Any

from app.core.enums import UnservedReason
from app.planning.domain import Matrix, PlanningProblem, PlanningResult, TripD, UnservedD, ViolationD
from app.planning.engine import objective
from app.planning.engine.compartments import assign_compartments, product_capacity_l, total_capacity_l
from app.planning.engine.context import Candidate, Context, build_context, classify_orders
from app.planning.engine.metrics import compute_metrics
from app.planning.engine.plan_builder import BuildReport, Plan, Removal, build_plan
from app.planning.engine.rescue import rescue
from app.planning.engine.routing_model import Route, solve_routing
from app.planning.engine.version import ENGINE_VERSION

# Jalons de la barre de progression (pourcentages affichés, sans portée métier).
PROGRESS_SEARCH_START = 10
PROGRESS_SEARCH_END = 85


def _check_plan(
    problem: PlanningProblem, trips: list[TripD], unserved: list[UnservedD], matrix: Matrix
) -> tuple[list[ViolationD], bool]:
    """`rules.check_plan` (lot L1), protégé : résultat vide tant que les règles ne sont pas livrées."""
    try:
        from app.planning.violations import rules

        return list(rules.check_plan(problem, trips, unserved, matrix)), True
    except NotImplementedError:
        return [], False


def _diagnose(ctx: Context, cand: Candidate, plan: Plan) -> UnservedD:
    """Raison d'une commande que ni le solveur ni le repêchage n'ont pu servir."""
    order = cand.order
    best_stock = max((ctx.stock_left(d.id, order.product_id) for d in ctx.problem.depots), default=0.0)
    if best_stock < cand.min_volume_l or best_stock <= 0:
        return UnservedD(
            order.id,
            UnservedReason.DEPOT_STOCK,
            "Stock dépôt insuffisant pour ce produit une fois les autres commandes du jour servies (RM-08).",
        )
    station = ctx.stations[order.station_id]
    needed = cand.min_volume_l
    if any(
        t.size.rank <= station.max_truck_size.rank
        and product_capacity_l(t, order.product_id, ctx.margin_pct) >= needed
        for t in ctx.driverless_trucks
    ):
        return UnservedD(
            order.id,
            UnservedReason.NO_DRIVER,
            "Un camion compatible reste disponible, mais aucun chauffeur n'est affectable pour le conduire.",
        )
    # Un camion compatible a encore du volume libre, mais pas dans des compartiments utilisables.
    for truck_id, day in plan.days.items():
        truck = ctx.trucks[truck_id]
        if truck_id not in cand.truck_ids:
            continue
        for trip in day:
            volumes = trip.volumes_by_product()
            room = total_capacity_l(truck, ctx.margin_pct) - sum(volumes.values())
            volumes[order.product_id] = volumes.get(order.product_id, 0.0) + needed
            if room >= needed and not ctx.fits(truck, volumes):
                return UnservedD(
                    order.id,
                    UnservedReason.COMPARTMENT,
                    f"Le camion {truck.plate} a du volume libre, mais aucun compartiment compatible "
                    "(un seul produit par compartiment, produits autorisés).",
                )
    return UnservedD(
        order.id,
        UnservedReason.NO_TRUCK,
        "Capacité de la flotte épuisée : aucun camion compatible n'a de chargement, de place "
        "ou de temps de service restant pour cette commande.",
    )


def _finalize_trips(ctx: Context, report: BuildReport) -> list[TripD]:
    """Plans de chargement, numérotation et fusion avec les tournées verrouillées (RM-17)."""
    new_trips = sorted(
        report.plan.trips(), key=lambda t: (t.start_s, ctx.trucks[t.truck_id].plate, t.truck_id)
    )
    used_seqs = {t.seq for t in ctx.problem.locked_trips}
    seq = 0
    for trip in new_trips:
        seq += 1
        while seq in used_seqs:
            seq += 1
        trip.seq = seq
        loads = assign_compartments(ctx.trucks[trip.truck_id], trip.volumes_by_product(), ctx.margin_pct)
        trip.loads = loads or []
    return sorted([*ctx.problem.locked_trips, *new_trips], key=lambda t: t.seq)


def solve(problem: PlanningProblem, matrix: Matrix, progress=None) -> PlanningResult:
    """Calcule le plan de tournées du jour J (contrat : `app.planning.engine.solve`)."""
    started = time.monotonic()
    params = problem.params
    last_tick = {"pct": -1}

    def notify(pct: int, message: str) -> None:
        if progress is not None and pct != last_tick["pct"]:
            last_tick["pct"] = pct
            progress(pct, message)

    notify(0, "Préparation des données…")
    ctx = build_context(problem, matrix)
    candidates, rejected = classify_orders(ctx)
    by_id = {c.order.id: c for c in candidates}
    notify(5, "Construction du modèle d'optimisation…")

    budget_s = float(params.solver_time_limit_s)
    excluded: set[tuple[str, str]] = set()
    slot_caps: dict[str, int] = {}
    warm_start: list[Route] | None = None
    rounds: list[dict[str, Any]] = []
    report = BuildReport(plan=Plan())

    for round_no in (1, 2):
        remaining = budget_s - (time.monotonic() - started)
        # La relance repart des tournées du premier passage : on lui garantit au moins la fenêtre
        # « sans amélioration » pour converger, même si le premier passage a consommé le budget.
        limit_s = remaining if round_no == 1 else max(remaining, float(params.solver_no_improvement_s))
        limit_s = max(1.0, min(limit_s, budget_s))
        round_started = time.monotonic() - started

        def tick(elapsed: float, message: str, _base: float = round_started) -> None:
            span = PROGRESS_SEARCH_END - PROGRESS_SEARCH_START
            ratio = min(1.0, (_base + elapsed) / max(budget_s, 1.0))
            notify(PROGRESS_SEARCH_START + int(span * ratio), message)

        outcome = solve_routing(
            ctx,
            candidates,
            time_limit_s=limit_s,
            excluded=excluded,
            slot_caps=slot_caps,
            warm_start=warm_start,
            tick=tick,
        )
        report = build_plan(ctx, by_id, outcome.routes)
        rounds.append({**outcome.log, "round": round_no, "removals": len(report.removals)})
        if round_no == 2 or not (report.excluded or report.slot_caps):
            break
        # §7.3 : affectation impossible → retrait de la commande du véhicule et relance unique.
        excluded |= report.excluded
        slot_caps.update(report.slot_caps)
        removed = {r.order_id for r in report.removals}
        warm_start = [
            Route(r.truck_id, r.depot_id, r.rank, [o for o in r.order_ids if o not in removed])
            for r in outcome.routes
        ]
        notify(PROGRESS_SEARCH_END, "Relance du solveur après retrait des affectations impossibles…")

    notify(88, "Repêchage des commandes non servies…")
    plan = report.plan
    for trip in plan.trips():
        for product_id, volume in trip.volumes_by_product().items():
            key = (trip.depot_id, product_id)
            if key in ctx.stock:
                ctx.stock[key] = max(0.0, ctx.stock[key] - volume)
    served = plan.served_volumes()
    pending = [c for c in candidates if c.order.id not in served]
    left = rescue(ctx, plan, pending)
    rescued = len(pending) - len(left)

    notify(93, "Contrôle du plan et diagnostic des commandes non servies…")
    removal_by_order: dict[str, Removal] = {}
    for removal in report.removals:
        removal_by_order.setdefault(removal.order_id, removal)
    unserved = list(rejected)
    for cand in left:
        removal = removal_by_order.get(cand.order.id)
        if removal is not None:
            unserved.append(UnservedD(removal.order_id, removal.reason, removal.text))
        else:
            unserved.append(_diagnose(ctx, cand, plan))
    position = {o.id: i for i, o in enumerate(problem.orders)}
    orders = ctx.orders
    unserved.sort(key=lambda u: (orders[u.order_id].priority != "urgent", position[u.order_id]))  # RM-15

    trips = _finalize_trips(ctx, report)
    violations, rules_available = _check_plan(problem, trips, unserved, matrix)
    metrics = compute_metrics(problem, trips, unserved)
    elapsed_ms = int((time.monotonic() - started) * 1000)
    solver_log = {
        "engine_version": ENGINE_VERSION,
        "status": rounds[-1].get("status"),
        "wall_time_s": round(elapsed_ms / 1000, 3),
        "solver_time_s": round(
            sum(a.get("wall_time_s", 0.0) for r in rounds for a in r.get("attempts", [r])), 3
        ),
        "solver_objective_km": rounds[-1].get("objective_km"),
        "objective_km": round(
            objective.objective_km(trips, [orders[u.order_id] for u in unserved], params), 3
        ),
        "rounds": rounds,
        "relaunched": len(rounds) > 1,
        "orders_candidates": len(candidates),
        "orders_rejected_upfront": len(rejected),
        "orders_rescued": rescued,
        "usable_trucks": len(ctx.usable_trucks),
        "driverless_trucks": [t.plate for t in ctx.driverless_trucks],
        "seed": params.solver_seed,
        "approximate_matrix": matrix.approximate,
        "rules_available": rules_available,
    }
    notify(100, "Calcul terminé.")
    return PlanningResult(
        trips=trips,
        unserved=unserved,
        violations=violations,
        approximate=matrix.approximate,
        engine_version=ENGINE_VERSION,
        computed_in_ms=elapsed_ms,
        solver_log=solver_log,
        metrics=metrics,
    )
