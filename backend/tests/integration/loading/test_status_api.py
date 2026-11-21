"""F7.4 — statuts de tournée et d'arrêt, livraisons, répercussion sur les commandes."""

import pytest
from sqlalchemy import select

from app.audit.models import AuditLog
from app.core.enums import EventType, OrderStatus, PlanStatus, StopStatus, TripStatus
from app.events.models import Event
from tests.integration.loading.factory import at, iso, make_trip_scenario


async def _advance(client, headers, trip_id, *statuses, **extra):
    response = None
    for status in statuses:
        response = await client.put(
            f"/trips/{trip_id}/status", json={"status": status, **extra}, headers=headers
        )
        assert response.status_code == 200, response.text
    return response


async def _to_in_progress(client, headers, scenario):
    await client.post(f"/trips/{scenario.trip.id}/loading", json=scenario.loading_payload(), headers=headers)
    await _advance(client, headers, scenario.trip.id, "at_depot", "loaded", "in_progress")


def _deliver(scenario, stop_index, **overrides) -> dict:
    stop = scenario.stops[stop_index]
    payload = {
        "actual_arrival_at": iso(at(8, 40)),
        "actual_departure_at": iso(at(9, 20)),
        "deliveries": [
            {"order_id": str(d.order_id), "actual_l": float(d.planned_l)} for d in stop.deliveries
        ],
    }
    payload.update(overrides)
    return payload


# ── Machine à états de la tournée ─────────────────────────────────────────────


async def test_parcours_complet_d_une_tournee(client, db, auth_headers, scenario):
    headers = await auth_headers("fleet")
    trip_id = scenario.trip.id

    body = (await _advance(client, headers, trip_id, "at_depot")).json()
    assert body["status"] == "at_depot"
    assert body["truck_plate"] == "LT-123-AB"
    assert body["driver_name"] == "Jean Mbarga"
    assert body["depot_code"] == "SCDP-DLA"
    assert body["loading_recorded"] is False
    assert body["planned_total_l"] == 25000

    await client.post(f"/trips/{trip_id}/loading", json=scenario.loading_payload(), headers=headers)
    body = (await _advance(client, headers, trip_id, "loaded")).json()
    assert body["loading_recorded"] is True
    assert body["loading"]["volume_15_total_l"] == 25000
    # Les commandes de la tournée passent à `loaded`.
    assert {o.status for o in scenario.orders} == {OrderStatus.LOADED}

    body = (await _advance(client, headers, trip_id, "in_progress", actual_depart_at=iso(at(7, 25)))).json()
    assert body["actual_depart_at"] == "2027-01-12T07:25:00Z"

    for index in (0, 1):
        response = await client.put(
            f"/stops/{scenario.stops[index].id}/delivery", json=_deliver(scenario, index), headers=headers
        )
        assert response.status_code == 200, response.text
    assert response.json()["trip_all_stops_done"] is True
    assert {o.status for o in scenario.orders} == {OrderStatus.DELIVERED}

    response = await client.put(
        f"/trips/{trip_id}/status",
        json={"status": "completed", "actual_return_at": iso(at(11, 50)), "actual_distance_m": 43800},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "completed"
    assert body["actual_return_at"] == "2027-01-12T11:50:00Z"
    assert body["actual_distance_m"] == 43800
    assert body["stops_done"] == body["stop_count"] == 2
    assert scenario.trip.status == TripStatus.COMPLETED

    # F9.3 : les changements de statut sont audités (table `trips`).
    audits = (
        (
            await db.execute(
                select(AuditLog).where(AuditLog.table_name == "trips").order_by(AuditLog.at, AuditLog.id)
            )
        )
        .scalars()
        .all()
    )
    statuses = [a.after["status"] for a in audits if a.action == "update" and "status" in a.after]
    assert statuses == ["at_depot", "loaded", "in_progress", "completed"]


@pytest.mark.parametrize(
    ("current", "target"),
    [
        (TripStatus.PLANNED, "loaded"),
        (TripStatus.PLANNED, "in_progress"),
        (TripStatus.PLANNED, "completed"),
        (TripStatus.PLANNED, "planned"),
        (TripStatus.AT_DEPOT, "planned"),
        (TripStatus.AT_DEPOT, "in_progress"),
        (TripStatus.LOADED, "at_depot"),
        (TripStatus.LOADED, "completed"),
        (TripStatus.IN_PROGRESS, "loaded"),
        (TripStatus.COMPLETED, "in_progress"),
        (TripStatus.COMPLETED, "completed"),
    ],
)
async def test_transition_interdite_409(client, db, auth_headers, products, current, target):
    scenario = await make_trip_scenario(db, products, trip_status=current)
    response = await client.put(
        f"/trips/{scenario.trip.id}/status", json={"status": target}, headers=await auth_headers("fleet")
    )
    assert response.status_code == 409
    body = response.json()
    assert body["code"] == "invalid_transition"
    assert body["details"][0]["from"] == current.value
    assert body["details"][0]["to"] == target


async def test_statut_inconnu_422(client, auth_headers, scenario):
    response = await client.put(
        f"/trips/{scenario.trip.id}/status", json={"status": "parti"}, headers=await auth_headers("fleet")
    )
    assert response.status_code == 422


async def test_loaded_exige_un_chargement_enregistre(client, db, auth_headers, products):
    scenario = await make_trip_scenario(db, products, trip_status=TripStatus.AT_DEPOT)
    order_ids = [o.id for o in scenario.orders]
    response = await client.put(
        f"/trips/{scenario.trip.id}/status", json={"status": "loaded"}, headers=await auth_headers("fleet")
    )
    assert response.status_code == 409
    assert response.json()["code"] == "loading_missing"
    assert order_ids  # les commandes ne sont pas touchées (transaction annulée)


async def test_commande_annulee_non_repassee_a_loaded(client, db, auth_headers, scenario):
    headers = await auth_headers("dispatcher")
    scenario.orders[2].status = OrderStatus.CANCELLED
    await db.flush()
    await client.post(f"/trips/{scenario.trip.id}/loading", json=scenario.loading_payload(), headers=headers)
    await _advance(client, headers, scenario.trip.id, "at_depot", "loaded")
    assert [o.status for o in scenario.orders] == [
        OrderStatus.LOADED,
        OrderStatus.LOADED,
        OrderStatus.CANCELLED,
    ]


async def test_completed_refuse_tant_qu_un_arret_est_en_attente(client, db, auth_headers, scenario):
    headers = await auth_headers("fleet")
    await _to_in_progress(client, headers, scenario)
    await client.put(f"/stops/{scenario.stops[0].id}/delivery", json=_deliver(scenario, 0), headers=headers)
    trip_id, pending_id = scenario.trip.id, scenario.stops[1].id
    await db.commit()

    response = await client.put(f"/trips/{trip_id}/status", json={"status": "completed"}, headers=headers)

    assert response.status_code == 409
    body = response.json()
    assert body["code"] == "stops_pending"
    assert body["details"] == [{"stop_id": str(pending_id), "seq": 2}]


async def test_completed_avec_arret_saute_et_heure_de_retour_par_defaut(client, auth_headers, scenario):
    headers = await auth_headers("fleet")
    await _to_in_progress(client, headers, scenario)
    await client.put(f"/stops/{scenario.stops[0].id}/delivery", json=_deliver(scenario, 0), headers=headers)
    await client.put(
        f"/stops/{scenario.stops[1].id}/delivery", json={"skip_reason": "Station fermée"}, headers=headers
    )

    body = (await _advance(client, headers, scenario.trip.id, "completed")).json()

    assert body["status"] == "completed"
    assert body["actual_return_at"] is not None  # heure courante à défaut de saisie
    assert body["actual_distance_m"] is None


async def test_retour_avant_depart_refuse(client, db, auth_headers, scenario):
    headers = await auth_headers("fleet")
    await client.post(f"/trips/{scenario.trip.id}/loading", json=scenario.loading_payload(), headers=headers)
    await _advance(client, headers, scenario.trip.id, "at_depot", "loaded")
    await _advance(client, headers, scenario.trip.id, "in_progress", actual_depart_at=iso(at(7, 25)))
    for index in (0, 1):
        await client.put(
            f"/stops/{scenario.stops[index].id}/delivery", json=_deliver(scenario, index), headers=headers
        )
    response = await client.put(
        f"/trips/{scenario.trip.id}/status",
        json={"status": "completed", "actual_return_at": iso(at(7, 0))},
        headers=headers,
    )
    assert response.status_code == 422
    assert response.json()["code"] == "invalid_times"


async def test_champs_reels_hors_de_leur_transition_refuses(client, auth_headers, scenario):
    response = await client.put(
        f"/trips/{scenario.trip.id}/status",
        json={"status": "at_depot", "actual_distance_m": 1000},
        headers=await auth_headers("fleet"),
    )
    assert response.status_code == 422


@pytest.mark.parametrize(
    ("role", "expected"),
    [("fleet", 200), ("dispatcher", 200), ("admin", 200), ("supply", 403), ("manager", 403)],
)
async def test_roles_sur_le_statut(client, auth_headers, scenario, role, expected):
    response = await client.put(
        f"/trips/{scenario.trip.id}/status", json={"status": "at_depot"}, headers=await auth_headers(role)
    )
    assert response.status_code == expected


async def test_statut_sur_plan_non_publie_409(client, db, auth_headers, products):
    draft = await make_trip_scenario(db, products, plan_status=PlanStatus.DRAFT)
    response = await client.put(
        f"/trips/{draft.trip.id}/status", json={"status": "at_depot"}, headers=await auth_headers("fleet")
    )
    assert response.status_code == 409
    assert response.json()["code"] == "plan_not_published"


# ── Livraisons ────────────────────────────────────────────────────────────────


async def test_arret_livre_volumes_et_commandes(client, db, auth_headers, scenario):
    headers = await auth_headers("dispatcher")
    await _to_in_progress(client, headers, scenario)
    stop = scenario.stops[0]
    payload = _deliver(scenario, 0)
    payload["deliveries"][0]["actual_l"] = 9950.5
    payload["deliveries"][1]["actual_l"] = 0  # rien livré sur cette commande

    response = await client.put(f"/stops/{stop.id}/delivery", json=payload, headers=headers)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "delivered"
    assert body["station_code"] == "ST-001"
    assert body["trip_status"] == "in_progress"
    assert body["actual_arrival_at"] == "2027-01-12T08:40:00Z"
    assert body["actual_departure_at"] == "2027-01-12T09:20:00Z"
    assert body["trip_all_stops_done"] is False
    by_order = {d["order_id"]: d for d in body["deliveries"]}
    assert by_order[str(scenario.orders[0].id)]["actual_l"] == 9950.5
    assert by_order[str(scenario.orders[0].id)]["order_status"] == "delivered"
    assert by_order[str(scenario.orders[0].id)]["product_code"] == "SUPER"
    # Volume livré nul : la commande repart à replanifier.
    assert by_order[str(scenario.orders[1].id)]["actual_l"] == 0
    assert by_order[str(scenario.orders[1].id)]["order_status"] == "confirmed"
    assert stop.status == StopStatus.DELIVERED
    assert scenario.orders[2].status == OrderStatus.LOADED  # arrêt 2 pas encore traité

    events = (
        (await db.execute(select(Event).where(Event.type == EventType.DELIVERY_RECORDED))).scalars().all()
    )
    assert len(events) == 1
    assert events[0].trip_id == scenario.trip.id
    assert events[0].payload["stop_id"] == str(stop.id)
    assert events[0].payload["status"] == "delivered"
    assert events[0].payload["station_code"] == "ST-001"


async def test_arret_saute_avec_motif(client, db, auth_headers, scenario):
    headers = await auth_headers("fleet")
    await _to_in_progress(client, headers, scenario)

    response = await client.put(
        f"/stops/{scenario.stops[1].id}/delivery", json={"skip_reason": "  Cuve pleine  "}, headers=headers
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "skipped"
    assert body["skip_reason"] == "Cuve pleine"
    assert body["deliveries"][0]["actual_l"] is None
    assert body["deliveries"][0]["order_status"] == "confirmed"  # à replanifier
    assert scenario.orders[2].status == OrderStatus.CONFIRMED
    event = (await db.execute(select(Event).where(Event.type == EventType.DELIVERY_RECORDED))).scalar_one()
    assert event.payload["skip_reason"] == "Cuve pleine"


async def test_correction_des_volumes_d_un_arret_livre(client, auth_headers, scenario):
    headers = await auth_headers("fleet")
    await _to_in_progress(client, headers, scenario)
    url = f"/stops/{scenario.stops[1].id}/delivery"
    await client.put(url, json=_deliver(scenario, 1), headers=headers)
    corrected = _deliver(scenario, 1)
    corrected["deliveries"][0]["actual_l"] = 9900

    response = await client.put(url, json=corrected, headers=headers)

    assert response.status_code == 200, response.text
    assert response.json()["deliveries"][0]["actual_l"] == 9900
    assert scenario.orders[2].status == OrderStatus.DELIVERED


async def test_arret_livre_ne_peut_plus_etre_saute(client, db, auth_headers, scenario):
    # Une commande `delivered` est définitive dans la machine à états des commandes (lot L4).
    headers = await auth_headers("fleet")
    await _to_in_progress(client, headers, scenario)
    url = f"/stops/{scenario.stops[1].id}/delivery"
    await client.put(url, json=_deliver(scenario, 1), headers=headers)

    response = await client.put(url, json={"skip_reason": "Erreur de saisie"}, headers=headers)

    assert response.status_code == 409
    assert response.json()["code"] == "invalid_order_transition"
    await db.refresh(scenario.stops[1])
    await db.refresh(scenario.orders[2])
    assert scenario.stops[1].status == StopStatus.DELIVERED  # rien n'a été modifié
    assert scenario.orders[2].status == OrderStatus.DELIVERED


async def test_arret_saute_ne_peut_plus_etre_livre(client, db, auth_headers, scenario):
    headers = await auth_headers("fleet")
    await _to_in_progress(client, headers, scenario)
    url = f"/stops/{scenario.stops[1].id}/delivery"
    await client.put(url, json={"skip_reason": "Station fermée"}, headers=headers)

    response = await client.put(url, json=_deliver(scenario, 1), headers=headers)

    assert response.status_code == 409
    assert response.json()["code"] == "invalid_order_transition"
    await db.refresh(scenario.stops[1])
    assert scenario.stops[1].status == StopStatus.SKIPPED  # rien n'a été modifié


@pytest.mark.parametrize(
    "payload",
    [
        {},  # ni volumes ni motif
        {"skip_reason": "   "},  # motif vide
        {"skip_reason": "Fermée", "deliveries": []},  # les deux
        {"deliveries": [{"order_id": "00000000-0000-0000-0000-000000000000", "actual_l": -1}]},
        {
            "actual_arrival_at": "2027-01-12T09:00:00Z",
            "actual_departure_at": "2027-01-12T08:00:00Z",
            "skip_reason": "Fermée",
        },
    ],
)
async def test_saisie_de_livraison_invalide_422(client, auth_headers, scenario, payload):
    response = await client.put(
        f"/stops/{scenario.stops[0].id}/delivery", json=payload, headers=await auth_headers("fleet")
    )
    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


async def test_volumes_livres_doivent_couvrir_les_commandes_de_l_arret(client, db, auth_headers, scenario):
    headers = await auth_headers("fleet")
    await _to_in_progress(client, headers, scenario)
    url = f"/stops/{scenario.stops[0].id}/delivery"
    missing = _deliver(scenario, 0)
    missing["deliveries"].pop()
    foreign = _deliver(scenario, 0)
    foreign["deliveries"].append({"order_id": str(scenario.orders[2].id), "actual_l": 100})
    duplicate = _deliver(scenario, 0)
    duplicate["deliveries"].append(duplicate["deliveries"][0])
    no_arrival = _deliver(scenario, 0, actual_arrival_at=None)
    await db.commit()

    response = await client.put(url, json=missing, headers=headers)
    assert response.status_code == 422
    assert response.json()["code"] == "invalid_deliveries"
    assert "manquant" in response.json()["details"][0]["message"]

    response = await client.put(url, json=foreign, headers=headers)
    assert response.status_code == 422
    assert "pas prévue à cet arrêt" in response.json()["details"][0]["message"]

    assert (await client.put(url, json=duplicate, headers=headers)).status_code == 422
    assert (await client.put(url, json=no_arrival, headers=headers)).status_code == 422


@pytest.mark.parametrize(
    "trip_status", [TripStatus.PLANNED, TripStatus.AT_DEPOT, TripStatus.LOADED, TripStatus.COMPLETED]
)
async def test_livraison_refusee_hors_tournee_en_cours(client, db, auth_headers, products, trip_status):
    scenario = await make_trip_scenario(db, products, trip_status=trip_status)
    response = await client.put(
        f"/stops/{scenario.stops[0].id}/delivery",
        json=_deliver(scenario, 0),
        headers=await auth_headers("fleet"),
    )
    assert response.status_code == 409
    assert response.json()["code"] == "trip_not_in_progress"


async def test_livraison_sur_plan_non_publie_409(client, db, auth_headers, products):
    draft = await make_trip_scenario(
        db, products, plan_status=PlanStatus.ARCHIVED, trip_status=TripStatus.IN_PROGRESS
    )
    response = await client.put(
        f"/stops/{draft.stops[0].id}/delivery", json=_deliver(draft, 0), headers=await auth_headers("fleet")
    )
    assert response.status_code == 409
    assert response.json()["code"] == "plan_not_published"


async def test_arret_inconnu_404(client, auth_headers):
    response = await client.put(
        "/stops/00000000-0000-0000-0000-000000000001/delivery",
        json={"skip_reason": "Fermée"},
        headers=await auth_headers("fleet"),
    )
    assert response.status_code == 404


@pytest.mark.parametrize(
    ("role", "expected"),
    [("fleet", 200), ("dispatcher", 200), ("admin", 200), ("supply", 403), ("manager", 403)],
)
async def test_roles_sur_la_livraison(client, db, auth_headers, products, role, expected):
    scenario = await make_trip_scenario(db, products, trip_status=TripStatus.IN_PROGRESS)
    response = await client.put(
        f"/stops/{scenario.stops[0].id}/delivery",
        json=_deliver(scenario, 0),
        headers=await auth_headers(role),
    )
    assert response.status_code == expected
