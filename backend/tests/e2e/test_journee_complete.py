"""Scénario complet d'une journée (démo du jalon J4) sur `demo_douala`, importé par les fichiers.

import → stocks → confirmation → calcul → lecture du plan → déplacement d'un arrêt → verrouillage +
recalcul → publication → feuilles de route PDF → arrivée au dépôt → chargement (15 °C, fiche PDF) →
livraisons (dont un arrêt sauté) → tournées terminées → tableau de bord → journal d'audit.

Tout passe par l'API HTTP ; vrai moteur, vraies règles (voir `tests/e2e/conftest.py`).
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta

import pytest

from tests.e2e.conftest import load

SUPER_COEFF, GASOIL_COEFF, PETROLE_COEFF = 0.00120, 0.00085, 0.00095
COEFF = {"SUPER": SUPER_COEFF, "GASOIL": GASOIL_COEFF, "PETROLE": PETROLE_COEFF}


def _ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


async def _plan(api, plan_id: str, role: str = "dispatcher") -> dict:
    return (await api.call("GET", f"/plans/{plan_id}", role)).json()


async def _order_statuses(api, day) -> Counter:
    orders = await api.get_all("/orders", "dispatcher", day=day.isoformat())
    return Counter(o["status"] for o in orders)


def _served(plan: dict) -> set[str]:
    return {d["order_id"] for t in plan["trips"] for s in t["stops"] for d in s["deliveries"]}


def _signature(trip: dict) -> tuple:
    return (trip["truck_id"], trip["driver_id"], tuple(s["station_id"] for s in trip["stops"]))


async def _move_one_stop(api, plan: dict) -> tuple[dict, dict]:
    """Déplace un arrêt d'une tournée vers une autre, en gardant un plan publiable.

    Essaie les déplacements possibles dans l'ordre ; un déplacement qui crée une violation bloquante
    est annulé (l'arrêt est remis à sa place) et le suivant est essayé. Renvoie le plan après le
    déplacement retenu et sa description. Les déplacements refusés par les règles sont comptés :
    le recontrôle immédiat (F5.2) est ainsi vérifié dans les deux sens."""
    rejected = 0
    for source in plan["trips"]:
        if len(source["stops"]) < 2:
            continue  # déplacer l'unique arrêt supprimerait la tournée : on garde un cas simple
        for stop in source["stops"]:
            for target in plan["trips"]:
                if target["id"] == source["id"]:
                    continue
                moved = (
                    await api.call(
                        "POST",
                        f"/plans/{plan['id']}/trips/{source['id']}/move-stop",
                        "dispatcher",
                        json={"stop_id": stop["id"], "to_trip_id": target["id"], "to_seq": 1},
                    )
                ).json()
                if moved["blocking_count"] == 0:
                    return moved, {
                        "stop_id": stop["id"],
                        "station_code": stop["station_code"],
                        "from_trip": source["id"],
                        "to_trip": target["id"],
                        "rejected_before": rejected,
                    }
                rejected += 1
                assert moved["publishable"] is False
                back = (
                    await api.call(
                        "POST",
                        f"/plans/{plan['id']}/trips/{target['id']}/move-stop",
                        "dispatcher",
                        json={"stop_id": stop["id"], "to_trip_id": source["id"], "to_seq": stop["seq"]},
                    )
                ).json()
                assert back["blocking_count"] == 0, back["violations"]
    raise AssertionError("Aucun déplacement d'arrêt ne laisse le plan sans violation bloquante.")


async def test_journee_complete_de_l_import_a_la_livraison(api, db, tasks):
    # ------------------------------------------------------------------ import, stocks, confirmation
    summary = await load(api, "demo_douala")
    day = summary.day
    assert {k: v["created"] for k, v in summary.imports.items()} == {
        "depots": 1,
        "stations": 12,
        "trucks": 4,
        "drivers": 5,
        "orders": 20,
    }
    assert summary.stocks_entered == 3 and summary.orders_confirmed == 20 and summary.confirm_warnings == 0
    assert await _order_statuses(api, day) == {"confirmed": 20}
    stations = await api.get_all("/stations", "dispatcher")
    assert len(stations) == 12 and all(s["lat"] and s["lon"] for s in stations)  # « sur la carte »
    day_summary = (
        await api.call("GET", "/availability/summary", "dispatcher", params={"day": day.isoformat()})
    ).json()
    assert day_summary["depot_stocks"]["complete"] is True
    assert day_summary["trucks"]["assignable"] == 4 and day_summary["drivers"]["assignable"] == 5

    # ------------------------------------------------------------------ calcul (F4)
    task_id = await api.start_compute(day, summary.compute_params)
    computed = await tasks.run(db, task_id)
    plan = await _plan(api, str(computed.id))
    assert plan["kind"] == "computed" and plan["status"] == "draft" and plan["version"] == 1
    assert plan["approximate"] is True  # pas d'OSRM ici : repli haversine
    assert plan["unserved"] == [] and plan["blocking_count"] == 0, plan["violations"]
    assert plan["publishable"] is True
    all_orders = {o["id"] for o in await api.get_all("/orders", "dispatcher", day=day.isoformat())}
    assert _served(plan) == all_orders
    assert plan["computed_in_ms"] < 10_000  # §7.5 : solution ≤ 10 s
    assert plan["params_snapshot"]["solver_time_limit_s"] == 6 and plan["engine_version"]
    for trip in plan["trips"]:
        assert trip["status"] == "planned" and trip["driver_id"] and trip["loads"]
        assert trip["planned_depart_at"] < trip["planned_return_at"] and trip["distance_m"] > 0
        assert all(s["status"] == "pending" for s in trip["stops"])
    assert await _order_statuses(api, day) == {"confirmed": 20}  # un brouillon ne change rien aux commandes

    # ------------------------------------------------------------------ déplacement d'un arrêt (F5.1, F5.2)
    distance_before = sum(t["distance_m"] for t in plan["trips"])
    plan, move = await _move_one_stop(api, plan)
    target = next(t for t in plan["trips"] if t["id"] == move["to_trip"])
    assert target["stops"][0]["id"] == move["stop_id"]
    assert [s["seq"] for s in target["stops"]] == list(range(1, len(target["stops"]) + 1))
    assert sum(t["distance_m"] for t in plan["trips"]) != distance_before  # distances recalculées
    assert _served(plan) == all_orders and plan["blocking_count"] == 0

    # ------------------------------------------------------------------ verrouillage + recalcul (F5.3, RM-17)
    locked = (await api.call("POST", f"/plans/{plan['id']}/trips/{target['id']}/lock", "dispatcher")).json()
    locked_trip = next(t for t in locked["trips"] if t["id"] == target["id"])
    assert locked_trip["locked"] is True
    task_id = (
        await api.call(
            "POST",
            f"/plans/{plan['id']}/recompute",
            "dispatcher",
            json={"params": summary.compute_params},
            expected=(202,),
        )
    ).json()["task_id"]
    recomputed = await tasks.run(db, task_id)
    assert str(recomputed.id) == plan["id"]  # un brouillon est recalculé sur place
    plan = await _plan(api, plan["id"])
    kept = [t for t in plan["trips"] if t["locked"]]
    assert len(kept) == 1 and kept[0]["id"] == locked_trip["id"]
    assert _signature(kept[0]) == _signature(locked_trip)
    assert kept[0]["planned_depart_at"] == locked_trip["planned_depart_at"]
    assert plan["unserved"] == [] and plan["blocking_count"] == 0, plan["violations"]
    assert _served(plan) == all_orders

    # ------------------------------------------------------------------ publication (F5.4)
    forbidden = await api.call("POST", f"/plans/{plan['id']}/publish", "fleet", expected=(403,))
    assert forbidden.json()["code"]
    published = (await api.call("POST", f"/plans/{plan['id']}/publish", "dispatcher")).json()
    assert published["status"] == "published"
    assert await _order_statuses(api, day) == {"planned": 20}
    plans = await api.get_all("/plans", "manager", day=day.isoformat())
    assert [(p["status"], p["kind"]) for p in plans] == [("published", "computed")]
    versions = await api.get_all(f"/plans/{plan['id']}/versions", "manager")
    assert len(versions) == 1 and versions[0]["is_current"] is True
    actions = [c["action"] for c in versions[0]["changes"]]
    assert {"move_stop", "lock", "recompute", "publish"} <= set(actions), actions

    # ------------------------------------------------------------------ feuilles de route PDF (§11)
    sheets = await api.call("GET", f"/plans/{plan['id']}/route-sheets.pdf", "manager")
    assert sheets.headers["content-type"] == "application/pdf" and sheets.content.startswith(b"%PDF")
    trips = sorted(published["trips"], key=lambda t: t["planned_depart_at"])
    one = await api.call("GET", f"/trips/{trips[0]['id']}/route-sheet.pdf", "fleet")
    assert one.content.startswith(b"%PDF") and len(one.content) < len(sheets.content)

    # ------------------------------------------------------------------ dépôt, chargement, livraisons (F7)
    skipped_stop_id = None
    skipped_orders: set[str] = set()
    hot_trip_id = trips[1]["id"]  # chargée à 36 °C : écart à 15 °C hors tolérance (RM-13)
    for index, trip in enumerate(trips):
        trip_id = trip["id"]
        start = _ts(trip["planned_start_at"])
        depart = _ts(trip["planned_depart_at"])

        # Un chargement ne s'enregistre pas « chargé » sans avoir été saisi ; l'ordre des statuts est imposé.
        skip_step = await api.call(
            "PUT", f"/trips/{trip_id}/status", "fleet", json={"status": "loaded"}, expected=(409,)
        )
        assert skip_step.json()["code"] == "invalid_transition"
        at_depot = (
            await api.call("PUT", f"/trips/{trip_id}/status", "fleet", json={"status": "at_depot"})
        ).json()
        assert at_depot["status"] == "at_depot" and at_depot["loading_recorded"] is False
        missing = await api.call(
            "PUT", f"/trips/{trip_id}/status", "fleet", json={"status": "loaded"}, expected=(409,)
        )
        assert missing.json()["code"] == "loading_missing"

        temperature = 36.0 if trip_id == hot_trip_id else 27.0
        loading = (
            await api.call(
                "POST",
                f"/trips/{trip_id}/loading",
                "fleet",
                json={
                    "arrived_at": _iso(start),
                    "started_at": _iso(start + timedelta(minutes=80)),
                    "finished_at": _iso(depart - timedelta(minutes=5)),
                    "depot_ticket_no": f"BC-{index + 1:04d}",
                    "lines": [
                        {
                            "compartment_id": line["compartment_id"],
                            "product_id": line["product_id"],
                            "observed_l": line["planned_l"],
                            "observed_temp_c": temperature,
                            "observed_density": 0.75,
                        }
                        for line in trip["loads"]
                    ],
                },
            )
        ).json()
        # RM-12 : volume à 15 °C = volume observé × [1 − coefficient × (température − 15)].
        assert len(loading["lines"]) == len(trip["loads"])
        for line in loading["lines"]:
            expected = line["observed_l"] * (1 - COEFF[line["product_code"]] * (temperature - 15))
            assert line["volume_15_l"] == pytest.approx(expected, abs=0.01), line
            assert line["planned_l"] == line["observed_l"] and line["observed_density"] == 0.75
        assert loading["volume_15_total_l"] == pytest.approx(
            sum(line["volume_15_l"] for line in loading["lines"]), abs=0.05
        )
        assert loading["depot_ticket_no"] == f"BC-{index + 1:04d}" and loading["conversion_note"]
        # RM-13 : à 27 °C l'écart reste sous 2 % (1,44 % au plus) ; à 36 °C le super le dépasse (2,52 %).
        has_super = any(line["product_code"] == "SUPER" for line in loading["lines"])
        if trip_id == hot_trip_id and has_super:
            assert loading["out_of_tolerance"] is True and loading["warning_message"]
        if trip_id != hot_trip_id:
            assert loading["out_of_tolerance"] is False and loading["warning_message"] is None

        sheet = await api.call("GET", f"/trips/{trip_id}/loading-sheet.pdf", "fleet")
        assert sheet.headers["content-type"] == "application/pdf" and sheet.content.startswith(b"%PDF")

        loaded = (
            await api.call("PUT", f"/trips/{trip_id}/status", "fleet", json={"status": "loaded"})
        ).json()
        assert loaded["status"] == "loaded" and loaded["loading_recorded"] is True
        trip_orders = {d["order_id"] for s in trip["stops"] for d in s["deliveries"]}
        orders = {o["id"]: o for o in await api.get_all("/orders", "fleet", day=day.isoformat())}
        assert {orders[o]["status"] for o in trip_orders} == {"loaded"}

        # Une livraison ne se saisit pas avant le départ du dépôt.
        early = await api.call(
            "PUT",
            f"/stops/{trip['stops'][0]['id']}/delivery",
            "fleet",
            json={"skip_reason": "trop tôt"},
            expected=(409,),
        )
        assert early.json()["code"] == "trip_not_in_progress"
        running = (
            await api.call(
                "PUT",
                f"/trips/{trip_id}/status",
                "fleet",
                json={"status": "in_progress", "actual_depart_at": _iso(depart + timedelta(minutes=10))},
            )
        ).json()
        assert running["status"] == "in_progress" and running["actual_depart_at"]

        for stop in trip["stops"]:
            arrival = _ts(stop["planned_arrival_at"]) + timedelta(minutes=20)
            # Le dernier arrêt de la dernière tournée est sauté (station fermée à l'arrivée).
            if index == len(trips) - 1 and stop is trip["stops"][-1]:
                # Tant qu'il reste un arrêt en attente, la tournée ne se termine pas.
                pending = await api.call(
                    "PUT", f"/trips/{trip_id}/status", "fleet", json={"status": "completed"}, expected=(409,)
                )
                assert pending.json()["code"] == "stops_pending"
                done = (
                    await api.call(
                        "PUT",
                        f"/stops/{stop['id']}/delivery",
                        "dispatcher",
                        json={
                            "skip_reason": "Station fermée à l'arrivée",
                            "actual_arrival_at": _iso(arrival),
                        },
                    )
                ).json()
                assert done["status"] == "skipped" and done["skip_reason"] == "Station fermée à l'arrivée"
                assert all(d["actual_l"] is None for d in done["deliveries"])
                assert {d["order_status"] for d in done["deliveries"]} == {"confirmed"}  # à replanifier
                skipped_stop_id = stop["id"]
                skipped_orders = {d["order_id"] for d in stop["deliveries"]}
                continue
            done = (
                await api.call(
                    "PUT",
                    f"/stops/{stop['id']}/delivery",
                    "fleet",
                    json={
                        "actual_arrival_at": _iso(arrival),
                        "actual_departure_at": _iso(arrival + timedelta(minutes=40)),
                        "deliveries": [
                            {"order_id": d["order_id"], "actual_l": d["planned_l"]}
                            for d in stop["deliveries"]
                        ],
                    },
                )
            ).json()
            assert done["status"] == "delivered"
            assert {d["order_status"] for d in done["deliveries"]} == {"delivered"}
            assert all(d["actual_l"] == d["planned_l"] for d in done["deliveries"])
        assert done["trip_all_stops_done"] is True

        closed = (
            await api.call(
                "PUT",
                f"/trips/{trip_id}/status",
                "fleet",
                json={
                    "status": "completed",
                    "actual_return_at": _iso(_ts(trip["planned_return_at"]) + timedelta(minutes=25)),
                    "actual_distance_m": trip["distance_m"] + 1500,
                },
            )
        ).json()
        assert closed["status"] == "completed" and closed["actual_distance_m"] == trip["distance_m"] + 1500
        assert closed["stops_done"] == closed["stop_count"] == len(trip["stops"])
        # Une tournée terminée ne change plus.
        again = await api.call(
            "PUT", f"/trips/{trip_id}/status", "fleet", json={"status": "completed"}, expected=(409,)
        )
        assert again.json()["code"] == "invalid_transition"

    # ------------------------------------------------------------------ fin de journée : statuts
    assert skipped_stop_id and skipped_orders
    statuses = await _order_statuses(api, day)
    assert statuses == {"delivered": 20 - len(skipped_orders), "confirmed": len(skipped_orders)}
    final = await _plan(api, plan["id"], "manager")
    assert final["status"] == "published"
    assert {t["status"] for t in final["trips"]} == {"completed"}
    stop_statuses = Counter(s["status"] for t in final["trips"] for s in t["stops"])
    total_stops = sum(len(t["stops"]) for t in trips)
    assert stop_statuses == {"delivered": total_stops - 1, "skipped": 1}
    rm13 = [v for v in final["violations"] if v["rule_code"] == "RM-13"]
    assert final["blocking_count"] == 0
    assert all(v["severity"] == "warning" and v["trip_id"] == hot_trip_id for v in rm13)
    loadings = await api.get_all("/loadings", "fleet", day=day.isoformat())
    assert len(loadings) == len(trips) and all(item["loading_recorded"] for item in loadings)

    # ------------------------------------------------------------------ tableau de bord (F8.6)
    board = (await api.call("GET", "/dashboard", "manager", params={"day": day.isoformat()})).json()
    assert board["plan"]["id"] == plan["id"]
    board_summary = board["summary"]
    assert board_summary["trips_total"] == len(trips)
    by_status = board_summary["trips_by_status"]
    assert by_status["completed"] == len(trips) and sum(by_status.values()) == len(trips)
    assert board_summary["stops_total"] == total_stops
    assert board_summary["stops_delivered"] == total_stops - 1
    assert board_summary["stops_skipped"] == 1 and board_summary["stops_pending"] == 0
    skipped_volume = sum(
        d["planned_l"]
        for t in trips
        for s in t["stops"]
        if s["id"] == skipped_stop_id
        for d in s["deliveries"]
    )
    assert board_summary["volume_planned_l"] == pytest.approx(100_000)
    assert board_summary["volume_delivered_l"] == pytest.approx(100_000 - skipped_volume)
    assert board_summary["trips_late"] == len(trips) and board_summary["max_delay_s"] >= 20 * 60
    assert len(board["delays"]) >= total_stops - 1  # chaque arrêt livré l'a été 20 min après l'heure prévue
    assert board_summary["alerts_blocking"] == 0
    assert bool(rm13) == any(a["code"] == "RM-13" for a in board["alerts"])

    # ------------------------------------------------------------------ journal d'audit (F9.3)
    await api.call("GET", "/audit", "fleet", expected=(403,))
    for table in ("plans", "trips", "loadings", "daily_depot_stocks"):
        page = (await api.call("GET", "/audit", "manager", params={"table": table, "limit": 1})).json()
        assert page["total"] > 0, f"aucune écriture journalisée sur {table}"
    plan_audit = await api.get_all("/audit", "manager", table="plans", row_id=plan["id"])
    published_entry = next(e for e in plan_audit if (e["after"] or {}).get("status") == "published")
    assert published_entry["action"] == "update" and published_entry["actor_email"].startswith("dispatcher@")
    trip_audit = await api.get_all("/audit", "manager", table="trips", row_id=trips[0]["id"])
    trip_statuses = [(e["after"] or {}).get("status") for e in reversed(trip_audit)]
    seen = [s for s in trip_statuses if s]
    assert seen[-4:] == ["at_depot", "loaded", "in_progress", "completed"], seen
    assert {e["actor_email"] for e in trip_audit if (e["after"] or {}).get("status") == "loaded"} == {
        "fleet@demo.tourneo.cm"
    }
