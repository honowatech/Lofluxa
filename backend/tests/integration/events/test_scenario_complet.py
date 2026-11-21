"""Scénario complet d'une journée avec panne, SANS doublure : vrai moteur OR-Tools, vraies règles.

calcul → publication → chargement → une livraison → panne → nouvelle version → suite des livraisons.
"""

from decimal import Decimal

from sqlalchemy import select

from app.core.enums import OrderStatus, PlanStatus, TruckSize
from app.orders.models import Order
from app.planning import service as planning_service
from app.planning.checking import load_plan
from app.referentials.models import Truck, TruckCompartment
from tests.integration.events.conftest import DAY, at, iso
from tests.integration.events.helpers import advance, deliver, get_plan, start_trip

FAST = {"solver_time_limit_s": 5, "solver_no_improvement_s": 2}


async def test_RM_19_scenario_complet_calcul_publication_livraison_panne_suite(
    client, db, world, dispatcher, auth_headers
):
    headers = await auth_headers("dispatcher")
    fleet = await auth_headers("fleet")

    # 1. Calcul réel, puis publication.
    computed = await planning_service.run_compute(db, world.day, params_override=FAST)
    await db.commit()
    published = await client.post(f"/plans/{computed.id}/publish", headers=headers)
    assert published.status_code == 200, published.text
    v1 = published.json()
    assert v1["unserved"] == [] and v1["blocking_count"] == 0

    # Un camion de réserve arrive après la publication (le moteur ne l'a donc pas utilisé).
    reserve = Truck(
        plate="LT-009-RR",
        carrier_id=world.trucks["LT-001-AA"].carrier_id,
        size=TruckSize.LARGE,
        total_capacity_l=Decimal("30000"),
    )
    reserve.compartments = [
        TruckCompartment(position=1, capacity_l=Decimal("18000")),
        TruckCompartment(position=2, capacity_l=Decimal("12000")),
    ]
    db.add(reserve)
    await db.commit()

    # 2. Les tournées qui précèdent sont réalisées en entier ; la tournée la plus longue est
    #    chargée, part, et livre son premier arrêt.
    trip = max(v1["trips"], key=lambda t: len(t["stops"]))
    assert len(trip["stops"]) >= 2, "le scénario demande une tournée d'au moins deux arrêts"
    before = [t for t in v1["trips"] if t["planned_start_at"] < trip["planned_start_at"]]
    others = [t for t in v1["trips"] if t["id"] != trip["id"] and t not in before]
    for earlier in before:
        await start_trip(client, fleet, earlier)
        for index, stop in enumerate(earlier["stops"]):
            await deliver(client, fleet, stop, hour=7, minute=20 + index)
        await advance(client, fleet, earlier["id"], "completed")
    await start_trip(client, fleet, trip)
    first, rest = trip["stops"][0], trip["stops"][1:]
    await deliver(client, fleet, first, hour=10, minute=20)

    # 3. L'assistant propose le camion de réserve ; panne à 12:00 (heure locale).
    options = await client.get(
        "/events/replacement-options",
        params={"trip_id": trip["id"], "occurred_at": iso(at(11, 0))},
        headers=headers,
    )
    assert options.status_code == 200, options.text
    candidate = next(t for t in options.json()["trucks"] if t["plate"] == "LT-009-RR")
    assert candidate["eligible"] is True, candidate
    response = await client.post(
        "/events/truck-breakdown",
        json={"trip_id": trip["id"], "replacement_truck_id": str(reserve.id), "occurred_at": iso(at(11, 0))},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()

    # 4. Nouvelle version publiée ; l'ancienne est archivée, intacte (RM-18).
    assert body["published"] is True and body["plan_version"] == 2, body["violations"]
    assert body["blocking_count"] == 0
    old = await load_plan(db, v1["id"])
    assert old.status == PlanStatus.ARCHIVED
    assert len(next(t for t in old.trips if str(t.id) == trip["id"]).stops) == len(trip["stops"])
    v2 = body["plan"]
    assert v2["status"] == "published" and v2["engine_version"] == v1["engine_version"]

    # RM-19 : l'arrêt livré reste sur la tournée d'origine ; les autres passent sur la nouvelle.
    origin = next(t for t in v2["trips"] if t["id"] == body["origin_trip_id"])
    assert origin["status"] == "completed" and origin["truck_id"] == trip["truck_id"]
    assert [(s["station_id"], s["status"]) for s in origin["stops"]] == [(first["station_id"], "delivered")]
    assert origin["stops"][0]["actual_arrival_at"] == iso(at(10, 20))
    assert [d["actual_l"] for d in origin["stops"][0]["deliveries"]] == [
        d["planned_l"] for d in first["deliveries"]
    ]
    new = next(t for t in v2["trips"] if t["id"] == body["new_trip_id"])
    assert new["truck_plate"] == "LT-009-RR" and new["driver_id"] and new["status"] == "planned"
    assert [s["station_id"] for s in new["stops"]] == [s["station_id"] for s in rest]
    assert all(s["status"] == "pending" for s in new["stops"])
    assert new["planned_start_at"] >= iso(at(11, 0)) and new["loads"]
    assert round(sum(x["planned_l"] for x in new["loads"])) == round(new["planned_l"])
    # Les autres tournées sont reprises telles quelles, réalisations comprises.
    for other in [*before, *others]:
        copy = next(t for t in v2["trips"] if t["seq"] == other["seq"])
        assert [s["station_id"] for s in copy["stops"]] == [s["station_id"] for s in other["stops"]]
        assert copy["truck_id"] == other["truck_id"]
        assert copy["status"] == ("completed" if other in before else "planned")
    # Le camion en panne est indisponible pour la journée : la tournée qu'il a déjà terminée n'en
    # devient pas fautive (RM-04 ne vaut que pour ce qui reste à faire).
    assert "RM-04" not in {v["rule_code"] for v in body["violations"]}

    # 5. Suite des livraisons sur la nouvelle version : rechargement au dépôt, départ, livraisons.
    await start_trip(client, fleet, new)
    for index, stop in enumerate(new["stops"]):
        await deliver(client, fleet, stop, hour=13 + index, minute=15)
    await advance(client, fleet, new["id"], "completed")
    for other in others:
        copy = next(t for t in v2["trips"] if t["seq"] == other["seq"])
        await start_trip(client, fleet, copy)
        for index, stop in enumerate(copy["stops"]):
            await deliver(client, fleet, stop, hour=9 + index, minute=0)
        await advance(client, fleet, copy["id"], "completed")

    final = await get_plan(client, headers, v2["id"])
    assert {t["status"] for t in final["trips"]} == {"completed"}
    assert all(s["status"] == "delivered" for t in final["trips"] for s in t["stops"])
    statuses = {
        o.status
        for o in (await db.execute(select(Order).execution_options(populate_existing=True))).scalars()
    }
    assert statuses == {OrderStatus.DELIVERED}
    delivered = sum(d["actual_l"] for t in final["trips"] for s in t["stops"] for d in s["deliveries"])
    assert delivered == sum(float(o.requested_l) for o in world.orders.values())

    # Journal de la journée et tableau de bord.
    journal = (
        await client.get("/events", params={"day": DAY.isoformat(), "limit": 200}, headers=fleet)
    ).json()
    types = [e["type"] for e in journal["items"]]
    assert types.count("publish") == 2 and types.count("truck_breakdown") == 1
    assert types.count("delivery_recorded") == sum(len(t["stops"]) for t in v1["trips"])
    dashboard = (await client.get("/dashboard", params={"day": DAY.isoformat()}, headers=fleet)).json()
    assert dashboard["plan"]["id"] == v2["id"]
    assert [a["code"] for a in dashboard["alerts"] if a["source"] == "event"] == ["truck_breakdown"]
