"""Aides des tests des événements : faire avancer une tournée par l'API du chargement (lot L6)."""

from __future__ import annotations

from datetime import timedelta

from tests.integration.events.conftest import at, iso


async def get_plan(client, headers, plan_id) -> dict:
    response = await client.get(f"/plans/{plan_id}", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def trip_by_seq(plan_body: dict, seq: int) -> dict:
    return next(t for t in plan_body["trips"] if t["seq"] == seq)


async def record_loading(client, headers, trip: dict) -> None:
    """Chargement conforme au plan de chargement, à 15 °C."""
    payload = {
        "depot_ticket_no": f"BL-{trip['seq']:04d}",
        "lines": [
            {
                "compartment_id": load["compartment_id"],
                "product_id": load["product_id"],
                "observed_l": load["planned_l"],
                "observed_temp_c": 15,
            }
            for load in trip["loads"]
        ],
    }
    response = await client.post(f"/trips/{trip['id']}/loading", json=payload, headers=headers)
    assert response.status_code == 200, response.text


async def advance(client, headers, trip_id, *statuses) -> None:
    for status in statuses:
        response = await client.put(f"/trips/{trip_id}/status", json={"status": status}, headers=headers)
        assert response.status_code == 200, response.text


async def start_trip(client, headers, trip: dict) -> None:
    """Chargement enregistré, puis `at_depot` → `loaded` → `in_progress`."""
    await record_loading(client, headers, trip)
    await advance(client, headers, trip["id"], "at_depot", "loaded", "in_progress")


async def deliver(client, headers, stop: dict, *, hour: int = 7, minute: int = 25) -> dict:
    payload = {
        "actual_arrival_at": iso(at(hour, minute)),
        "actual_departure_at": iso(at(hour, minute) + timedelta(minutes=30)),
        "deliveries": [{"order_id": d["order_id"], "actual_l": d["planned_l"]} for d in stop["deliveries"]],
    }
    response = await client.put(f"/stops/{stop['id']}/delivery", json=payload, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()
