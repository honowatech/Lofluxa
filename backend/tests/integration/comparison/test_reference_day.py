"""F8.1 — import d'une journée de référence, F8.2 — rejeu."""

from pathlib import Path

from sqlalchemy import select

from app.core.enums import (
    ImportKind,
    ImportStatus,
    OrderSource,
    OrderStatus,
    PlanKind,
    PlanStatus,
    Severity,
    StopStatus,
    TripStatus,
)
from app.imports.models import ImportBatch
from app.imports.reference_day import TEMPLATE_ORDERS, TEMPLATE_TRIPS, build_workbook
from app.orders.models import Order
from app.planning.models import Plan, TripCompartmentLoad

from . import factory
from .factory import DAY, DEPOT, STATIONS, at, leg_m

TEMPLATE = Path(__file__).resolve().parents[4] / "data" / "templates" / "reference_day.xlsx"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _files(content: bytes, name: str = "journee_A.xlsx") -> dict:
    return {"file": (name, content, XLSX)}


async def _import(client, headers, content: bytes | None = None, **form):
    return await client.post(
        "/reference-days/import",
        files=_files(content if content is not None else TEMPLATE.read_bytes()),
        data={k: str(v) for k, v in form.items()},
        headers=headers,
    )


async def _plans(db) -> list[Plan]:
    return list((await db.execute(select(Plan).order_by(Plan.created_at, Plan.id))).scalars().all())


async def test_import_du_fichier_modele_cree_le_plan_de_reference(client, db, world, auth_headers):
    response = await _import(client, await auth_headers("dispatcher"))
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["status"] == "applied"
    assert body["day"] == "2027-01-12"
    assert body["error_count"] == 0 and body["errors"] == []
    assert body["row_count"] == 9  # 5 commandes + 4 livraisons
    assert body["summary"] == {
        "orders": 5,
        "trips": 2,
        "stops": 3,
        "volume_delivered_l": 45000.0,
        "trips_with_actual_km": 2,
        "orders_unserved": 1,
    }

    from app.comparison.service import load_bundle

    bundle = await load_bundle(db, body["plan_id"])
    plan = bundle.plan
    assert plan.kind == PlanKind.MANUAL_REFERENCE
    assert plan.status == PlanStatus.DRAFT
    assert plan.day == DAY
    assert plan.label == "Journée A — exemple"
    assert plan.prep_time_s == 120 * 60
    assert plan.approximate is True  # doublure haversine
    assert plan.params_snapshot["max_service_hours"] == 11.0

    trip1, trip2 = bundle.trips
    assert trip1.truck_id == world.trucks["LT-123-AA"].id
    assert trip1.driver_id == world.drivers["Jean Mbarga"].id
    assert trip2.driver_id == world.drivers["Paul Etoa"].id
    assert trip1.depot_id == world.depot.id
    assert trip1.status == TripStatus.COMPLETED
    # Réel : km et heures du fichier, heure locale Africa/Douala → UTC (RM-20).
    assert trip1.actual_distance_m == 86_000 and trip2.actual_distance_m == 54_000
    assert trip1.actual_depart_at == at("07:30") and trip1.actual_return_at == at("13:10")
    assert trip1.actual_depart_at.utcoffset().total_seconds() == 0 or trip1.actual_depart_at == at("07:30")

    # Estimé : même matrice que le moteur (ici la doublure haversine × 1,3), horaires par schedule_trip.
    depot = DEPOT[1:]
    s1, s2, s3 = STATIONS["ST-DLA-001"], STATIONS["ST-DLA-002"], STATIONS["ST-DLA-003"]
    assert trip1.distance_m == leg_m(depot, s1) + leg_m(s1, s3) + leg_m(s3, depot)
    assert trip2.distance_m == 2 * leg_m(depot, s2)
    stop1, stop2 = trip1.stops
    assert stop1.distance_from_prev_m == leg_m(depot, s1)
    assert stop2.distance_from_prev_m == leg_m(s1, s3)
    # Départ réel 07:30 − attente 90 min − chargement 45 min = 05:15, borné par le début de journée 06:00.
    assert trip1.planned_start_at == at("06:00")
    assert trip1.planned_depart_at == at("08:15")
    assert trip1.duration_s == int((trip1.planned_return_at - trip1.planned_depart_at).total_seconds())
    assert stop1.planned_arrival_at > trip1.planned_depart_at
    assert stop2.planned_arrival_at > stop1.planned_departure_at

    # Arrêts et livraisons : la journée a eu lieu, volume réel = volume du fichier.
    assert [s.status for s in trip1.stops] == [StopStatus.DELIVERED, StopStatus.DELIVERED]
    assert stop1.station_id == world.stations["ST-DLA-001"].id
    assert stop1.actual_arrival_at == at("08:15") and stop1.actual_departure_at == at("09:00")
    volumes = sorted(
        (bundle.products[d.product_id].code, float(d.planned_l), float(d.actual_l)) for d in stop1.deliveries
    )
    assert volumes == [("GASOIL", 8000.0, 8000.0), ("SUPER", 12000.0, 12000.0)]

    # Commandes : créées par l'import, livrées ou reportées ; la non livrée est listée dans unserved.
    orders = (await db.execute(select(Order).where(Order.day == DAY))).scalars().all()
    assert len(orders) == 5
    assert {o.source for o in orders} == {OrderSource.IMPORT}
    assert {str(o.import_batch_id) for o in orders} == {body["batch_id"]}
    by_status = sorted(o.status.value for o in orders)
    assert by_status == ["delivered"] * 4 + ["postponed"]
    urgent = next(o for o in orders if o.station_id == world.stations["ST-DLA-002"].id)
    assert urgent.priority == "urgent" and urgent.window_start.strftime("%H:%M") == "08:00"
    (unserved,) = plan.unserved
    assert bundle.orders[unserved.order_id].station_id == world.stations["ST-DLA-004"].id

    # Plan de chargement réparti comme pour un plan calculé (le fichier ne donne pas les compartiments).
    loads = (
        await db.execute(select(TripCompartmentLoad).where(TripCompartmentLoad.trip_id == trip1.id))
    ).scalars()
    by_product: dict[str, float] = {}
    for load in loads:
        code = bundle.products[load.product_id].code
        by_product[code] = by_product.get(code, 0.0) + float(load.planned_l)
    assert by_product == {"SUPER": 22000.0, "GASOIL": 8000.0}

    # Violations : les vraies règles (lot L1). Aucune bloquante ; le stock du dépôt n'est pas saisi (RM-08).
    assert sorted((v.rule_code, v.severity) for v in plan.violations) == [("RM-08", Severity.WARNING)] * 2
    assert plan.metrics["violations_blocking"] == 0 and plan.metrics["violations_warning"] == 2

    # Métriques enregistrées sur le plan.
    assert plan.metrics["distance_actual_m"] == 140_000
    assert plan.metrics["distance_estimated_m"] == trip1.distance_m + trip2.distance_m
    assert plan.metrics["orders_requested"] == 5 and plan.metrics["orders_served"] == 4
    assert plan.metrics["prep_time_s"] == 7200

    batch = await db.get(ImportBatch, plan.metrics and body["batch_id"])
    assert batch.kind == ImportKind.REFERENCE_DAY
    assert batch.status == ImportStatus.APPLIED
    assert batch.filename == "journee_A.xlsx"
    assert batch.report["plan_id"] == body["plan_id"]


async def test_import_rapport_d_erreurs_ligne_par_ligne(client, db, world, auth_headers):
    trips = [list(row) for row in TEMPLATE_TRIPS]
    trips[0][1] = "LT-999-ZZ"  # camion inconnu
    trips[0][2] = "Inconnu Total"  # chauffeur inconnu
    trips[2][5] = "ST-XXX-404"  # station inconnue
    trips[3][3] = "DEPOT-??"  # dépôt inconnu
    trips[3][6] = "KEROZEN"  # produit inconnu
    orders = [list(row) for row in TEMPLATE_ORDERS]
    orders[4][0] = "ST-ZZZ-000"
    content = build_workbook(day="2027-01-12", orders=orders, trips=trips)

    response = await _import(client, await auth_headers("dispatcher"), content)
    assert response.status_code == 422, response.text
    body = response.json()
    assert body["code"] == "import_rejected"
    assert body["status"] == "rejected" and body["plan_id"] is None
    assert body["error_count"] == 6
    assert body["details"] == body["errors"]
    found = {(e["sheet"], e["row"], e["column"]): e["message"] for e in body["errors"]}
    assert found == {
        ("Commandes", 6, "Code station"): "Station inconnue : ST-ZZZ-000.",
        ("Tournées", 2, "Camion"): "Camion inconnu : LT-999-ZZ.",
        ("Tournées", 2, "Chauffeur"): "Chauffeur inconnu : Inconnu Total.",
        ("Tournées", 4, "Code station"): "Station inconnue : ST-XXX-404.",
        ("Tournées", 5, "Dépôt"): "Dépôt inconnu : DEPOT-??.",
        ("Tournées", 5, "Produit"): "Produit inconnu : KEROZEN.",
    }
    # Rien n'est créé, mais le lot rejeté et son rapport sont conservés.
    assert await _plans(db) == []
    assert (await db.execute(select(Order))).first() is None
    batch = await db.get(ImportBatch, body["batch_id"])
    assert batch.status == ImportStatus.REJECTED and batch.error_count == 6
    assert len(batch.report["errors"]) == 6


async def test_import_violations_du_plan_manuel_rattachees_a_la_tournee(client, db, world, auth_headers):
    """Chargement impossible (3 produits pour 2 compartiments) et station fermée : les règles le disent."""
    world.stations["ST-DLA-002"].opening_hours = {"tue": [["06:00", "07:00"]]}
    trips = [
        (
            1,
            "LT-456-BB",
            "Paul Etoa",
            "SCDP-DLA",
            1,
            "ST-DLA-001",
            "SUPER",
            5000,
            None,
            None,
            None,
            None,
            None,
        ),
        (1, None, None, None, 1, "ST-DLA-001", "GASOIL", 5000, None, None, None, None, None),
        (1, None, None, None, 2, "ST-DLA-002", "PETROLE", 5000, None, None, None, None, None),
    ]
    content = build_workbook(day="2027-01-12", trips=trips)
    response = await _import(client, await auth_headers("dispatcher"), content)
    assert response.status_code == 201, response.text

    from app.comparison.service import load_bundle, plan_metrics

    bundle = await load_bundle(db, response.json()["plan_id"])
    (trip,) = bundle.trips
    stop2 = trip.stops[1]
    found = {(v.rule_code, v.severity.value, v.trip_id, v.stop_id) for v in bundle.plan.violations}
    assert ("RM-05", "blocking", trip.id, None) in found  # aucun plan de chargement possible
    assert ("RM-10", "blocking", trip.id, stop2.id) in found  # arrivée après la fermeture de la station
    blocking = sum(1 for v in bundle.plan.violations if v.severity == Severity.BLOCKING)
    assert plan_metrics(bundle).violations_blocking == blocking >= 4
    assert (await db.execute(select(TripCompartmentLoad))).first() is None


async def test_import_fichier_illisible(client, db, world, auth_headers):
    response = await _import(client, await auth_headers("dispatcher"), b"ceci n'est pas un classeur")
    assert response.status_code == 422
    assert response.json()["errors"][0]["message"].startswith("Fichier illisible")


async def test_import_controle_seul_ne_cree_rien(client, db, world, auth_headers):
    response = await _import(client, await auth_headers("dispatcher"), dry_run="true")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "previewed" and body["plan_id"] is None and body["error_count"] == 0
    assert body["summary"]["trips"] == 2
    assert await _plans(db) == []
    assert (await db.get(ImportBatch, body["batch_id"])).status == ImportStatus.PREVIEWED


async def test_import_champs_du_formulaire_priment_sur_le_fichier(client, db, world, auth_headers):
    response = await _import(
        client, await auth_headers("dispatcher"), day="2027-01-19", prep_time_min=95, label="Mardi type"
    )
    assert response.status_code == 201, response.text
    (plan,) = await _plans(db)
    assert plan.day.isoformat() == "2027-01-19"
    assert plan.prep_time_s == 95 * 60
    assert plan.label == "Mardi type"


async def test_import_commandes_deduites_et_chauffeur_par_numero_de_permis(client, db, world, auth_headers):
    trips = [
        (
            1,
            "lt-123-aa",
            "P-002",
            "scdp-dla",
            1,
            "ST-DLA-001",
            "Gasoil",
            "9 000",
            None,
            None,
            None,
            None,
            None,
        ),
        (1, None, None, None, 2, "ST-DLA-004", "Pétrole lampant", 4000, None, None, None, None, None),
    ]
    response = await _import(
        client, await auth_headers("dispatcher"), build_workbook(day="12/01/2027", trips=trips)
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert [w["message"] for w in body["warnings"]] == [
        "Aucune commande saisie : les commandes sont déduites des tournées (demandé = livré)."
    ]
    (plan,) = await _plans(db)
    assert plan.prep_time_s is None  # réel facultatif (Q6)
    assert plan.label == "Journée de référence du 12/01/2027"
    from app.comparison.service import load_bundle, plan_metrics

    bundle = await load_bundle(db, plan.id)
    (trip,) = bundle.trips
    assert trip.driver_id == world.drivers["Paul Etoa"].id
    assert trip.actual_distance_m is None and trip.actual_depart_at is None
    assert trip.planned_start_at == at("06:00")
    metrics = plan_metrics(bundle)
    assert (metrics.orders_requested, metrics.orders_served) == (2, 2)
    assert (metrics.volume_requested_l, metrics.volume_planned_l) == (13000.0, 13000.0)
    assert metrics.distance_actual_m is None and metrics.service_duration_actual_s is None


async def test_import_existant_409_puis_remplacement(client, db, world, auth_headers):
    headers = await auth_headers("dispatcher")
    first = (await _import(client, headers)).json()

    again = await _import(client, headers)
    assert again.status_code == 409
    assert again.json()["code"] == "reference_day_exists"
    assert again.json()["details"] == [{"plan_id": first["plan_id"]}]

    preview = await _import(client, headers, dry_run="true")
    assert preview.status_code == 200
    assert "existe déjà" in preview.json()["warnings"][-1]["message"]

    replaced = await _import(client, headers, replace="true")
    assert replaced.status_code == 201, replaced.text
    old, new = await _plans(db)
    assert str(old.id) == first["plan_id"] and old.status == PlanStatus.ARCHIVED
    assert str(new.id) == replaced.json()["plan_id"] and new.status == PlanStatus.DRAFT
    orders = (await db.execute(select(Order))).scalars().all()
    old_orders = [o for o in orders if str(o.import_batch_id) == first["batch_id"]]
    assert len(orders) == 10 and len(old_orders) == 5
    assert {o.status for o in old_orders} == {OrderStatus.CANCELLED}


async def test_import_et_rejeu_reserves_au_dispatcher(client, db, world, auth_headers):
    headers = {role: await auth_headers(role) for role in ("manager", "fleet", "supply", "admin")}
    plan = await factory.make_plan(db, world, [], kind=PlanKind.MANUAL_REFERENCE, day=factory.OTHER_DAY)
    plan_id = plan.id
    await db.commit()
    for role in ("manager", "fleet", "supply"):
        response = await _import(client, headers[role])
        assert response.status_code == 403, role
    assert (await client.post("/reference-days/import", files=_files(b""))).status_code == 401
    response = await client.post(f"/plans/{plan_id}/replay", headers=headers["manager"])
    assert response.status_code == 403
    assert (await client.post(f"/plans/{plan_id}/replay")).status_code == 401
    # `admin` passe partout.
    assert (await _import(client, headers["admin"])).status_code == 201


async def test_rejeu_relance_le_moteur_sur_les_memes_commandes(
    client, db, world, auth_headers, engine_doubles, make_user
):
    headers = await auth_headers("dispatcher")
    imported = (await _import(client, headers)).json()

    response = await client.post(f"/plans/{imported['plan_id']}/replay", headers=headers)
    assert response.status_code == 202, response.text
    assert response.json() == {"task_id": "task-rejeu-1"}

    (call,) = engine_doubles
    orders = (await db.execute(select(Order))).scalars().all()
    assert call["day"] == DAY
    assert call["kind"] == PlanKind.REPLAY
    assert str(call["parent_plan_id"]) == imported["plan_id"]
    assert sorted(call["order_ids"]) == sorted(o.id for o in orders)  # livrées ET non livrées
    assert len(call["order_ids"]) == 5
    assert call["user_id"] is not None
    assert call["label"] == "Rejeu — Journée A — exemple"


async def test_rejeu_refuse_hors_plan_de_reference(client, db, world, auth_headers, engine_doubles):
    headers = await auth_headers("dispatcher")
    order = await factory.make_order(db, world, "ST-DLA-001", "SUPER", 5000)
    computed = await factory.make_plan(
        db,
        world,
        [{"truck": "LT-123-AA", "stops": [{"station": "ST-DLA-001", "deliveries": [(order, 5000, None)]}]}],
    )
    empty = await factory.make_plan(db, world, [], kind=PlanKind.MANUAL_REFERENCE)
    computed_id, empty_id = computed.id, empty.id
    await db.commit()

    response = await client.post(f"/plans/{computed_id}/replay", headers=headers)
    assert response.status_code == 409
    assert response.json()["code"] == "not_a_reference_plan"

    response = await client.post(f"/plans/{empty_id}/replay", headers=headers)
    assert response.status_code == 409 and response.json()["code"] == "no_orders"

    response = await client.post("/plans/00000000-0000-0000-0000-000000000001/replay", headers=headers)
    assert response.status_code == 404
    assert engine_doubles == []
