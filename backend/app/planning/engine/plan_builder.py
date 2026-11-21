"""Du résultat du solveur aux tournées du domaine : arrêts, compartiments, horaires, chauffeurs.

Chaque étape revérifie la faisabilité avec les fonctions partagées (`assign_compartments`,
`timing.schedule_trip`) ; ce qui ne passe pas est retiré de la tournée et rendu avec sa raison —
rien ne disparaît en silence (F4.4).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.core.enums import UnservedReason
from app.planning.domain import DeliveryD, StopD, TripD
from app.planning.engine.context import Candidate, Context
from app.planning.engine.drivers import assign_drivers
from app.planning.engine.routing_model import Route
from app.planning.engine.scheduling import schedule_truck_day, trip_problem
from app.planning.timing import stop_windows


@dataclass(slots=True)
class Plan:
    """Tournées calculées (hors verrouillées), par camion et dans l'ordre chronologique."""

    days: dict[str, list[TripD]] = field(default_factory=dict)

    def trips(self) -> list[TripD]:
        return [trip for day in self.days.values() for trip in day]

    def served_volumes(self) -> dict[str, float]:
        volumes: dict[str, float] = {}
        for trip in self.trips():
            for stop in trip.stops:
                for delivery in stop.deliveries:
                    volumes[delivery.order_id] = volumes.get(delivery.order_id, 0.0) + delivery.planned_l
        return volumes


@dataclass(slots=True)
class Removal:
    order_id: str
    reason: UnservedReason
    text: str


@dataclass(slots=True)
class BuildReport:
    plan: Plan
    removals: list[Removal] = field(default_factory=list)
    excluded: set[tuple[str, str]] = field(default_factory=set)  # (commande, camion) à interdire
    slot_caps: dict[str, int] = field(default_factory=dict)  # camion → nombre de tournées conduisibles


def can_share_stop(ctx: Context, stop: StopD, candidate: Candidate) -> bool:
    """Une commande rejoint un arrêt existant si c'est la même station et que les fenêtres se recoupent."""
    if stop.station_id != candidate.order.station_id:
        return False
    probe = StopD(
        seq=stop.seq,
        station_id=stop.station_id,
        deliveries=[*stop.deliveries, DeliveryD(candidate.order.id, candidate.order.product_id, 0.0)],
    )
    trip = TripD(seq=0, truck_id="", depot_id=next(iter(ctx.depots)), stops=[probe])
    return bool(stop_windows(trip_problem(ctx, trip), probe))


def make_stops(ctx: Context, candidates: list[Candidate]) -> list[StopD]:
    """Séquence de commandes → arrêts ; les commandes consécutives d'une même station sont regroupées."""
    stops: list[StopD] = []
    for candidate in candidates:
        delivery = DeliveryD(candidate.order.id, candidate.order.product_id, candidate.volume_l)
        if stops and can_share_stop(ctx, stops[-1], candidate):
            stops[-1].deliveries.append(delivery)
        else:
            stops.append(
                StopD(seq=len(stops) + 1, station_id=candidate.order.station_id, deliveries=[delivery])
            )
    return stops


def _victim(ctx: Context, deliveries: list[DeliveryD], by_id: dict[str, Candidate]) -> DeliveryD:
    """Livraison à retirer en priorité : normale avant urgente (RM-15), la plus petite d'abord."""
    return min(deliveries, key=lambda d: (by_id[d.order_id].urgent, d.planned_l, d.order_id))


def remove_delivery(trip: TripD, delivery: DeliveryD) -> None:
    for stop in list(trip.stops):
        if delivery in stop.deliveries:
            stop.deliveries.remove(delivery)
            if not stop.deliveries:
                trip.stops.remove(stop)
            break
    for seq, stop in enumerate(trip.stops, start=1):
        stop.seq = seq


def build_plan(ctx: Context, by_id: dict[str, Candidate], routes: list[Route]) -> BuildReport:
    report = BuildReport(plan=Plan())
    plan = report.plan

    # 1. Tournées et compartiments (RM-05/06/07).
    for route in sorted(routes, key=lambda r: (r.truck_id, r.rank)):
        truck = ctx.trucks[route.truck_id]
        trip = TripD(seq=0, truck_id=route.truck_id, depot_id=route.depot_id)
        trip.stops = make_stops(ctx, [by_id[o] for o in route.order_ids])
        while trip.stops and not ctx.fits(truck, trip.volumes_by_product()):
            victim = _victim(ctx, [d for s in trip.stops for d in s.deliveries], by_id)
            remove_delivery(trip, victim)
            report.excluded.add((victim.order_id, truck.id))
            report.removals.append(
                Removal(
                    victim.order_id,
                    UnservedReason.COMPARTMENT,
                    f"Les volumes de la tournée ne tiennent pas dans les compartiments de {truck.plate}.",
                )
            )
        if trip.stops:
            plan.days.setdefault(route.truck_id, []).append(trip)

    # 2. Horaires (timing.schedule_trip) et contrôle de faisabilité après recalcul.
    for truck_id in list(plan.days):
        day = plan.days[truck_id]
        for _ in range(sum(len(s.deliveries) for t in day for s in t.stops) + 1):
            issues = schedule_truck_day(ctx, day)
            if not issues:
                break
            trip, reason, stop_index = issues[0]
            pool = (
                trip.stops[stop_index].deliveries
                if stop_index is not None
                else [d for s in trip.stops for d in s.deliveries]
            )
            victim = _victim(ctx, pool, by_id)
            remove_delivery(trip, victim)
            text = (
                "Durée maximale de service dépassée sur la tournée après recalcul des horaires."
                if reason == UnservedReason.SERVICE_DURATION
                else "Fenêtre horaire impossible à tenir après recalcul des horaires de la tournée."
            )
            report.removals.append(Removal(victim.order_id, reason, text))
            day[:] = [t for t in day if t.stops]
        if not day:
            del plan.days[truck_id]

    # 3. Chauffeurs (RM-02, RM-03, RM-11).
    orphans = assign_drivers(ctx.problem, plan.trips(), ctx.problem.locked_trips)
    for trip in orphans:
        day = plan.days[trip.truck_id]
        day.remove(trip)
        report.slot_caps[trip.truck_id] = len(day)
        plate = ctx.trucks[trip.truck_id].plate
        for stop in trip.stops:
            for delivery in stop.deliveries:
                report.removals.append(
                    Removal(
                        delivery.order_id,
                        UnservedReason.NO_DRIVER,
                        f"Aucun chauffeur affectable pour la tournée du camion {plate} (RM-02/03/11).",
                    )
                )
        if not day:
            del plan.days[trip.truck_id]
    if orphans:  # les horaires des tournées restantes peuvent se resserrer
        for day in plan.days.values():
            schedule_truck_day(ctx, day)
        assign_drivers(ctx.problem, plan.trips(), ctx.problem.locked_trips)
    return report
