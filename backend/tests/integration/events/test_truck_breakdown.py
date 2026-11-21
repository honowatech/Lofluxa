"""F6.1 — panne de camion : transfert des arrêts non livrés (RM-19), nouvelle version (RM-18)."""

import pytest
from sqlalchemy import func, select

from app.availability.models import DailyResourceStatus
from app.core.enums import OrderStatus, PlanStatus, StopStatus, TripStatus, TruckSize, TruckStatus
from app.events.models import Event
from app.orders.models import Order
from app.planning.checking import load_plan
from app.planning.models import Plan, Trip
from tests.integration.events.conftest import DAY, at, iso
from tests.integration.events.helpers import deliver, get_plan, start_trip, trip_by_seq


def _body(published, world, spare, seq=1, **extra) -> dict:
    trip = next(t for t in published.trips if t.seq == seq)
    return {"trip_id": str(trip.id), "replacement_truck_id": str(spare.truck.id), **extra}


async def test_RM_19_panne_transfere_uniquement_les_arrets_en_attente(
    client, db, auth_headers, world, published, spare
):
    headers = await auth_headers("dispatcher")
    before = await get_plan(client, headers, published.id)
    trip1 = trip_by_seq(before, 1)
    await start_trip(client, headers, trip1)
    await deliver(client, headers, trip1["stops"][0])  # ST-01 livrée à 08:25 locales

    response = await client.post(
        "/events/truck-breakdown",
        json=_body(published, world, spare, occurred_at=iso(at(8, 0)), reason="Fuite hydraulique"),
        headers=headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()

    # RM-18 : nouvelle version publiée, la précédente est archivée, jamais écrasée.
    assert body["plan_version"] == 2 and body["published"] is True and body["version_created"] is True
    assert body["plan_id"] != str(published.id)
    assert body["previous_plan_id"] == str(published.id) and body["previous_plan_status"] == "archived"
    assert body["blocking_count"] == 0, body["violations"]
    old = await load_plan(db, published.id)
    assert old.status == PlanStatus.ARCHIVED
    old_trip = next(t for t in old.trips if t.seq == 1)
    assert [s.status for s in old_trip.stops] == [
        StopStatus.DELIVERED,
        StopStatus.PENDING,
        StopStatus.PENDING,
    ]
    assert old_trip.truck_id == world.trucks["LT-001-AA"].id and old_trip.status == TripStatus.IN_PROGRESS

    # RM-19 : l'arrêt livré reste sur la tournée d'origine, avec ses heures et volumes réels.
    plan = body["plan"]
    origin = next(t for t in plan["trips"] if t["id"] == body["origin_trip_id"])
    assert origin["seq"] == 1 and origin["truck_plate"] == "LT-001-AA" and origin["status"] == "completed"
    assert [(s["station_code"], s["status"]) for s in origin["stops"]] == [("ST-01", "delivered")]
    assert origin["stops"][0]["actual_arrival_at"] == iso(at(7, 25))
    assert origin["stops"][0]["deliveries"][0]["actual_l"] == 10000
    assert body["kept_stop_ids"] == [origin["stops"][0]["id"]]

    # Les arrêts en attente partent sur une nouvelle tournée du camion de remplacement.
    new = next(t for t in plan["trips"] if t["id"] == body["new_trip_id"])
    assert new["seq"] == 3 and new["truck_plate"] == "LT-003-CC" and new["status"] == "planned"
    assert new["driver_name"] == "Abena"  # chauffeur d'origine : le camion de réserve n'en a pas
    assert [(s["station_code"], s["status"]) for s in new["stops"]] == [
        ("ST-02", "pending"),
        ("ST-03", "pending"),
    ]
    assert body["transferred_stop_ids"] == [s["id"] for s in new["stops"]]
    # Recalcul à partir de l'heure de l'événement (09:00 locales), après le retour prévu du chauffeur.
    assert new["planned_start_at"] >= iso(at(8, 0))
    assert new["planned_start_at"] >= origin["planned_return_at"]
    assert new["planned_depart_at"] < new["stops"][0]["planned_arrival_at"] < new["planned_return_at"]
    # Plan de chargement recalculé pour le camion de remplacement.
    compartments = {str(c.id) for c in spare.truck.compartments}
    assert {x["compartment_id"] for x in new["loads"]} <= compartments
    assert sorted(x["planned_l"] for x in new["loads"]) == [6000, 8000]
    assert trip_by_seq(plan, 2)["truck_plate"] == "LT-002-BB"  # l'autre tournée ne bouge pas

    # Le camion en panne est indisponible pour la journée ; son statut de référentiel ne change pas.
    mark = (
        await db.execute(
            select(DailyResourceStatus).where(
                DailyResourceStatus.day == DAY, DailyResourceStatus.truck_id == world.trucks["LT-001-AA"].id
            )
        )
    ).scalar_one()
    assert mark.available is False and "Panne déclarée à 09:00" in mark.reason and "Fuite" in mark.reason
    await db.refresh(world.trucks["LT-001-AA"])
    assert world.trucks["LT-001-AA"].status == TruckStatus.AVAILABLE

    # Commandes : la livrée reste livrée, les autres restent chargées (à recharger au dépôt).
    statuses = {
        k: (await db.execute(select(Order.status).where(Order.id == o.id))).scalar_one()
        for k, o in world.orders.items()
    }
    assert statuses["o1"] == OrderStatus.DELIVERED
    assert statuses["o2"] == statuses["o3"] == OrderStatus.LOADED

    # Journalisation.
    event = body["event"]
    assert event["type"] == "truck_breakdown" and event["type_label"] == "Panne de camion"
    assert event["occurred_at"] == iso(at(8, 0)) and event["actor_name"] == "Test dispatcher"
    assert event["trip_id"] == body["new_trip_id"] and event["plan_id"] == body["plan_id"]
    assert "LT-001-AA" in event["summary"] and "LT-003-CC" in event["summary"]
    assert "2 arrêt(s) non livré(s)" in event["summary"] and "Version 2 publiée" in event["summary"]
    assert event["payload"]["cargo"] == "reload_at_depot"
    assert event["payload"]["transferred_l"] == 14000 and event["payload"]["kept_stops"] == 1


async def test_panne_avant_le_depart_la_tournee_d_origine_disparait(
    client, db, auth_headers, world, published, spare
):
    headers = await auth_headers("dispatcher")
    body = (
        await client.post(
            "/events/truck-breakdown",
            json=_body(published, world, spare, occurred_at=iso(at(5, 30))),
            headers=headers,
        )
    ).json()
    assert body["published"] is True and body["origin_trip_id"] is None
    plan = body["plan"]
    assert sorted(t["seq"] for t in plan["trips"]) == [2, 3]
    new = trip_by_seq(plan, 3)
    assert [s["station_code"] for s in new["stops"]] == ["ST-01", "ST-02", "ST-03"]
    assert new["truck_plate"] == "LT-003-CC" and new["driver_name"] == "Abena"
    assert body["event"]["payload"]["origin_trip_kept"] is False
    # La version 1 garde sa tournée 1 intacte.
    old = await load_plan(db, published.id)
    assert old.status == PlanStatus.ARCHIVED and sorted(t.seq for t in old.trips) == [1, 2]


async def test_chauffeur_remplacant_fourni(client, auth_headers, world, published, spare):
    headers = await auth_headers("dispatcher")
    body = (
        await client.post(
            "/events/truck-breakdown",
            json=_body(published, world, spare, replacement_driver_id=str(world.drivers["Che"].id)),
            headers=headers,
        )
    ).json()
    assert body["driver_id"] == str(world.drivers["Che"].id)
    assert trip_by_seq(body["plan"], 3)["driver_name"] == "Che"


async def test_camion_de_remplacement_deja_engage_la_tournee_s_enchaine(
    client, auth_headers, world, published, spare
):
    """Le camion LT-002-BB a déjà la tournée 2 : la tournée de remplacement part après son retour,
    avec le chauffeur affecté à ce camion pour la journée (Biya)."""
    headers = await auth_headers("dispatcher")
    trip1 = next(t for t in published.trips if t.seq == 1)
    response = await client.post(
        "/events/truck-breakdown",
        json={
            "trip_id": str(trip1.id),
            "replacement_truck_id": str(world.trucks["LT-002-BB"].id),
            "occurred_at": iso(at(5, 30)),
        },
        headers=headers,
    )
    assert response.status_code == 200, response.text
    plan = response.json()["plan"]
    new, other = trip_by_seq(plan, 3), trip_by_seq(plan, 2)
    assert new["truck_plate"] == "LT-002-BB" and new["driver_name"] == "Biya"
    assert new["planned_start_at"] >= other["planned_return_at"]
    assert response.json()["blocking_count"] == 0


async def test_refus_plan_non_publie(client, auth_headers, db, world, plan, spare):
    trip = plan.trips[0]
    response = await client.post(
        "/events/truck-breakdown",
        json={"trip_id": str(trip.id), "replacement_truck_id": str(spare.truck.id)},
        headers=await auth_headers("dispatcher"),
    )
    assert response.status_code == 409 and response.json()["code"] == "plan_not_published"
    assert (await db.execute(select(func.count()).select_from(Plan))).scalar_one() == 1


async def test_refus_tournee_terminee_ou_sans_arret_en_attente(
    client, auth_headers, db, world, published, spare
):
    headers = await auth_headers("dispatcher")
    trip = await db.get(Trip, published.trips[0].id)
    trip.status = TripStatus.COMPLETED
    await db.commit()
    response = await client.post(
        "/events/truck-breakdown", json=_body(published, world, spare), headers=headers
    )
    assert response.status_code == 409 and response.json()["code"] == "trip_completed"
    # Aucune version créée, aucun événement de panne.
    assert (await db.execute(select(func.count()).select_from(Plan))).scalar_one() == 1
    assert (
        await db.execute(select(func.count()).select_from(Event).where(Event.type == "truck_breakdown"))
    ).scalar_one() == 0
    missing = await client.post(
        "/events/truck-breakdown",
        json={"trip_id": "00000000-0000-7000-8000-000000000000", "replacement_truck_id": str(spare.truck.id)},
        headers=headers,
    )
    assert missing.status_code == 404


@pytest.mark.parametrize(
    ("case", "codes"),
    [
        ("maintenance", {"RM-04"}),
        ("indisponible_du_jour", {"RM-04"}),
        ("gabarit", {"RM-09"}),
        ("capacite", {"RM-05"}),
        ("produit_interdit", {"RM-05", "RM-07"}),
    ],
)
async def test_refus_409_camion_de_remplacement_non_eligible(
    client, auth_headers, db, world, published, spare, case, codes
):
    truck = spare.truck
    if case == "maintenance":
        truck.status = TruckStatus.MAINTENANCE
    elif case == "indisponible_du_jour":
        db.add(DailyResourceStatus(day=DAY, truck_id=truck.id, available=False, reason="Contrôle technique"))
    elif case == "gabarit":
        world.stations["ST-02"].max_truck_size = TruckSize.SMALL  # RM-09 : le grand porteur n'y entre pas
    elif case == "capacite":
        truck = spare.small
    else:
        truck = spare.super_only
    await db.commit()
    payload = _body(published, world, spare) | {"replacement_truck_id": str(truck.id)}
    response = await client.post(
        "/events/truck-breakdown", json=payload, headers=await auth_headers("dispatcher")
    )
    assert response.status_code == 409, response.text
    error = response.json()
    assert error["code"] == "rule_violation"
    found = {d["rule_code"] for d in error["details"]}
    assert found & codes and found <= codes | {"RM-06"}, error
    assert all(d["message"] for d in error["details"])
    # Rien n'a changé : la version publiée reste la seule, le camion d'origine n'est pas marqué.
    assert (await db.execute(select(func.count()).select_from(Plan))).scalar_one() == 1
    assert (await load_plan(db, published.id)).status == PlanStatus.PUBLISHED


async def test_refus_meme_camion_et_chauffeur_non_affectable(
    client, auth_headers, db, world, published, spare
):
    headers = await auth_headers("dispatcher")
    same = _body(published, world, spare) | {"replacement_truck_id": str(world.trucks["LT-001-AA"].id)}
    assert (await client.post("/events/truck-breakdown", json=same, headers=headers)).status_code == 422

    world.drivers["Che"].hazmat_cert = False  # RM-03
    await db.commit()
    payload = _body(published, world, spare, replacement_driver_id=str(world.drivers["Che"].id))
    response = await client.post("/events/truck-breakdown", json=payload, headers=headers)
    assert response.status_code == 409
    assert {d["rule_code"] for d in response.json()["details"]} == {"RM-03"}


async def test_violation_bloquante_la_version_reste_en_brouillon_puis_se_poursuit(
    client, auth_headers, db, world, published, spare
):
    """Panne tardive : les stations seront fermées à l'arrivée (RM-10 bloquant). L'événement est
    enregistré, mais la version 2 reste en brouillon et la version 1 reste la référence du terrain."""
    headers = await auth_headers("dispatcher")
    response = await client.post(
        "/events/truck-breakdown",
        json=_body(published, world, spare, occurred_at=iso(at(15, 30))),
        headers=headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["published"] is False and body["plan_status"] == "draft" and body["plan_version"] == 2
    assert body["previous_plan_status"] == "published"
    assert body["blocking_count"] > 0 and {
        v["rule_code"] for v in body["violations"] if v["severity"] == "blocking"
    } == {"RM-10"}
    assert (
        "laissée en brouillon" in body["event"]["summary"] and body["event"]["payload"]["published"] is False
    )

    # Un second événement sur une tournée de la version publiée se poursuit sur le brouillon en cours.
    trip2 = next(t for t in published.trips if t.seq == 2)
    second = await client.post(
        "/events/driver-unavailable",
        json={
            "trip_id": str(trip2.id),
            "replacement_driver_id": str(world.drivers["Che"].id),
            "occurred_at": iso(at(5, 0)),
        },
        headers=headers,
    )
    assert second.status_code == 200, second.text
    assert second.json()["plan_id"] == body["plan_id"] and second.json()["version_created"] is False
    assert second.json()["published"] is False
    assert (await db.execute(select(func.count()).select_from(Plan))).scalar_one() == 2


@pytest.mark.parametrize(
    ("role", "expected"),
    [("dispatcher", 200), ("admin", 200), ("fleet", 403), ("supply", 403), ("manager", 403)],
)
async def test_roles_sur_la_panne(client, auth_headers, world, published, spare, role, expected):
    response = await client.post(
        "/events/truck-breakdown", json=_body(published, world, spare), headers=await auth_headers(role)
    )
    assert response.status_code == expected, response.text
