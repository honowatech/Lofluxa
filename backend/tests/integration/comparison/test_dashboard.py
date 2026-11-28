"""F8.6 — tableau de bord du jour : avancement, retards estimés, alertes actives."""

from app.core.enums import EventType, PlanKind, PlanStatus, Severity, StopStatus, TripStatus
from app.events.models import Event

from . import factory
from .factory import DAY, OTHER_DAY, at


async def test_tableau_de_bord_du_jour(client, db, world, auth_headers):
    o1 = await factory.make_order(db, world, "ST-DLA-001", "SUPER", 12000)
    o2 = await factory.make_order(db, world, "ST-DLA-002", "GASOIL", 15000)
    o3 = await factory.make_order(db, world, "ST-DLA-003", "SUPER", 10000)
    o4 = await factory.make_order(db, world, "ST-DLA-004", "PETROLE", 5000)
    trips = [
        {  # en cours, 30 min de retard au premier arrêt
            "truck": "LT-123-AA",
            "driver": "Jean Mbarga",
            "status": TripStatus.IN_PROGRESS,
            "depart": "08:15",
            "return": "12:00",
            "actual_depart": "08:35",
            "stops": [
                {
                    "station": "ST-DLA-001",
                    "arrival": "09:00",
                    "actual_arrival": "09:30",
                    "status": StopStatus.DELIVERED,
                    "deliveries": [(o1, 12000, 11800)],
                },
                {"station": "ST-DLA-003", "arrival": "10:30", "deliveries": [(o3, 10000, None)]},
            ],
        },
        {  # pas encore partie
            "truck": "LT-456-BB",
            "driver": "Paul Etoa",
            "depart": "08:15",
            "return": "11:00",
            "stops": [{"station": "ST-DLA-002", "arrival": "09:10", "deliveries": [(o2, 15000, None)]}],
        },
        {  # terminée en avance, un arrêt sauté
            "truck": "LT-456-BB",
            "driver": "Paul Etoa",
            "status": TripStatus.COMPLETED,
            "depart": "13:00",
            "return": "15:00",
            "actual_depart": "13:00",
            "actual_return": "14:50",
            "stops": [
                {
                    "station": "ST-DLA-004",
                    "arrival": "14:00",
                    "actual_arrival": "13:55",
                    "status": StopStatus.DELIVERED,
                    "deliveries": [(o4, 5000, 5000)],
                },
                {"station": "ST-DLA-002", "arrival": "14:30", "status": StopStatus.SKIPPED},
            ],
        },
    ]
    plan = await factory.make_plan(
        db,
        world,
        trips,
        status=PlanStatus.PUBLISHED,
        version=2,
        violations=[
            ("RM-08", Severity.WARNING, "Stock non renseigné pour SUPER.", None),
            ("RM-11", Severity.BLOCKING, "Durée de service dépassée.", 1),
        ],
    )
    # Ignorés : brouillon du même jour, version publiée antérieure de la même lignée, plan qui n'est
    # pas un plan calculé, plan publié d'un autre jour.
    await factory.make_plan(db, world, [{"truck": "LT-123-AA", "stops": [{"station": "ST-DLA-001"}]}])
    await factory.make_plan(db, world, [], status=PlanStatus.PUBLISHED, version=1, root_plan_id=plan.id)
    reference = await factory.make_plan(
        db, world, [{"truck": "LT-123-AA", "stops": [{"station": "ST-DLA-001"}]}], kind=PlanKind.REPLAY
    )
    reference.status = PlanStatus.PUBLISHED  # un plan non calculé n'est jamais suivi par le terrain
    await factory.make_plan(db, world, [], status=PlanStatus.PUBLISHED, day=OTHER_DAY, version=5)
    trip1 = plan.trips[0]
    db.add_all(
        [
            Event(
                day=DAY,
                plan_id=plan.id,
                type=EventType.PRODUCT_SHORTAGE,
                payload={"depot_code": "SCDP-DLA", "product_code": "SUPER", "new_available_l": 8000},
                occurred_at=at("09:40"),
            ),
            Event(
                day=DAY,
                plan_id=plan.id,
                trip_id=trip1.id,
                type=EventType.TRUCK_BREAKDOWN,
                occurred_at=at("10:05"),
            ),
            Event(day=DAY, plan_id=plan.id, type=EventType.PUBLISH, occurred_at=at("07:00")),
            Event(day=OTHER_DAY, type=EventType.PRODUCT_SHORTAGE, occurred_at=at("09:00", OTHER_DAY)),
        ]
    )
    await db.commit()

    response = await client.get(
        "/dashboard", params={"day": "2027-01-12"}, headers=await auth_headers("manager")
    )
    assert response.status_code == 200, response.text
    body = response.json()

    assert body["day"] == "2027-01-12"
    assert body["plan"]["id"] == str(plan.id) and body["plan"]["version"] == 2
    assert [p["id"] for p in body["plans"]] == [str(plan.id)] and body["plans"][0] == body["plan"]
    assert (body["plan"]["trips_total"], body["plan"]["stops_delivered"], body["plan"]["alerts_total"]) == (
        3,
        2,
        2,
    )
    assert body["pending_draft"] is None and body["pending_drafts"] == []
    assert body["summary"] == {
        "plans_total": 1,
        "volume_skipped_l": 0.0,
        "volume_replanned_l": 0.0,
        "trips_total": 3,
        "trips_by_status": {"planned": 1, "at_depot": 0, "loaded": 0, "in_progress": 1, "completed": 1},
        "stops_total": 5,
        "stops_delivered": 2,
        "stops_skipped": 1,
        "stops_pending": 2,
        "volume_planned_l": 42000.0,
        "volume_delivered_l": 16800.0,
        "trips_late": 1,
        "max_delay_s": 1800,
        "alerts_blocking": 1,
        "alerts_total": 4,
    }

    first, second, third = body["trips"]
    assert {(t["plan_id"], t["plan_version"], t["plan_label"]) for t in body["trips"]} == {
        (str(plan.id), 2, "Plan calculé v2")
    }
    assert (first["truck_plate"], first["driver_name"], first["depot_code"]) == (
        "LT-123-AA",
        "Jean Mbarga",
        "SCDP-DLA",
    )
    assert (first["status"], first["stops_total"], first["stops_delivered"], first["stops_pending"]) == (
        "in_progress", 2, 1, 1,
    )  # fmt: skip
    assert first["delay_s"] == 1800  # arrivée réelle 09:30 contre 09:00 prévue
    assert first["next_station_code"] == "ST-DLA-003"
    assert first["next_planned_arrival_at"] == "2027-01-12T09:30:00Z"
    assert first["next_estimated_arrival_at"] == "2027-01-12T10:00:00Z"  # prévu + retard constaté
    assert (first["volume_planned_l"], first["volume_delivered_l"]) == (22000.0, 11800.0)
    assert second["status"] == "planned" and second["delay_s"] is None
    assert second["next_estimated_arrival_at"] == second["next_planned_arrival_at"] == "2027-01-12T08:10:00Z"
    assert third["status"] == "completed" and third["delay_s"] == -600  # retour 14:50 contre 15:00
    assert (third["stops_skipped"], third["stops_pending"], third["next_station_code"]) == (1, 0, None)

    (delay,) = body["delays"]
    assert (delay["trip_seq"], delay["stop_seq"], delay["station_code"], delay["delay_s"]) == (
        1,
        1,
        "ST-DLA-001",
        1800,
    )
    assert (delay["planned_at"], delay["actual_at"]) == ("2027-01-12T08:00:00Z", "2027-01-12T08:30:00Z")

    alerts = [(a["source"], a["severity"], a["code"], a["trip_seq"]) for a in body["alerts"]]
    assert alerts == [
        ("violation", "blocking", "RM-11", 1),
        ("violation", "warning", "RM-08", None),
        ("event", "warning", "truck_breakdown", None),
        ("event", "warning", "product_shortage", None),
    ]
    breakdown, shortage = body["alerts"][2:]
    assert breakdown["trip_id"] == str(trip1.id) and breakdown["message"] == "Panne de camion"
    assert breakdown["occurred_at"] == "2027-01-12T09:05:00Z"
    assert shortage["payload"]["new_available_l"] == 8000 and shortage["event_type"] == "product_shortage"


async def test_tableau_de_bord_sans_plan_publie(client, db, world, auth_headers):
    await factory.make_plan(db, world, [{"truck": "LT-123-AA", "stops": [{"station": "ST-DLA-001"}]}])
    db.add(Event(day=DAY, type=EventType.DRIVER_UNAVAILABLE, occurred_at=at("06:30")))
    await db.commit()

    response = await client.get(
        "/dashboard", params={"day": "2027-01-12"}, headers=await auth_headers("supply")
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["plan"] is None and body["trips"] == [] and body["delays"] == []
    assert body["summary"]["trips_total"] == 0 and body["summary"]["alerts_total"] == 1
    assert [a["code"] for a in body["alerts"]] == ["driver_unavailable"]

    assert (await client.get("/dashboard", params={"day": "2027-01-12"})).status_code == 401
    assert (await client.get("/dashboard", headers=await auth_headers("supply"))).status_code == 422


async def test_penurie_resolue_plus_en_alerte_et_resume_de_l_evenement_affiche(
    client, db, world, auth_headers
):
    """Une pénurie résolue ou sans impact n'est plus une alerte active ; le résumé rédigé par le
    module des événements remplace le libellé générique."""
    summary = "Gasoil au dépôt SCDP-DLA : 8 000 L disponibles, 2 tournées impactées."
    db.add_all(
        [
            Event(
                day=DAY,
                type=EventType.PRODUCT_SHORTAGE,
                occurred_at=at("06:10"),
                payload={"status": "resolved", "summary": "Pénurie réglée."},
            ),
            Event(
                day=DAY,
                type=EventType.PRODUCT_SHORTAGE,
                occurred_at=at("06:20"),
                payload={"status": "no_impact", "summary": "Aucune tournée impactée."},
            ),
            Event(
                day=DAY,
                type=EventType.PRODUCT_SHORTAGE,
                occurred_at=at("06:30"),
                payload={"status": "open", "summary": summary},
            ),
        ]
    )
    await db.commit()

    response = await client.get(
        "/dashboard", params={"day": "2027-01-12"}, headers=await auth_headers("fleet")
    )
    assert response.status_code == 200, response.text
    alerts = response.json()["alerts"]
    assert [(a["code"], a["message"]) for a in alerts] == [("product_shortage", summary)]


async def test_deux_plans_publies_le_meme_jour_sont_agreges(client, db, world, auth_headers):
    """Plan du matin dont un arrêt est sauté, puis second plan publié qui reprend la commande sautée :
    le tableau de bord suit les deux et ne compte pas deux fois le volume replanifié (L7-17)."""
    o1 = await factory.make_order(db, world, "ST-DLA-001", "SUPER", 12000)
    o2 = await factory.make_order(db, world, "ST-DLA-002", "GASOIL", 6000)
    o3 = await factory.make_order(db, world, "ST-DLA-003", "SUPER", 10000)
    done = {"status": StopStatus.DELIVERED}
    morning = await factory.make_plan(
        db,
        world,
        [
            {
                "truck": "LT-123-AA",
                "driver": "Jean Mbarga",
                "status": TripStatus.COMPLETED,
                "depart": "08:15",
                "return": "12:00",
                "stops": [
                    {"station": "ST-DLA-001", "arrival": "09:00", "deliveries": [(o1, 12000, 12000)], **done},
                    {
                        "station": "ST-DLA-002",
                        "arrival": "10:00",
                        "status": StopStatus.SKIPPED,
                        "deliveries": [(o2, 6000, None)],
                    },
                    {
                        "station": "ST-DLA-003",
                        "arrival": "11:00",
                        "actual_arrival": "11:20",
                        "deliveries": [(o3, 10000, 10000)],
                        **done,
                    },
                ],
            }
        ],
        status=PlanStatus.PUBLISHED,
        version=3,
        label="Plan du matin",
        violations=[("RM-08", Severity.WARNING, "Stock non renseigné pour SUPER.", None)],
    )
    second = await factory.make_plan(
        db,
        world,
        [
            {
                "truck": "LT-456-BB",
                "driver": "Paul Etoa",
                "status": TripStatus.COMPLETED,
                "depart": "13:00",
                "return": "15:00",
                "stops": [
                    {
                        "station": "ST-DLA-002",
                        "arrival": "14:00",
                        "actual_arrival": "14:05",
                        "deliveries": [(o2, 6000, 6000)],
                        **done,
                    }
                ],
            }
        ],
        status=PlanStatus.PUBLISHED,
        violations=[("RM-11", Severity.BLOCKING, "Durée de service dépassée.", 1)],
    )
    # Brouillon en préparation dans la lignée du second plan.
    draft = await factory.make_plan(db, world, [], version=2, root_plan_id=second.id)
    await db.commit()

    response = await client.get(
        "/dashboard", params={"day": "2027-01-12"}, headers=await auth_headers("fleet")
    )
    assert response.status_code == 200, response.text
    body = response.json()

    assert [(p["id"], p["version"], p["title"]) for p in body["plans"]] == [
        (str(morning.id), 3, "Plan du matin"),
        (str(second.id), 1, "Plan calculé v1"),
    ]
    assert body["plan"] == body["plans"][0]  # le plan principal reste le premier créé
    per_plan = [
        (
            p["trips_total"],
            p["stops_delivered"],
            p["stops_skipped"],
            p["volume_planned_l"],
            p["volume_delivered_l"],
        )
        for p in body["plans"]
    ]
    assert per_plan == [(1, 2, 1, 28000.0, 22000.0), (1, 1, 0, 6000.0, 6000.0)]
    assert [(p["alerts_blocking"], p["alerts_total"]) for p in body["plans"]] == [(0, 1), (1, 1)]

    # Tout le volume demandé (28 000 L) est livré : l'arrêt sauté repris par le second plan n'est
    # compté qu'une fois dans le prévu.
    summary = body["summary"]
    assert (summary["plans_total"], summary["trips_total"], summary["stops_total"]) == (2, 2, 4)
    assert (summary["stops_delivered"], summary["stops_skipped"], summary["stops_pending"]) == (3, 1, 0)
    assert (summary["volume_planned_l"], summary["volume_delivered_l"]) == (28000.0, 28000.0)
    assert (summary["volume_skipped_l"], summary["volume_replanned_l"]) == (0.0, 6000.0)
    assert summary["trips_by_status"]["completed"] == 2
    assert (summary["trips_late"], summary["max_delay_s"]) == (2, 1200)

    assert [
        (t["plan_id"], t["plan_version"], t["plan_label"], t["seq"], t["truck_plate"]) for t in body["trips"]
    ] == [
        (str(morning.id), 3, "Plan du matin", 1, "LT-123-AA"),
        (str(second.id), 1, "Plan calculé v1", 1, "LT-456-BB"),
    ]
    assert (body["trips"][0]["volume_planned_l"], body["trips"][0]["volume_skipped_l"]) == (28000.0, 6000.0)
    assert [(d["plan_id"], d["plan_label"], d["station_code"], d["delay_s"]) for d in body["delays"]] == [
        (str(morning.id), "Plan du matin", "ST-DLA-003", 1200),
        (str(second.id), "Plan calculé v1", "ST-DLA-002", 300),
    ]

    # Alertes : version en attente en tête, puis violations de chaque plan suivi.
    assert [(a["source"], a["code"], a["plan_id"]) for a in body["alerts"]] == [
        ("plan", "pending_draft", str(draft.id)),
        ("violation", "RM-08", str(morning.id)),
        ("violation", "RM-11", str(second.id)),
    ]
    (pending,) = body["pending_drafts"]
    assert body["pending_draft"] == pending
    assert (pending["plan_id"], pending["version"]) == (str(draft.id), 2)
    assert (pending["published_plan_id"], pending["published_version"]) == (str(second.id), 1)
    assert (summary["alerts_blocking"], summary["alerts_total"]) == (1, 3)


async def test_arret_saute_non_repris_reste_dans_le_prevu(client, db, world, auth_headers):
    """Sans second plan, l'arrêt sauté reste dû : « 12 000 L livrés sur 18 000 L »."""
    o1 = await factory.make_order(db, world, "ST-DLA-001", "SUPER", 12000)
    o2 = await factory.make_order(db, world, "ST-DLA-002", "GASOIL", 6000)
    await factory.make_plan(
        db,
        world,
        [
            {
                "truck": "LT-123-AA",
                "driver": "Jean Mbarga",
                "status": TripStatus.COMPLETED,
                "stops": [
                    {
                        "station": "ST-DLA-001",
                        "status": StopStatus.DELIVERED,
                        "deliveries": [(o1, 12000, 12000)],
                    },
                    {"station": "ST-DLA-002", "status": StopStatus.SKIPPED, "deliveries": [(o2, 6000, None)]},
                ],
            }
        ],
        status=PlanStatus.PUBLISHED,
    )
    await db.commit()
    response = await client.get(
        "/dashboard", params={"day": "2027-01-12"}, headers=await auth_headers("manager")
    )
    summary = response.json()["summary"]
    assert (summary["volume_planned_l"], summary["volume_delivered_l"]) == (18000.0, 12000.0)
    assert (summary["volume_skipped_l"], summary["volume_replanned_l"]) == (6000.0, 0.0)
