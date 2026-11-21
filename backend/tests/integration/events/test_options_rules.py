"""Assistant de réaffectation (écran 6) et exemption RM-03 / RM-04 des tournées déjà réalisées."""

from datetime import date, timedelta

from sqlalchemy import func, select

from app.core.enums import TruckSize, TruckStatus
from app.planning.domain import DriverD, PlanningProblem, StationD, StopD, TripD, TruckD
from app.planning.models import Plan
from app.planning.violations import rules
from tests.integration.events.conftest import DAY, at, iso


async def test_options_de_remplacement(client, auth_headers, db, world, published, spare):
    world.drivers["Che"].license_expiry = DAY - timedelta(days=3)
    spare.super_only.status = TruckStatus.MAINTENANCE
    await db.commit()
    trip1 = next(t for t in published.trips if t.seq == 1)
    response = await client.get(
        "/events/replacement-options",
        params={"trip_id": str(trip1.id), "occurred_at": iso(at(5, 30))},
        headers=await auth_headers("manager"),  # lecture : tout rôle authentifié
    )
    assert response.status_code == 200, response.text
    body = response.json()

    trip = body["trip"]
    assert trip["seq"] == 1 and trip["truck_plate"] == "LT-001-AA" and trip["driver_name"] == "Abena"
    assert trip["pending_stops"] == 3 and trip["delivered_stops"] == 0 and trip["pending_l"] == 24000
    assert trip["pending_station_codes"] == ["ST-01", "ST-02", "ST-03"]
    assert trip["can_replace_truck"] is True and trip["plan_status"] == "published"

    trucks = {t["plate"]: t for t in body["trucks"]}
    assert set(trucks) == {"LT-002-BB", "LT-003-CC", "LT-004-DD", "LT-005-EE"}  # pas le camion en panne
    assert trucks["LT-003-CC"]["eligible"] is True and trucks["LT-003-CC"]["reasons"] == []
    assert trucks["LT-003-CC"]["suggested_driver_name"] == "Abena"
    assert trucks["LT-002-BB"]["eligible"] is True and trucks["LT-002-BB"]["other_trip_seqs"] == [2]
    assert (
        trucks["LT-002-BB"]["assigned_driver_name"] == trucks["LT-002-BB"]["suggested_driver_name"] == "Biya"
    )
    assert trucks["LT-004-DD"]["eligible"] is False
    assert {r["rule_code"] for r in trucks["LT-004-DD"]["reasons"]} == {"RM-05"}
    assert trucks["LT-005-EE"]["eligible"] is False
    assert trucks["LT-005-EE"]["reasons"] == [{"rule_code": "RM-04", "message": "Camion en maintenance."}]
    assert body["trucks"][0]["plate"] == "LT-003-CC"  # éligibles et libres d'abord

    # Chauffeurs : évalués pour reprendre la tournée telle quelle (F6.2).
    drivers = {d["full_name"]: d for d in body["drivers"]}
    assert body["drivers_evaluated_for_truck_id"] == str(trip1.truck_id)
    assert drivers["Abena"]["is_current"] is True and drivers["Abena"]["eligible"] is False
    assert drivers["Biya"]["eligible"] is False and drivers["Biya"]["other_trip_seqs"] == [2]
    assert {r["rule_code"] for r in drivers["Biya"]["reasons"]} == {"RM-02"}
    assert drivers["Che"]["eligible"] is False and drivers["Che"]["reasons"][0]["rule_code"] == "RM-03"
    assert "Permis" in drivers["Che"]["reasons"][0]["message"]

    # Lecture seule : aucune version créée.
    assert (await db.execute(select(func.count()).select_from(Plan))).scalar_one() == 1

    # Chauffeurs évalués pour la tournée de remplacement d'un camion donné (F6.1).
    world.drivers["Che"].license_expiry = DAY + timedelta(days=30)
    await db.commit()
    response = await client.get(
        "/events/replacement-options",
        params={
            "trip_id": str(trip1.id),
            "replacement_truck_id": str(spare.truck.id),
            "occurred_at": iso(at(5, 30)),
        },
        headers=await auth_headers("fleet"),
    )
    drivers = {d["full_name"]: d for d in response.json()["drivers"]}
    assert response.json()["drivers_evaluated_for_truck_id"] == str(spare.truck.id)
    assert drivers["Abena"]["eligible"] is True and drivers["Che"]["eligible"] is True
    assert drivers["Biya"]["eligible"] is False  # tournée 2 aux mêmes heures


async def test_options_tournee_terminee_ou_plan_non_publie(client, auth_headers, db, world, plan, spare):
    headers = await auth_headers("dispatcher")
    trip = plan.trips[0]
    response = await client.get(
        "/events/replacement-options", params={"trip_id": str(trip.id)}, headers=headers
    )
    assert response.status_code == 409 and response.json()["code"] == "plan_not_published"
    assert (
        await client.get("/events/replacement-options", params={"trip_id": str(trip.id)})
    ).status_code == 401


def _problem() -> PlanningProblem:
    return PlanningProblem(
        day=date(2027, 1, 12),
        products=[],
        depots=[],
        stations=[StationD(id="S1", code="S1", lat=4.0, lon=9.7)],
        trucks=[
            TruckD(id="T1", plate="LT-1", size=TruckSize.LARGE, compartments=(), status=TruckStatus.BROKEN)
        ],
        drivers=[DriverD(id="D1", full_name="Abena", available_today=False)],
        orders=[],
    )


def _trip(status: str) -> TripD:
    return TripD(seq=1, truck_id="T1", depot_id="DEP", driver_id="D1", stops=[StopD(1, "S1", status=status)])


def test_RM_04_camion_en_panne_tournee_deja_realisee_non_fautive():
    assert [v.rule_code for v in rules.rm_04_truck_eligible(_problem(), [_trip("pending")])] == ["RM-04"]
    assert rules.rm_04_truck_eligible(_problem(), [_trip("delivered")]) == []
    assert rules.rm_04_truck_eligible(_problem(), [_trip("skipped")]) == []


def test_RM_03_chauffeur_indisponible_tournee_deja_realisee_non_fautive():
    assert [v.rule_code for v in rules.rm_03_driver_eligible(_problem(), [_trip("pending")])] == ["RM-03"]
    assert rules.rm_03_driver_eligible(_problem(), [_trip("delivered")]) == []
