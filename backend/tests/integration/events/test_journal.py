"""F6.4 — journal de la journée : tous les événements, tous modules confondus."""

from datetime import timedelta

from tests.integration.events.conftest import DAY, at, iso
from tests.integration.events.helpers import deliver, get_plan, start_trip, trip_by_seq


async def test_journal_de_la_journee(client, auth_headers, world, published, spare):
    dispatcher = await auth_headers("dispatcher")
    trip1 = trip_by_seq(await get_plan(client, dispatcher, published.id), 1)
    await start_trip(client, await auth_headers("fleet"), trip1)
    await deliver(client, await auth_headers("fleet"), trip1["stops"][0])
    breakdown = (
        await client.post(
            "/events/truck-breakdown",
            json={
                "trip_id": trip1["id"],
                "replacement_truck_id": str(spare.truck.id),
                "occurred_at": iso(at(8, 0)),
            },
            headers=dispatcher,
        )
    ).json()
    shortage = await client.post(
        "/events/product-shortage",
        json={
            "depot_id": str(world.depot.id),
            "product_id": str(world.products["SUPER"].id),
            "new_available_l": 150000,
            "day": DAY.isoformat(),
        },
        headers=await auth_headers("supply"),
    )
    assert shortage.status_code == 200

    # Lecture ouverte à tout rôle authentifié.
    response = await client.get(
        "/events", params={"day": DAY.isoformat()}, headers=await auth_headers("manager")
    )
    assert response.status_code == 200, response.text
    page = response.json()
    items = page["items"]
    assert page["total"] == len(items) and page["limit"] == 50 and page["offset"] == 0
    types = [e["type"] for e in items]
    # Événements écrits par les autres modules (plans, chargement) et par les événements du jour.
    assert set(types) == {
        "publish",
        "loading_recorded",
        "delivery_recorded",
        "manual_edit",
        "truck_breakdown",
        "product_shortage",
    }
    assert types.count("publish") == 2  # version 1, puis version 2 après la panne
    assert [e["occurred_at"] for e in items] == sorted((e["occurred_at"] for e in items), reverse=True)
    for event in items:
        assert event["type_label"] and event["summary"] and event["actor_name"], event
        assert event["day"] == DAY.isoformat() and event["occurred_at"].endswith("Z")

    by_type = {e["type"]: e for e in items}
    loading = by_type["loading_recorded"]
    assert loading["type_label"] == "Chargement enregistré" and loading["actor_name"] == "Test fleet"
    assert (
        loading["summary"]
        == "Chargement enregistré (bon BL-0001) : 24 000 L à 15 °C pour 24 000 L planifiés (écart +0,00 %)."
    )
    assert loading["trip_seq"] == 1 and loading["truck_plate"] == "LT-001-AA" and loading["plan_version"] == 1
    delivery = by_type["delivery_recorded"]
    assert delivery["summary"] == "Arrêt 1 (ST-01) livré : 10 000 L pour 10 000 L planifiés."
    assert by_type["manual_edit"]["action"] == "new_version"
    assert (
        by_type["truck_breakdown"]["trip_seq"] == 3
        and by_type["truck_breakdown"]["truck_plate"] == "LT-003-CC"
    )
    assert by_type["product_shortage"]["actor_name"] == "Test supply"

    async def listing(**params):
        result = await client.get("/events", params={"day": DAY.isoformat(), **params}, headers=dispatcher)
        assert result.status_code == 200, result.text
        return result.json()

    # Filtre par type (un ou plusieurs).
    only = await listing(type=["truck_breakdown", "product_shortage"])
    assert {e["type"] for e in only["items"]} == {"truck_breakdown", "product_shortage"} and only[
        "total"
    ] == 2
    # Filtre par tournée : la panne cite la tournée d'origine (ancienne et nouvelle version) et la nouvelle.
    for trip_id in (trip1["id"], breakdown["origin_trip_id"], breakdown["new_trip_id"]):
        assert "truck_breakdown" in {e["type"] for e in (await listing(trip_id=trip_id))["items"]}
    assert {e["type"] for e in (await listing(trip_id=trip1["id"]))["items"]} == {
        "loading_recorded",
        "delivery_recorded",
        "truck_breakdown",
    }
    # Filtre par plan : une version, ou toute la lignée.
    v2 = {e["type"] for e in (await listing(plan_id=breakdown["plan_id"]))["items"]}
    # (la pénurie, déclarée ensuite, est rattachée au seul plan publié du jour : la version 2)
    assert v2 == {"manual_edit", "truck_breakdown", "publish", "product_shortage"}
    lineage = await listing(plan_id=breakdown["plan_id"], include_versions=True, type="publish")
    assert sorted(e["plan_version"] for e in lineage["items"]) == [1, 2]
    # Pagination.
    paged = await listing(limit=2, offset=1)
    assert paged["total"] == page["total"] and [e["id"] for e in paged["items"]] == [
        e["id"] for e in items[1:3]
    ]
    # Un autre jour : rien.
    other = await client.get(
        "/events", params={"day": (DAY + timedelta(days=1)).isoformat()}, headers=dispatcher
    )
    assert other.json()["items"] == [] and other.json()["total"] == 0

    detail = await client.get(f"/events/{breakdown['event']['id']}", headers=await auth_headers("supply"))
    assert detail.status_code == 200 and detail.json()["summary"] == breakdown["event"]["summary"]
    assert (await client.get("/events", params={"day": DAY.isoformat()})).status_code == 401
    assert (await client.get("/events", headers=dispatcher)).status_code == 200  # défaut : aujourd'hui


async def test_journal_arret_saute_et_chargement_hors_tolerance(
    client, auth_headers, world, published, spare
):
    fleet = await auth_headers("fleet")
    trip2 = trip_by_seq(await get_plan(client, fleet, published.id), 2)
    lines = [
        {
            "compartment_id": load["compartment_id"],
            "product_id": load["product_id"],
            "observed_l": load["planned_l"] * 0.9,
            "observed_temp_c": 15,
        }
        for load in trip2["loads"]
    ]
    assert (
        await client.post(f"/trips/{trip2['id']}/loading", json={"lines": lines}, headers=fleet)
    ).status_code == 200
    for status in ("at_depot", "loaded", "in_progress"):
        await client.put(f"/trips/{trip2['id']}/status", json={"status": status}, headers=fleet)
    skipped = await client.put(
        f"/stops/{trip2['stops'][0]['id']}/delivery",
        json={"skip_reason": "Station fermée", "actual_arrival_at": iso(at(8, 0))},
        headers=fleet,
    )
    assert skipped.status_code == 200, skipped.text
    items = (await client.get("/events", params={"day": DAY.isoformat()}, headers=fleet)).json()["items"]
    summaries = {e["type"]: e["summary"] for e in items}
    assert summaries["delivery_recorded"] == "Arrêt 1 (ST-04) non livré : Station fermée."
    assert summaries["loading_recorded"].endswith("(écart -10,00 %) — hors tolérance (RM-13).")
