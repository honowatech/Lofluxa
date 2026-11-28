# ruff: noqa: F811  (fixtures pytest importées puis reçues en paramètre)
"""RM-13 après une panne (écart E4) : le chargement se compare au planifié du moment du chargement.

Après une panne, la tournée d'origine ne garde que les arrêts déjà livrés : son plan de chargement est
réduit, mais le camion a bien été chargé pour le plan d'origine. Aucun écart RM-13 ne doit apparaître.
"""

from sqlalchemy import select

from app.planning.models import ConstraintViolation
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


async def _rm_13(db, trip_ids) -> list[ConstraintViolation]:
    rows = await db.execute(
        select(ConstraintViolation).where(
            ConstraintViolation.rule_code == "RM-13", ConstraintViolation.trip_id.in_(trip_ids)
        )
    )
    return list(rows.scalars())


async def test_RM_13_pas_d_ecart_sur_la_tournee_d_origine_apres_une_panne(
    client, db, auth_headers, world, published, spare
):
    headers = await auth_headers("dispatcher")
    before = await get_plan(client, headers, published.id)
    trip1 = trip_by_seq(before, 1)
    await start_trip(client, headers, trip1)  # chargement conforme au plan, à 15 °C
    await deliver(client, headers, trip1["stops"][0])
    loaded = (await client.get(f"/trips/{trip1['id']}/loading", headers=headers)).json()
    assert loaded["out_of_tolerance"] is False
    assert await _rm_13(db, [trip1["id"]]) == []

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
    origin_id = event["origin_trip_id"]

    listed = (await client.get("/loadings", params={"day": DAY.isoformat()}, headers=headers)).json()
    origin = next(item for item in listed["items"] if item["id"] == origin_id)
    # La tournée d'origine ne porte plus que l'arrêt livré : son plan courant est inférieur au chargement…
    assert origin["loading_recorded"] is True
    assert origin["planned_total_l"] < origin["loading"]["volume_15_total_l"]
    # … mais l'écart se mesure contre le planifié au moment du chargement : aucun avertissement.
    assert origin["loading"]["out_of_tolerance"] is False
    assert origin["loading"]["gap_l"] == 0

    detail = (await client.get(f"/trips/{origin_id}/loading", headers=headers)).json()
    assert detail["out_of_tolerance"] is False
    assert detail["warning_message"] is None
    assert detail["planned_total_l"] == loaded["planned_total_l"] == detail["volume_15_total_l"]
    assert all(line["out_of_tolerance"] is False and line["gap_l"] == 0 for line in detail["lines"])

    # Aucune violation RM-13, ni recopiée ni nouvelle, sur les tournées de la nouvelle version.
    new_trip_ids = [t["id"] for t in event["plan"]["trips"]]
    assert await _rm_13(db, new_trip_ids) == []
    assert [v for v in event["plan"]["violations"] if v["rule_code"] == "RM-13"] == []


async def test_RM_13_un_ecart_reel_de_chargement_reste_signale_apres_une_panne(
    client, db, auth_headers, world, published, spare
):
    headers = await auth_headers("dispatcher")
    before = await get_plan(client, headers, published.id)
    trip1 = trip_by_seq(before, 1)
    # Chargement réellement hors tolérance : −10 % sur chaque compartiment.
    payload = {
        "lines": [
            {
                "compartment_id": load["compartment_id"],
                "product_id": load["product_id"],
                "observed_l": load["planned_l"] * 0.9,
                "observed_temp_c": 15,
            }
            for load in trip1["loads"]
        ]
    }
    recorded = await client.post(f"/trips/{trip1['id']}/loading", json=payload, headers=headers)
    assert recorded.json()["out_of_tolerance"] is True
    for status in ("at_depot", "loaded", "in_progress"):
        await client.put(f"/trips/{trip1['id']}/status", json={"status": status}, headers=headers)
    await deliver(client, headers, trip1["stops"][0])

    response = await client.post(
        "/events/truck-breakdown",
        json={"trip_id": trip1["id"], "replacement_truck_id": str(spare.truck.id)},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    origin_id = response.json()["origin_trip_id"]

    detail = (await client.get(f"/trips/{origin_id}/loading", headers=headers)).json()
    # L'écart d'origine (−10 %) est conservé tel quel, ni aggravé ni effacé par la panne.
    assert detail["out_of_tolerance"] is True
    assert detail["gap_pct"] == -10
    assert len(await _rm_13(db, [origin_id])) == 1
