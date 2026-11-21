"""Aides de construction de petits problèmes pour les tests des règles métier.

Jeu de base (`make_problem()`) : dépôt DLA ouvert de 06:00 à 18:00, stations AKWA et BONA ouvertes
de 07:00 à 17:00, produits SUPER et GASOIL, un camion moyen LT-001-AA à deux compartiments
(10 000 L et 8 000 L), un chauffeur, stocks dépôt confortables. Chaque test surcharge ce dont il
a besoin.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from app.core.enums import OrderPriority, TruckSize
from app.planning.domain import (
    CompartmentD,
    CompartmentLoadD,
    DeliveryD,
    DepotD,
    DriverD,
    OrderD,
    Params,
    PlanningProblem,
    ProductD,
    StationD,
    StopD,
    TripD,
    TruckD,
    ViolationD,
)

H = 3600
MIN = 60
DAY = date(2027, 1, 12)

SUPER = "P-SUPER"
GASOIL = "P-GASOIL"


def compartment(cid: str = "C1", position: int = 1, capacity_l: float = 10_000, allowed=None) -> CompartmentD:
    return CompartmentD(cid, position, capacity_l, frozenset(allowed) if allowed is not None else None)


def truck(tid: str = "T1", plate: str = "LT-001-AA", size: TruckSize = TruckSize.MEDIUM, **kw: Any) -> TruckD:
    compartments = kw.pop("compartments", (compartment("C1", 1, 10_000), compartment("C2", 2, 8_000)))
    return TruckD(tid, plate, size, tuple(compartments), **kw)


def driver(did: str = "DR1", name: str = "Jean Mbarga", **kw: Any) -> DriverD:
    return DriverD(did, name, **kw)


def depot(did: str = "D1", code: str = "DLA", **kw: Any) -> DepotD:
    kw.setdefault("windows", ((6 * H, 18 * H),))
    return DepotD(did, code, 4.05, 9.70, **kw)


def station(sid: str = "S1", code: str = "AKWA", **kw: Any) -> StationD:
    kw.setdefault("windows", ((7 * H, 17 * H),))
    return StationD(sid, code, 4.06, 9.71, **kw)


def order(
    oid: str = "O1",
    station_id: str = "S1",
    product_id: str = SUPER,
    requested_l: float = 5_000,
    *,
    urgent: bool = False,
    window: tuple[int, int] | None = None,
) -> OrderD:
    priority = OrderPriority.URGENT if urgent else OrderPriority.NORMAL
    return OrderD(oid, station_id, product_id, requested_l, priority, window)


def make_problem(**overrides: Any) -> PlanningProblem:
    values: dict[str, Any] = {
        "day": DAY,
        "products": [ProductD(SUPER, "SUPER"), ProductD(GASOIL, "GASOIL")],
        "depots": [depot()],
        "stations": [station("S1", "AKWA"), station("S2", "BONA")],
        "trucks": [truck()],
        "drivers": [driver()],
        "orders": [order("O1", "S1", SUPER, 5_000), order("O2", "S2", GASOIL, 4_000)],
        "depot_stocks": {("D1", SUPER): 100_000.0, ("D1", GASOIL): 100_000.0},
        "params": Params(),
    }
    values.update(overrides)
    return PlanningProblem(**values)


def stop(
    station_id: str = "S1",
    deliveries: list[tuple[str, str, float]] | None = None,
    *,
    seq: int = 1,
    arrival_s: int = 9 * H,
    departure_s: int | None = None,
) -> StopD:
    """`deliveries` : liste de (order_id, product_id, volume)."""
    return StopD(
        seq=seq,
        station_id=station_id,
        arrival_s=arrival_s,
        departure_s=arrival_s + 45 * MIN if departure_s is None else departure_s,
        deliveries=[DeliveryD(*d) for d in (deliveries or [])],
    )


def trip(
    seq: int = 1,
    *,
    truck_id: str = "T1",
    driver_id: str | None = "DR1",
    depot_id: str = "D1",
    start_s: int = 6 * H,
    depart_s: int | None = None,
    return_s: int | None = None,
    stops: list[StopD] | None = None,
    loads: list[tuple[str, str, float]] | None = None,
    locked: bool = False,
    ref: str | None = None,
) -> TripD:
    """`loads` : liste de (compartment_id, product_id, volume). Par défaut : départ 2 h 15 après
    l'arrivée au dépôt, retour 4 h après le départ."""
    depart = start_s + 135 * MIN if depart_s is None else depart_s
    back = depart + 4 * H if return_s is None else return_s
    return TripD(
        seq=seq,
        truck_id=truck_id,
        depot_id=depot_id,
        driver_id=driver_id,
        start_s=start_s,
        depart_s=depart,
        return_s=back,
        duration_s=back - depart,
        stops=stops or [],
        loads=[CompartmentLoadD(*load) for load in (loads or [])],
        locked=locked,
        ref=ref,
    )


def simple_trip(seq: int = 1, **kw: Any) -> TripD:
    """Tournée conforme du jeu de base : O1 (5 000 L SUPER) à AKWA puis O2 (4 000 L GASOIL) à BONA."""
    kw.setdefault(
        "stops",
        [
            stop("S1", [("O1", SUPER, 5_000)], seq=1, arrival_s=9 * H),
            stop("S2", [("O2", GASOIL, 4_000)], seq=2, arrival_s=10 * H),
        ],
    )
    kw.setdefault("loads", [("C1", SUPER, 5_000), ("C2", GASOIL, 4_000)])
    return trip(seq, **kw)


def codes(violations: list[ViolationD]) -> list[str]:
    return [v.rule_code for v in violations]


def severities(violations: list[ViolationD]) -> list[str]:
    return [str(v.severity) for v in violations]
