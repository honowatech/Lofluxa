"""Jeux de données fictifs du moteur (spec §7.5) : (dé)sérialisation JSON de `PlanningProblem`.

Les jeux vivent dans `data/fixtures/<nom>/problem.json` et sont générés par
`scripts/gen_fixtures.py` (graine fixe). Ce module ne lit que du JSON : aucun fichier Excel/CSV.
"""

from __future__ import annotations

import json
import os
from datetime import date
from pathlib import Path
from typing import Any

from app.core.enums import OrderPriority, TruckSize, TruckStatus
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
)

FIXTURES_ENV_VAR = "TOURNEO_FIXTURES_DIR"
FORMAT_VERSION = 1


def fixtures_dir() -> Path:
    """Répertoire des jeux : variable `TOURNEO_FIXTURES_DIR`, sinon `data/fixtures` du dépôt."""
    override = os.environ.get(FIXTURES_ENV_VAR)
    if override:
        return Path(override)
    return Path(__file__).resolve().parents[3] / "data" / "fixtures"


def load_problem(name: str | Path) -> PlanningProblem:
    """Charge un jeu par son nom (`demo_douala`…) ou par le chemin d'un fichier `problem.json`."""
    path = Path(name)
    if path.suffix != ".json":
        path = fixtures_dir() / str(name) / "problem.json"
    with path.open(encoding="utf-8") as handle:
        return problem_from_dict(json.load(handle))


def dump_problem(problem: PlanningProblem, path: str | Path) -> Path:
    """Écrit le problème en JSON (stable : même problème → même fichier) et renvoie le chemin."""
    target = Path(path)
    if target.suffix != ".json":
        target = target / "problem.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(problem_to_dict(problem), ensure_ascii=False, indent=1)
    target.write_text(text + "\n", encoding="utf-8")
    return target


# --------------------------------------------------------------------------- vers JSON


def _windows(windows: tuple[tuple[int, int], ...]) -> list[list[int]]:
    return [[int(start), int(end)] for start, end in windows]


def _trip_to_dict(trip: TripD) -> dict[str, Any]:
    return {
        "seq": trip.seq,
        "truck_id": trip.truck_id,
        "depot_id": trip.depot_id,
        "driver_id": trip.driver_id,
        "start_s": trip.start_s,
        "depart_s": trip.depart_s,
        "return_s": trip.return_s,
        "distance_m": trip.distance_m,
        "duration_s": trip.duration_s,
        "locked": trip.locked,
        "ref": trip.ref,
        "stops": [
            {
                "seq": stop.seq,
                "station_id": stop.station_id,
                "arrival_s": stop.arrival_s,
                "departure_s": stop.departure_s,
                "distance_from_prev_m": stop.distance_from_prev_m,
                "status": stop.status,
                "ref": stop.ref,
                "deliveries": [
                    {"order_id": d.order_id, "product_id": d.product_id, "planned_l": d.planned_l}
                    for d in stop.deliveries
                ],
            }
            for stop in trip.stops
        ],
        "loads": [
            {"compartment_id": x.compartment_id, "product_id": x.product_id, "planned_l": x.planned_l}
            for x in trip.loads
        ],
    }


def problem_to_dict(problem: PlanningProblem) -> dict[str, Any]:
    params = {name: getattr(problem.params, name) for name in Params.__dataclass_fields__}
    return {
        "format_version": FORMAT_VERSION,
        "day": problem.day.isoformat(),
        "params": params,
        "products": [{"id": p.id, "code": p.code, "label": p.label} for p in problem.products],
        "depots": [
            {
                "id": d.id,
                "code": d.code,
                "name": d.name,
                "lat": d.lat,
                "lon": d.lon,
                "windows": _windows(d.windows),
                "avg_wait_min": d.avg_wait_min,
                "max_loadings_per_truck_day": d.max_loadings_per_truck_day,
            }
            for d in problem.depots
        ],
        "stations": [
            {
                "id": s.id,
                "code": s.code,
                "name": s.name,
                "lat": s.lat,
                "lon": s.lon,
                "windows": _windows(s.windows),
                "max_truck_size": s.max_truck_size.value,
                "unload_time_min": s.unload_time_min,
            }
            for s in problem.stations
        ],
        "trucks": [
            {
                "id": t.id,
                "plate": t.plate,
                "size": t.size.value,
                "carrier_id": t.carrier_id,
                "avg_speed_kmh": t.avg_speed_kmh,
                "status": t.status.value,
                "available_today": t.available_today,
                "compartments": [
                    {
                        "id": c.id,
                        "position": c.position,
                        "capacity_l": c.capacity_l,
                        "allowed_product_ids": (
                            None if c.allowed_product_ids is None else sorted(c.allowed_product_ids)
                        ),
                    }
                    for c in t.compartments
                ],
            }
            for t in problem.trucks
        ],
        "drivers": [
            {
                "id": d.id,
                "full_name": d.full_name,
                "carrier_id": d.carrier_id,
                "license_expiry": d.license_expiry.isoformat() if d.license_expiry else None,
                "hazmat_cert": d.hazmat_cert,
                "hazmat_expiry": d.hazmat_expiry.isoformat() if d.hazmat_expiry else None,
                "status": str(d.status),
                "available_today": d.available_today,
                "default_truck_id": d.default_truck_id,
            }
            for d in problem.drivers
        ],
        "orders": [
            {
                "id": o.id,
                "station_id": o.station_id,
                "product_id": o.product_id,
                "requested_l": o.requested_l,
                "priority": o.priority.value,
                "window": list(o.window) if o.window is not None else None,
            }
            for o in problem.orders
        ],
        "depot_stocks": [
            {"depot_id": depot_id, "product_id": product_id, "available_l": volume}
            for (depot_id, product_id), volume in sorted(problem.depot_stocks.items())
        ],
        "driver_by_truck": dict(sorted(problem.driver_by_truck.items())),
        "locked_trips": [_trip_to_dict(t) for t in problem.locked_trips],
    }


# --------------------------------------------------------------------------- depuis JSON


def _date(value: str | None) -> date | None:
    return date.fromisoformat(value) if value else None


def _tuple_windows(raw: list[list[int]]) -> tuple[tuple[int, int], ...]:
    return tuple((int(start), int(end)) for start, end in raw)


def _trip_from_dict(raw: dict[str, Any]) -> TripD:
    return TripD(
        seq=raw["seq"],
        truck_id=raw["truck_id"],
        depot_id=raw["depot_id"],
        driver_id=raw.get("driver_id"),
        start_s=raw.get("start_s", 0),
        depart_s=raw.get("depart_s", 0),
        return_s=raw.get("return_s", 0),
        distance_m=raw.get("distance_m", 0),
        duration_s=raw.get("duration_s", 0),
        locked=raw.get("locked", False),
        ref=raw.get("ref"),
        stops=[
            StopD(
                seq=s["seq"],
                station_id=s["station_id"],
                arrival_s=s.get("arrival_s", 0),
                departure_s=s.get("departure_s", 0),
                distance_from_prev_m=s.get("distance_from_prev_m", 0),
                status=s.get("status", "pending"),
                ref=s.get("ref"),
                deliveries=[
                    DeliveryD(d["order_id"], d["product_id"], d["planned_l"]) for d in s["deliveries"]
                ],
            )
            for s in raw.get("stops", [])
        ],
        loads=[
            CompartmentLoadD(x["compartment_id"], x["product_id"], x["planned_l"])
            for x in raw.get("loads", [])
        ],
    )


def problem_from_dict(raw: dict[str, Any]) -> PlanningProblem:
    known = set(Params.__dataclass_fields__)
    params = Params(**{k: v for k, v in raw.get("params", {}).items() if k in known})
    return PlanningProblem(
        day=date.fromisoformat(raw["day"]),
        products=[ProductD(p["id"], p["code"], p.get("label", "")) for p in raw["products"]],
        depots=[
            DepotD(
                id=d["id"],
                code=d["code"],
                lat=d["lat"],
                lon=d["lon"],
                windows=_tuple_windows(d["windows"]),
                avg_wait_min=d.get("avg_wait_min"),
                max_loadings_per_truck_day=d.get("max_loadings_per_truck_day"),
                name=d.get("name", ""),
            )
            for d in raw["depots"]
        ],
        stations=[
            StationD(
                id=s["id"],
                code=s["code"],
                lat=s["lat"],
                lon=s["lon"],
                windows=_tuple_windows(s["windows"]),
                max_truck_size=TruckSize(s.get("max_truck_size", "large")),
                unload_time_min=s.get("unload_time_min"),
                name=s.get("name", ""),
            )
            for s in raw["stations"]
        ],
        trucks=[
            TruckD(
                id=t["id"],
                plate=t["plate"],
                size=TruckSize(t["size"]),
                compartments=tuple(
                    CompartmentD(
                        id=c["id"],
                        position=c["position"],
                        capacity_l=c["capacity_l"],
                        allowed_product_ids=(
                            None
                            if c.get("allowed_product_ids") is None
                            else frozenset(c["allowed_product_ids"])
                        ),
                    )
                    for c in t["compartments"]
                ),
                carrier_id=t.get("carrier_id"),
                avg_speed_kmh=t.get("avg_speed_kmh"),
                status=TruckStatus(t.get("status", "available")),
                available_today=t.get("available_today", True),
            )
            for t in raw["trucks"]
        ],
        drivers=[
            DriverD(
                id=d["id"],
                full_name=d["full_name"],
                carrier_id=d.get("carrier_id"),
                license_expiry=_date(d.get("license_expiry")),
                hazmat_cert=d.get("hazmat_cert", True),
                hazmat_expiry=_date(d.get("hazmat_expiry")),
                status=d.get("status", "available"),
                available_today=d.get("available_today", True),
                default_truck_id=d.get("default_truck_id"),
            )
            for d in raw["drivers"]
        ],
        orders=[
            OrderD(
                id=o["id"],
                station_id=o["station_id"],
                product_id=o["product_id"],
                requested_l=o["requested_l"],
                priority=OrderPriority(o.get("priority", "normal")),
                window=tuple(o["window"]) if o.get("window") is not None else None,
            )
            for o in raw["orders"]
        ],
        depot_stocks={
            (s["depot_id"], s["product_id"]): s["available_l"] for s in raw.get("depot_stocks", [])
        },
        driver_by_truck=dict(raw.get("driver_by_truck", {})),
        params=params,
        locked_trips=[_trip_from_dict(t) for t in raw.get("locked_trips", [])],
    )
