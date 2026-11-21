"""Lecture d'un plan et édition manuelle (F5.1, F5.2) par l'API."""

from sqlalchemy import select

from app.core.enums import EventType, Severity, TruckStatus
from app.events.models import Event
from app.planning.domain import ViolationD


def _trip(body, seq):
    return next(t for t in body["trips"] if t["seq"] == seq)


async def _get(client, auth_headers, plan_id, role="dispatcher"):
    response = await client.get(f"/plans/{plan_id}", headers=await auth_headers(role))
    assert response.status_code == 200, response.text
    return response.json()


async def test_lecture_exige_une_authentification_et_ecriture_le_role_dispatcher(client, auth_headers, plan):
    # Identifiants relevés d'abord : une réponse en erreur annule la transaction et périme les objets.
    plan_url, lock_url = f"/plans/{plan.id}", f"/plans/{plan.id}/trips/{plan.trips[0].id}/lock"
    assert (await client.get(plan_url)).status_code == 401
    for role in ("fleet", "supply", "manager"):
        assert (await client.get(plan_url, headers=await auth_headers(role))).status_code == 200
        assert (await client.post(lock_url, headers=await auth_headers(role))).status_code == 403
        assert (await client.post(f"{plan_url}/publish", headers=await auth_headers(role))).status_code == 403
    assert (await client.post(lock_url, headers=await auth_headers("admin"))).status_code == 200


async def test_liste_des_plans_par_jour(client, auth_headers, plan, world):
    headers = await auth_headers("manager")
    body = (await client.get("/plans", params={"day": "2027-01-12"}, headers=headers)).json()
    assert body["total"] == 1 and body["limit"] == 50 and body["offset"] == 0
    item = body["items"][0]
    assert item["id"] == str(plan.id) and item["status"] == "draft" and item["version"] == 1
    assert item["publishable"] is True and item["metrics"]["trips_count"] == 2
    assert "trips" not in item
    assert (await client.get("/plans", params={"day": "2027-01-13"}, headers=headers)).json()["total"] == 0
    assert (await client.get("/plans", params={"status": "published"}, headers=headers)).json()["total"] == 0


async def test_plan_complet_avec_libelles(client, auth_headers, plan, world):
    body = await _get(client, auth_headers, plan.id, "manager")
    assert body["day"] == "2027-01-12" and body["kind"] == "computed" and body["approximate"] is True
    assert body["engine_version"] == "fake-1.0" and body["params_snapshot"]["max_service_hours"] == 11.0
    assert body["created_by_name"] == "Test dispatcher"
    assert body["blocking_count"] == 0 and body["unserved"] == [] and body["violations"] == []

    trip = _trip(body, 1)
    assert trip["truck_plate"] == "LT-001-AA" and trip["truck_size"] == "large"
    assert trip["truck_capacity_l"] == 30000.0 and trip["driver_name"] == "Abena"
    assert trip["depot_code"] == "SCDP-DLA" and trip["depot_name"] == "SCDP Douala"
    assert round(trip["depot_lat"], 4) == 4.0483 and round(trip["depot_lon"], 4) == 9.7043
    # RM-20 : horodatages en UTC (08:15 à Douala = 07:15Z).
    assert trip["planned_depart_at"] == "2027-01-12T07:15:00Z"
    assert trip["planned_l"] == 24000.0 and trip["fill_rate"] == 0.8
    assert trip["status"] == "planned" and trip["locked"] is False

    stop = trip["stops"][0]
    assert stop["seq"] == 1 and stop["station_code"] == "ST-01" and stop["station_name"] == "Station 1"
    assert round(stop["lat"], 2) == 4.06 and round(stop["lon"], 2) == 9.72
    assert stop["contact_name"] == "Gérant 1" and stop["status"] == "pending"
    assert stop["planned_arrival_at"].endswith("Z") and stop["distance_from_prev_m"] > 0
    delivery = stop["deliveries"][0]
    assert delivery["product_code"] == "SUPER" and delivery["product_label"] == "Super"
    assert delivery["planned_l"] == 10000.0 and delivery["requested_l"] == 10000.0
    assert delivery["order_id"] == str(world.orders["o1"].id) and delivery["priority"] == "normal"

    loads = trip["loads"]
    assert [x["compartment_position"] for x in loads] == [1, 2]
    assert (
        loads[0]["product_code"] == "SUPER"
        and loads[0]["planned_l"] == 16000.0
        and loads[0]["capacity_l"] == 18000.0
    )
    assert (
        await client.get("/plans/018f0000-0000-7000-8000-000000000000", headers=await auth_headers())
    ).status_code == 404


async def test_move_stop_recalcule_et_journalise(client, auth_headers, db, plan, world):
    first, second = plan.trips
    stop = first.stops[2]  # ST-03
    before = await _get(client, auth_headers, plan.id)
    response = await client.post(
        f"/plans/{plan.id}/trips/{first.id}/move-stop",
        json={"stop_id": str(stop.id), "to_trip_id": str(second.id), "to_seq": 1},
        headers=await auth_headers(),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["id"] == str(plan.id)  # brouillon : modifié sur place
    t1, t2 = _trip(body, 1), _trip(body, 2)
    assert [s["station_code"] for s in t1["stops"]] == ["ST-01", "ST-02"]
    assert [(s["seq"], s["station_code"]) for s in t2["stops"]] == [(1, "ST-03"), (2, "ST-04")]
    # Distances, durées et heures recalculées immédiatement.
    assert (
        t1["distance_m"] != _trip(before, 1)["distance_m"]
        and t2["distance_m"] > _trip(before, 2)["distance_m"]
    )
    assert t2["planned_return_at"] > _trip(before, 2)["planned_return_at"]
    assert t2["stops"][1]["planned_arrival_at"] > _trip(before, 2)["stops"][0]["planned_arrival_at"]
    # Taux de remplissage et plan de chargement recalculés.
    assert t1["planned_l"] == 18000.0 and t1["fill_rate"] == 0.6
    assert t2["planned_l"] == 20000.0 and t2["fill_rate"] == round(20000 / 30000, 4)
    assert {(x["product_code"], x["planned_l"]) for x in t2["loads"]} == {
        ("SUPER", 11000.0),
        ("GASOIL", 9000.0),
    }
    assert body["metrics"]["total_distance_m"] == t1["distance_m"] + t2["distance_m"]

    events = (await db.execute(select(Event).where(Event.plan_id == plan.id))).scalars().all()
    assert len(events) == 1
    event = events[0]
    assert event.type == EventType.MANUAL_EDIT and event.day == world.day and event.trip_id == second.id
    assert event.actor_id is not None and event.occurred_at is not None
    assert event.payload["action"] == "move_stop" and event.payload["station_code"] == "ST-03"
    assert "tournée 1" in event.payload["summary"] and "tournée 2" in event.payload["summary"]


async def test_move_stop_avec_violations_se_sauvegarde(client, auth_headers, plan, fakes):
    """F5.2 : un plan avec violations s'enregistre ; avertissement orange, bloquant rouge."""
    fakes.rules.extra = [
        ViolationD("RM-10", Severity.WARNING, "Arrivée 12 min après la fermeture.", trip_seq=1, stop_seq=2),
        ViolationD("RM-11", Severity.BLOCKING, "Durée de service dépassée.", trip_seq=2),
    ]
    first, second = plan.trips
    response = await client.post(
        f"/plans/{plan.id}/trips/{first.id}/move-stop",
        json={"stop_id": str(first.stops[0].id), "to_trip_id": str(first.id), "to_seq": 3},
        headers=await auth_headers(),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert [s["station_code"] for s in _trip(body, 1)["stops"]] == ["ST-02", "ST-03", "ST-01"]
    blocking, warning = body["violations"]  # bloquantes en tête
    assert (blocking["rule_code"], blocking["severity"], blocking["trip_seq"]) == ("RM-11", "blocking", 2)
    assert blocking["trip_id"] == str(second.id) and blocking["stop_id"] is None
    assert (warning["rule_code"], warning["severity"], warning["stop_seq"]) == ("RM-10", "warning", 2)
    assert warning["stop_id"] == _trip(body, 1)["stops"][1]["id"]
    assert body["publishable"] is False and body["blocking_count"] == 1 and body["warning_count"] == 1
    assert _trip(body, 2)["blocking_count"] == 1 and _trip(body, 1)["warning_count"] == 1
    assert body["metrics"]["blocking_count"] == 1


async def test_move_stop_chargement_impossible_et_tournee_videe(client, auth_headers, plan):
    first, second = plan.trips
    response = await client.post(
        f"/plans/{plan.id}/trips/{second.id}/move-stop",
        json={"stop_id": str(second.stops[0].id), "to_trip_id": str(first.id), "to_seq": 1},
        headers=await auth_headers(),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    # La tournée 2, vidée, est supprimée ; 38 000 L ne tiennent pas dans le camion de la tournée 1.
    assert [t["seq"] for t in body["trips"]] == [1]
    trip = body["trips"][0]
    assert [s["station_code"] for s in trip["stops"]] == ["ST-04", "ST-01", "ST-02", "ST-03"]
    assert trip["loads"] == [] and trip["fill_rate"] > 1
    # RM-05 bloquante (une par produit qui ne tient pas), pas une erreur 500.
    found = {(v["rule_code"], v["severity"], v["trip_seq"]) for v in body["violations"]}
    assert found == {("RM-05", "blocking", 1)} and body["publishable"] is False
    assert body["metrics"]["trips_count"] == 1


async def test_move_stop_demandes_invalides(client, auth_headers, plan):
    first, second = plan.trips
    headers = await auth_headers()
    url = f"/plans/{plan.id}/trips/{first.id}/move-stop"
    payload = {"stop_id": str(first.stops[0].id), "to_trip_id": str(second.id), "to_seq": 3}
    wrong = {"stop_id": str(second.stops[0].id), "to_trip_id": str(second.id), "to_seq": 1}
    response = await client.post(url, json=payload, headers=headers)
    assert response.status_code == 422 and response.json()["details"][0]["field"] == "to_seq"
    assert (await client.post(url, json={**payload, "to_seq": 0}, headers=headers)).status_code == 422
    # Arrêt d'une autre tournée, tournée inconnue.
    assert (await client.post(url, json=wrong, headers=headers)).status_code == 404
    unknown = {**payload, "to_trip_id": "018f0000-0000-7000-8000-000000000000", "to_seq": 1}
    response = await client.post(url, json=unknown, headers=headers)
    assert response.status_code == 404 and response.json()["code"] == "not_found"


async def test_reorder(client, auth_headers, db, plan):
    first = plan.trips[0]
    ids = [str(s.id) for s in first.stops]
    other_stop = str(plan.trips[1].stops[0].id)
    before = first.distance_m
    url = f"/plans/{plan.id}/trips/{first.id}/reorder"
    headers = await auth_headers()
    response = await client.post(url, json={"stop_ids": [ids[2], ids[0], ids[1]]}, headers=headers)
    assert response.status_code == 200, response.text
    trip = _trip(response.json(), 1)
    assert [(s["seq"], s["station_code"]) for s in trip["stops"]] == [
        (1, "ST-03"),
        (2, "ST-01"),
        (3, "ST-02"),
    ]
    assert trip["distance_m"] != before
    arrivals = [s["planned_arrival_at"] for s in trip["stops"]]
    assert arrivals == sorted(arrivals)
    assert sum(s["distance_from_prev_m"] for s in trip["stops"]) < trip["distance_m"]
    event = (await db.execute(select(Event).where(Event.plan_id == plan.id))).scalar_one()
    assert event.payload["action"] == "reorder" and event.payload["after"] == [ids[2], ids[0], ids[1]]

    for bad in ([ids[0], ids[1]], [ids[0], ids[0], ids[1]], [*ids[:2], other_stop]):
        assert (await client.post(url, json={"stop_ids": bad}, headers=headers)).status_code == 422


async def test_assign_camion_et_chauffeur(client, auth_headers, db, plan, world):
    first, second = plan.trips
    headers = await auth_headers()
    url = f"/plans/{plan.id}/trips/{first.id}/assign"

    response = await client.post(url, json={"driver_id": str(world.drivers["Che"].id)}, headers=headers)
    assert response.status_code == 200, response.text
    trip = _trip(response.json(), 1)
    assert trip["driver_name"] == "Che" and trip["truck_plate"] == "LT-001-AA"

    # Chauffeur retiré : la violation RM-01 est enregistrée, pas refusée (vraies règles du lot L1).
    body = (await client.post(url, json={"driver_id": None}, headers=headers)).json()
    assert _trip(body, 1)["driver_id"] is None
    assert [v["rule_code"] for v in body["violations"]] == ["RM-01"] and body["publishable"] is False

    # Camion en maintenance : accepté avec violation RM-04 ; le plan de chargement suit le nouveau camion.
    world.trucks["LT-002-BB"].status = TruckStatus.MAINTENANCE
    await db.flush()
    payload = {"truck_id": str(world.trucks["LT-002-BB"].id), "driver_id": str(world.drivers["Abena"].id)}
    body = (await client.post(url, json=payload, headers=headers)).json()
    trip = _trip(body, 1)
    assert trip["truck_plate"] == "LT-002-BB" and trip["driver_name"] == "Abena"
    assert {x["compartment_id"] for x in trip["loads"]} <= {
        str(c.id) for c in world.trucks["LT-002-BB"].compartments
    }
    assert {v["rule_code"] for v in body["violations"]} == {"RM-04"}
    # Deux tournées sur le même camion : la seconde ne commence pas avant le retour de la première.
    t1, t2 = sorted(body["trips"], key=lambda t: t["planned_start_at"])
    assert t2["planned_start_at"] >= t1["planned_return_at"]

    events = (await db.execute(select(Event).where(Event.plan_id == plan.id))).scalars().all()
    assert [e.payload["action"] for e in events] == ["assign"] * 3
    assert any(e.payload.get("to_truck_plate") == "LT-002-BB" for e in events)

    assert (await client.post(url, json={}, headers=headers)).status_code == 422
    unknown = {"truck_id": "018f0000-0000-7000-8000-000000000000"}
    assert (await client.post(url, json=unknown, headers=headers)).status_code == 404
    assert (
        await client.post(url, json={"driver_id": unknown["truck_id"]}, headers=headers)
    ).status_code == 404


async def test_lock_et_unlock(client, auth_headers, db, plan):
    trip = plan.trips[0]
    headers = await auth_headers()
    missing = f"/plans/{plan.id}/trips/018f0000-0000-7000-8000-000000000000/lock"
    body = (await client.post(f"/plans/{plan.id}/trips/{trip.id}/lock", headers=headers)).json()
    assert _trip(body, 1)["locked"] is True and _trip(body, 2)["locked"] is False
    body = (await client.post(f"/plans/{plan.id}/trips/{trip.id}/unlock", headers=headers)).json()
    assert _trip(body, 1)["locked"] is False
    events = (
        await db.execute(select(Event).where(Event.plan_id == plan.id).order_by(Event.occurred_at))
    ).scalars()
    assert [e.payload["action"] for e in events] == ["lock", "unlock"]
    assert (await client.post(missing, headers=headers)).status_code == 404


async def test_A1_report_d_une_urgente_non_servie_met_le_plan_a_jour(
    client, auth_headers, db, world, fakes, dispatcher
):
    """Après `POST /orders/{id}/postpone`, le plan brouillon relu est cohérent sans autre action :
    plus de RM-15, `blocking_count` et `publishable` à jour."""
    from app.planning import service

    urgent_id = world.orders["o3"].id
    fakes.engine.skip = {str(urgent_id)}
    plan_id = (await service.run_compute(db, world.day)).id
    await db.commit()
    headers = await auth_headers()

    body = await _get(client, auth_headers, plan_id)
    assert [v["rule_code"] for v in body["violations"]] == ["RM-15"] and body["publishable"] is False

    response = await client.post(f"/orders/{urgent_id}/postpone", headers=headers)
    assert response.status_code == 200 and response.json()["status"] == "postponed"

    body = await _get(client, auth_headers, plan_id)
    assert body["unserved"][0]["order_status"] == "postponed"  # toujours listée
    assert body["violations"] == [] and body["blocking_count"] == 0 and body["publishable"] is True
    assert body["metrics"]["blocking_count"] == 0
    assert (await client.post(f"/plans/{plan_id}/publish", headers=headers)).status_code == 200


async def test_A1_annulation_recontrole_seulement_les_brouillons(db, world, plan, fakes, dispatcher):
    from app.core.enums import OrderStatus
    from app.planning import service

    published = await service.publish_plan(db, plan.id)
    calls = fakes.rules.calls
    world.orders["o1"].status = OrderStatus.CANCELLED
    assert await service.recheck_drafts_for_orders(db, [world.orders["o1"].id]) == []
    assert fakes.rules.calls == calls and published.status == "published"
    assert await service.recheck_drafts_for_orders(db, []) == []


async def test_A3_tous_les_compartiments_du_camion(client, auth_headers, plan, world):
    """`compartments` liste tous les compartiments du camion, vides compris, dans l'ordre des
    positions ; `loads` (compartiments chargés) est inchangé."""
    headers = await auth_headers()
    first = plan.trips[0]
    move = {"stop_id": str(first.stops[1].id), "to_trip_id": str(plan.trips[1].id), "to_seq": 1}
    body = (
        await client.post(f"/plans/{plan.id}/trips/{first.id}/move-stop", json=move, headers=headers)
    ).json()
    # Tournée 1 : il ne reste que du Super (16 000 L) → compartiment 1 chargé, compartiment 2 vide.
    trip = _trip(body, 1)
    found = [
        (x["compartment_position"], x["product_code"], x["planned_l"], x["capacity_l"])
        for x in trip["compartments"]
    ]
    assert found == [(1, "SUPER", 16000.0, 18000.0), (2, None, 0.0, 12000.0)]
    assert trip["compartments"][1]["product_id"] is None
    assert trip["compartments"][1]["compartment_id"] == str(world.trucks["LT-001-AA"].compartments[1].id)
    assert [(x["compartment_position"], x["product_code"]) for x in trip["loads"]] == [(1, "SUPER")]
    assert all(x["id"] and x["product_id"] for x in trip["loads"])


async def test_A5_reponses_d_edition_portent_last_edit(client, auth_headers, plan):
    headers = await auth_headers()
    first, second = plan.trips
    base = f"/plans/{plan.id}/trips/{first.id}"
    ids = [str(s.id) for s in first.stops]

    assert "last_edit" in (body := await _get(client, auth_headers, plan.id)) and body["last_edit"] is None
    body = (await client.post(f"{base}/lock", headers=headers)).json()
    assert body["last_edit"] == {"action": "lock", "summary": "Tournée 1 verrouillée."}
    body = (await client.post(f"{base}/unlock", headers=headers)).json()
    assert body["last_edit"] == {"action": "unlock", "summary": "Tournée 1 déverrouillée."}
    body = (await client.post(f"{base}/reorder", json={"stop_ids": ids[::-1]}, headers=headers)).json()
    assert body["last_edit"] == {"action": "reorder", "summary": "Arrêts de la tournée 1 réordonnés."}
    body = (await client.post(f"{base}/assign", json={"driver_id": None}, headers=headers)).json()
    assert body["last_edit"] == {"action": "assign", "summary": "Tournée 1 : chauffeur retiré."}
    move = {"stop_id": ids[0], "to_trip_id": str(second.id), "to_seq": 1}
    body = (await client.post(f"{base}/move-stop", json=move, headers=headers)).json()
    assert body["last_edit"]["action"] == "move_stop" and "ST-01" in body["last_edit"]["summary"]
    assert (await _get(client, auth_headers, plan.id))["last_edit"] is None  # lecture : pas de résumé
