"""Vue Fleet (écran 7) : GET /loadings?day=&depot_id="""

from datetime import date

from app.core.enums import PlanStatus
from app.core.geo import point
from app.referentials.models import Depot
from tests.integration.loading.factory import DAY, make_trip_scenario


async def test_tournees_du_jour_avec_etat_de_chargement(client, db, auth_headers, scenario, products):
    headers = await auth_headers("fleet")
    yaounde = Depot(code="SCDP-YDE", name="SCDP Yaoundé", location=point(3.8480, 11.5021))
    db.add(yaounde)
    await db.flush()
    other_depot = await make_trip_scenario(db, products, suffix="-Y", depot=yaounde)
    await make_trip_scenario(db, products, suffix="-D", plan_status=PlanStatus.DRAFT)
    await make_trip_scenario(db, products, suffix="-L", day=date(2027, 1, 13))
    bad = scenario.loading_payload()
    bad["lines"][0] = scenario.line(scenario.compartments[0], "SUPER", 9000, 15)
    await client.post(f"/trips/{scenario.trip.id}/loading", json=bad, headers=headers)

    response = await client.get(
        "/loadings", params={"day": DAY.isoformat()}, headers=await auth_headers("manager")
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == 2
    assert body["limit"] == 50 and body["offset"] == 0
    by_id = {item["id"]: item for item in body["items"]}
    assert set(by_id) == {str(scenario.trip.id), str(other_depot.trip.id)}  # ni brouillon, ni lendemain
    loaded = by_id[str(scenario.trip.id)]
    assert loaded["day"] == "2027-01-12"
    assert loaded["status"] == "planned"
    assert loaded["truck_plate"] == "LT-123-AB"
    assert loaded["driver_name"] == "Jean Mbarga"
    assert loaded["depot_code"] == "SCDP-DLA"
    assert loaded["planned_start_at"] == "2027-01-12T05:00:00Z"
    assert loaded["planned_total_l"] == 25000
    assert loaded["stop_count"] == 2 and loaded["stops_done"] == 0
    assert loaded["loading_recorded"] is True
    assert loaded["loading"]["volume_15_total_l"] == 24000
    assert loaded["loading"]["gap_pct"] == -4
    assert loaded["loading"]["out_of_tolerance"] is True
    assert loaded["loading"]["depot_ticket_no"] == "BL-2027-0042"
    pending = by_id[str(other_depot.trip.id)]
    assert pending["loading_recorded"] is False and pending["loading"] is None

    filtered = await client.get(
        "/loadings", params={"day": DAY.isoformat(), "depot_id": str(yaounde.id)}, headers=headers
    )
    assert [item["id"] for item in filtered.json()["items"]] == [str(other_depot.trip.id)]
    assert filtered.json()["items"][0]["depot_name"] == "SCDP Yaoundé"

    paged = await client.get(
        "/loadings", params={"day": DAY.isoformat(), "limit": 1, "offset": 1}, headers=headers
    )
    assert paged.json()["total"] == 2 and len(paged.json()["items"]) == 1


async def test_jour_par_defaut_aujourd_hui_et_liste_vide(client, auth_headers, scenario):
    response = await client.get("/loadings", headers=await auth_headers("supply"))
    assert response.status_code == 200
    assert response.json() == {"items": [], "total": 0, "limit": 50, "offset": 0}


async def test_parametre_day_invalide_422(client, auth_headers):
    response = await client.get(
        "/loadings", params={"day": "12/01/2027"}, headers=await auth_headers("fleet")
    )
    assert response.status_code == 422
