# ruff: noqa: F811  (fixtures pytest importées puis reçues en paramètre)
"""Vue Fleet et versions de plan : seules les tournées des versions en vigueur sont listées.

S'appuie sur le jeu de données et les routes réelles des lots L5 (plans) et L10 (événements).
"""

from tests.integration.events.conftest import (  # noqa: F401
    DAY,
    at,
    auth_headers,
    dispatcher,
    fakes,
    iso,
    plan,
    published,
    spare,
    world,
)
from tests.integration.events.helpers import deliver, get_plan, start_trip, trip_by_seq


async def test_apres_une_panne_seule_la_version_en_vigueur_est_listee(
    client,
    auth_headers,
    world,
    published,
    spare,
):
    headers = await auth_headers("dispatcher")
    before = await get_plan(client, headers, published.id)
    listed = (await client.get("/loadings", params={"day": DAY.isoformat()}, headers=headers)).json()
    assert {item["plan_id"] for item in listed["items"]} == {str(published.id)}
    assert {item["plan_version"] for item in listed["items"]} == {1}
    assert sorted(item["id"] for item in listed["items"]) == sorted(t["id"] for t in before["trips"])

    trip1 = trip_by_seq(before, 1)
    await start_trip(client, headers, trip1)
    await deliver(client, headers, trip1["stops"][0])
    response = await client.post(
        "/events/truck-breakdown",
        json={
            "trip_id": trip1["id"],
            "replacement_truck_id": str(spare.truck.id),
            "occurred_at": iso(at(8, 0)),
        },
        headers=headers,
    )
    assert response.status_code == 200, response.text
    event = response.json()
    assert event["plan_version"] == 2 and event["previous_plan_status"] == "archived"

    listed = (await client.get("/loadings", params={"day": DAY.isoformat()}, headers=headers)).json()

    # La v1 archivée a disparu : plus de doublon de « Tournée 1 ».
    assert {item["plan_id"] for item in listed["items"]} == {event["plan_id"]}
    assert {item["plan_version"] for item in listed["items"]} == {2}
    assert all("plan_label" in item for item in listed["items"])
    assert listed["total"] == len(event["plan"]["trips"]) == len(listed["items"])
    assert sorted(item["id"] for item in listed["items"]) == sorted(t["id"] for t in event["plan"]["trips"])
    by_id = {item["id"]: item for item in listed["items"]}
    assert by_id[event["new_trip_id"]]["truck_plate"] == "LT-003-CC"
    assert by_id[event["new_trip_id"]]["status"] == "planned"
    assert by_id[event["new_trip_id"]]["loading_recorded"] is False
    assert by_id[event["origin_trip_id"]]["status"] == "completed"
    assert [item["seq"] for item in listed["items"]].count(1) == 1
