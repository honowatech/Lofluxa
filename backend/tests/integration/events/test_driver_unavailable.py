"""F6.2 — chauffeur indisponible : un remplaçant reprend la tournée, nouvelle version (RM-18)."""

from datetime import timedelta

import pytest
from sqlalchemy import func, select

from app.availability.models import DailyResourceStatus
from app.core.enums import PlanStatus
from app.planning.checking import load_plan
from app.planning.models import Plan
from tests.integration.events.conftest import DAY, at, iso
from tests.integration.events.helpers import deliver, get_plan, start_trip, trip_by_seq


def _body(published, world, name="Che", seq=1, **extra) -> dict:
    trip = next(t for t in published.trips if t.seq == seq)
    return {"trip_id": str(trip.id), "replacement_driver_id": str(world.drivers[name].id), **extra}


async def test_chauffeur_indisponible_le_remplacant_reprend_la_tournee(
    client, db, auth_headers, world, published, spare
):
    headers = await auth_headers("dispatcher")
    trip1 = trip_by_seq(await get_plan(client, headers, published.id), 1)
    await start_trip(client, headers, trip1)
    await deliver(client, headers, trip1["stops"][0])

    response = await client.post(
        "/events/driver-unavailable",
        json=_body(published, world, occurred_at=iso(at(8, 0)), reason="Malaise"),
        headers=headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["plan_version"] == 2 and body["published"] is True
    assert body["previous_plan_status"] == "archived" and body["new_trip_id"] is None
    trip = next(t for t in body["plan"]["trips"] if t["id"] == body["trip_id"])
    # Même tournée, même camion, même chargement ; les réalisés sont conservés.
    assert trip["seq"] == 1 and trip["truck_plate"] == "LT-001-AA" and trip["driver_name"] == "Che"
    assert trip["status"] == "in_progress"
    assert [s["status"] for s in trip["stops"]] == ["delivered", "pending", "pending"]
    assert trip["stops"][0]["deliveries"][0]["actual_l"] == 10000
    assert trip["planned_start_at"] == trip1["planned_start_at"]  # tournée déjà partie : heures inchangées
    assert len(body["kept_stop_ids"]) == 1 and len(body["transferred_stop_ids"]) == 2

    # La version 1 est archivée avec son chauffeur d'origine.
    old = await load_plan(db, published.id)
    assert old.status == PlanStatus.ARCHIVED
    assert next(t for t in old.trips if t.seq == 1).driver_id == world.drivers["Abena"].id
    mark = (
        await db.execute(
            select(DailyResourceStatus).where(
                DailyResourceStatus.day == DAY, DailyResourceStatus.driver_id == world.drivers["Abena"].id
            )
        )
    ).scalar_one()
    assert mark.available is False and "Malaise" in mark.reason

    event = body["event"]
    assert event["type"] == "driver_unavailable" and event["type_label"] == "Chauffeur indisponible"
    assert (
        "Abena" in event["summary"]
        and "Che" in event["summary"]
        and "2 arrêt(s) restant(s)" in event["summary"]
    )
    assert event["payload"]["unavailable_driver_name"] == "Abena"


async def test_tournee_pas_encore_commencee_ne_demarre_pas_avant_l_evenement(
    client, auth_headers, world, published, spare
):
    body = (
        await client.post(
            "/events/driver-unavailable",
            json=_body(published, world, occurred_at=iso(at(7, 0))),  # 08:00 locales, départ prévu 06:00
            headers=await auth_headers("dispatcher"),
        )
    ).json()
    trip = trip_by_seq(body["plan"], 1)
    assert trip["planned_start_at"] == iso(at(7, 0)) and trip["driver_name"] == "Che"
    assert body["published"] is True


@pytest.mark.parametrize(
    ("case", "code"), [("permis", "RM-03"), ("chevauchement", "RM-02"), ("duree", "RM-11")]
)
async def test_refus_409_chauffeur_remplacant_non_eligible(
    client, auth_headers, db, world, published, spare, case, code
):
    name = "Che"
    if case == "permis":
        world.drivers["Che"].license_expiry = DAY - timedelta(days=1)
    elif case == "chevauchement":
        name = "Biya"  # déjà sur la tournée 2, aux mêmes heures
    else:
        # RM-11 : la durée max de service du plan devient plus courte que la tournée 1.
        plan = await db.get(Plan, published.id)
        plan.params_snapshot = {**plan.params_snapshot, "max_service_hours": 2.0}
    await db.commit()
    response = await client.post(
        "/events/driver-unavailable",
        json=_body(published, world, name),
        headers=await auth_headers("dispatcher"),
    )
    if case == "duree":
        # La tournée dépassait déjà avec son chauffeur : ce n'est pas un reproche fait au remplaçant.
        assert response.status_code == 200, response.text
        assert response.json()["published"] is False
        assert "RM-11" in {v["rule_code"] for v in response.json()["violations"]}
        return
    assert response.status_code == 409, response.text
    assert response.json()["code"] == "rule_violation"
    assert {d["rule_code"] for d in response.json()["details"]} == {code}
    assert (await db.execute(select(func.count()).select_from(Plan))).scalar_one() == 1
    assert (await load_plan(db, published.id)).status == PlanStatus.PUBLISHED


async def test_RM_11_cumul_journalier_du_remplacant(client, auth_headers, db, world, published, spare):
    """Biya a déjà la tournée 2 ; on décale la tournée 1 après elle (plus de chevauchement) : le
    cumul des deux tournées dépasse la durée max de service → refus RM-11."""
    plan = await db.get(Plan, published.id)
    plan.params_snapshot = {**plan.params_snapshot, "max_service_hours": 4.0}
    await db.commit()
    response = await client.post(
        "/events/driver-unavailable",
        json=_body(published, world, "Biya", occurred_at=iso(at(9, 0))),
        headers=await auth_headers("dispatcher"),
    )
    assert response.status_code == 409, response.text
    assert {d["rule_code"] for d in response.json()["details"]} == {"RM-11"}


async def test_refus_meme_chauffeur_plan_non_publie_tournee_terminee(
    client, auth_headers, db, world, plan, spare
):
    headers = await auth_headers("dispatcher")
    trip = plan.trips[0]
    payload = {"trip_id": str(trip.id), "replacement_driver_id": str(world.drivers["Che"].id)}
    response = await client.post("/events/driver-unavailable", json=payload, headers=headers)
    assert response.status_code == 409 and response.json()["code"] == "plan_not_published"

    from app.planning import service as planning_service

    await planning_service.publish_plan(db, plan.id)
    await db.commit()
    same = payload | {"replacement_driver_id": str(trip.driver_id)}
    assert (await client.post("/events/driver-unavailable", json=same, headers=headers)).status_code == 422
    unknown = payload | {"replacement_driver_id": "00000000-0000-7000-8000-000000000000"}
    assert (await client.post("/events/driver-unavailable", json=unknown, headers=headers)).status_code == 404


@pytest.mark.parametrize(
    ("role", "expected"),
    [("dispatcher", 200), ("admin", 200), ("fleet", 403), ("supply", 403), ("manager", 403)],
)
async def test_roles_sur_le_chauffeur_indisponible(
    client, auth_headers, world, published, spare, role, expected
):
    response = await client.post(
        "/events/driver-unavailable", json=_body(published, world), headers=await auth_headers(role)
    )
    assert response.status_code == expected, response.text
