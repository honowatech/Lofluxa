"""F8.1 — import d'une journée de référence, F8.2 — rejeu."""

import uuid
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
from app.imports.reference_day import TEMPLATE_ORDERS, TEMPLATE_TRIPS, build_workbook, read_reference_day
from app.orders.models import Order
from app.planning import service as plan_service
from app.planning.models import DistanceCache, Plan, TripCompartmentLoad

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
    assert plan.root_plan_id == plan.id and plan.version == 1

    # Métriques enregistrées sur le plan : forme du service de plans (lot L5) + indicateurs du lot L7.
    assert plan.metrics["total_distance_m"] == trip1.distance_m + trip2.distance_m
    assert (plan.metrics["trips_count"], plan.metrics["orders_unserved"]) == (2, 1)
    assert (plan.metrics["blocking_count"], plan.metrics["warning_count"]) == (0, 2)
    comparison = plan.metrics["comparison"]
    assert comparison["distance_actual_m"] == 140_000
    assert comparison["distance_estimated_m"] == trip1.distance_m + trip2.distance_m
    assert comparison["orders_requested"] == 5 and comparison["orders_served"] == 4
    assert comparison["prep_time_s"] == 7200
    assert (comparison["violations_blocking"], comparison["violations_warning"]) == (0, 2)

    # Lot d'import au format commun à tous les imports (lot L3).
    batch = await db.get(ImportBatch, body["batch_id"])
    assert batch.kind == ImportKind.REFERENCE_DAY
    assert batch.status == ImportStatus.APPLIED
    assert batch.filename == "journee_A.xlsx"
    assert batch.report["applied"]["plan_id"] == body["plan_id"]
    assert batch.report["summary"] == {"created": 8, "updated": 0, "unchanged": 0, "errors": 0, "warnings": 0}
    assert batch.report["options"] == {
        "day": "2027-01-12",
        "prep_time_min": 120.0,
        "label": "Journée A — exemple",
        "replace": False,
    }
    history = await client.get(f"/imports/{body['batch_id']}", headers=await auth_headers("manager"))
    assert history.status_code == 200 and history.json()["report"]["applied"]["plan_id"] == body["plan_id"]

    # Les distances calculées sont rangées dans le cache en base (lot L5) : 4 nœuds, 12 paires au plus.
    cached = (await db.execute(select(DistanceCache))).scalars().all()
    assert len(cached) == 20  # dépôt + 4 stations des commandes : 5 × 4 paires


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
    issues = batch.report["issues"]
    assert sum(1 for i in issues if i["severity"] == "error") == 6
    assert {
        "row": 2, "column": "Tournées › Camion", "value": None,
        "message": "Camion inconnu : LT-999-ZZ.", "severity": "error",
    } in issues  # fmt: skip


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


async def test_rejeu_lance_un_calcul_replay_par_le_vrai_service_de_plans(
    client, db, world, auth_headers, engine_doubles
):
    """F8.2 de bout en bout : import → `launch_compute` réel (envoi à Celery intercepté) →
    `run_compute` réel sur les mêmes commandes (moteur simulé) → comparaison A / rejeu."""
    headers = await auth_headers("dispatcher")
    imported = (await _import(client, headers)).json()

    # Le plan de référence est lisible par l'API du service de plans, et en lecture seule.
    response = await client.get(f"/plans/{imported['plan_id']}", headers=headers)
    assert response.status_code == 200, response.text
    read = response.json()
    assert read["kind"] == "manual_reference" and len(read["trips"]) == 2
    assert read["trips"][0]["truck_plate"] == "LT-123-AA" and len(read["trips"][0]["stops"]) == 2
    response = await client.post(f"/plans/{imported['plan_id']}/publish", headers=headers)
    assert response.status_code == 409 and response.json()["code"] == "plan_kind_not_publishable"

    response = await client.post(f"/plans/{imported['plan_id']}/replay", headers=headers)
    assert response.status_code == 202, response.text
    assert response.json() == {"task_id": "task-rejeu-1"}

    # Arguments réellement transmis à la tâche de calcul par `launch_compute`.
    (call,) = engine_doubles
    orders = (await db.execute(select(Order))).scalars().all()
    assert call["day"] == "2027-01-12"
    assert call["kind"] == "replay"
    assert call["parent_plan_id"] == imported["plan_id"]
    assert sorted(call["order_ids"]) == sorted(str(o.id) for o in orders)  # livrées ET non livrées
    assert len(call["order_ids"]) == 5
    assert call["user_id"] is not None
    assert call["label"] == "Rejeu — Journée A — exemple"

    # Ce que fait la tâche : le vrai `run_compute`, avec ces arguments.
    replay = await plan_service.run_compute(
        db,
        DAY,
        kind=PlanKind(call["kind"]),
        order_ids=[uuid.UUID(o) for o in call["order_ids"]],
        parent_plan_id=uuid.UUID(call["parent_plan_id"]),
        label=call["label"],
    )
    await db.commit()
    assert replay.kind == PlanKind.REPLAY and replay.status == PlanStatus.DRAFT
    assert str(replay.parent_plan_id) == imported["plan_id"]
    # Les commandes `delivered` et `postponed` de la journée de référence sont bien reprises.
    planned = {d.order_id for t in replay.trips for s in t.stops for d in s.deliveries}
    assert planned | {u.order_id for u in replay.unserved} == {o.id for o in orders}
    assert len(planned) >= 4  # la doublure du moteur remplit les camions sans optimiser

    response = await client.get(
        "/comparison", params={"plan_a": imported["plan_id"], "plan_b": str(replay.id)}, headers=headers
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["plan_a"]["kind"], body["plan_b"]["kind"]) == ("manual_reference", "replay")
    assert body["metrics_a"]["orders_requested"] == body["metrics_b"]["orders_requested"] == 5
    assert (body["metrics_a"]["orders_served"], body["metrics_b"]["orders_served"]) == (4, len(planned))
    assert body["metrics_b"]["distance_estimated_m"] > 0 and body["verdict"]["gain_pct"] is not None
    assert body["metrics_b"]["prep_time_source"] == "computed"
    assert body["verdict"]["orders_served_ok"] is True


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


async def test_import_fichier_trop_volumineux(client, db, world, auth_headers):
    from app.admin.models import Setting

    db.add(Setting(key="import_max_file_mb", value=0.001))
    await db.commit()
    response = await _import(client, await auth_headers("dispatcher"))
    assert response.status_code == 413 and response.json()["code"] == "file_too_large"


async def test_import_journee_passee_par_un_depot_desactive(client, db, world, auth_headers):
    world.depot.active = False
    await db.commit()
    response = await _import(client, await auth_headers("dispatcher"))
    assert response.status_code == 201, response.text


# --------------------------------------------------------------------------- registre des imports (L3)


async def test_registre_fichier_modele(client, world, auth_headers):
    response = await client.get("/imports/templates/reference_day", headers=await auth_headers("manager"))
    assert response.status_code == 200
    assert response.headers["content-type"] == XLSX
    assert (
        read_reference_day(response.content).to_dict() == read_reference_day(TEMPLATE.read_bytes()).to_dict()
    )


async def test_registre_previsualiser_puis_appliquer(client, db, world, auth_headers):
    headers = await auth_headers("dispatcher")
    response = await client.post(
        "/imports/reference_day/preview",
        params={"prep_time_min": "95", "label": "Mardi type"},
        files=_files(TEMPLATE.read_bytes()),
        headers=headers,
    )
    assert response.status_code == 201, response.text
    preview = response.json()
    assert preview["status"] == "previewed" and preview["can_apply"] is True
    assert preview["row_count"] == 9 and preview["error_count"] == 0
    assert preview["report"]["summary"]["created"] == 8  # 1 plan + 2 tournées + 5 commandes
    assert preview["report"]["items"][0] == {
        "row": None, "key": "plan", "label": "Mardi type", "action": "create", "changes": [],
    }  # fmt: skip
    assert preview["report"]["options"] == {
        "day": "2027-01-12", "prep_time_min": 95.0, "label": "Mardi type", "replace": False,
    }  # fmt: skip
    assert await _plans(db) == []  # la prévisualisation n'écrit rien d'autre que le lot

    response = await client.post(f"/imports/{preview['batch_id']}/apply", headers=headers)
    assert response.status_code == 200, response.text
    applied = response.json()
    assert applied["status"] == "applied"
    (plan,) = await _plans(db)
    assert applied["report"]["applied"]["plan_id"] == str(plan.id)
    assert applied["report"]["applied"]["trips"] == 2 and applied["report"]["applied"]["orders_unserved"] == 1
    assert (
        plan.kind == PlanKind.MANUAL_REFERENCE and plan.label == "Mardi type" and plan.prep_time_s == 95 * 60
    )
    orders = (await db.execute(select(Order))).scalars().all()
    assert len(orders) == 5 and {str(o.import_batch_id) for o in orders} == {preview["batch_id"]}

    # Même résultat que la route en une étape : km estimés, plan de chargement, violations.
    from app.comparison.service import load_bundle, plan_metrics

    metrics = plan_metrics(await load_bundle(db, plan.id))
    assert metrics.distance_estimated_m > 0 and metrics.distance_actual_m == 140_000
    assert (metrics.violations_blocking, metrics.violations_warning) == (0, 2)

    again = await client.post(f"/imports/{preview['batch_id']}/apply", headers=headers)
    assert again.status_code == 409 and again.json()["code"] == "already_applied"


async def test_registre_rejets_roles_et_journee_existante(client, db, world, auth_headers):
    headers = await auth_headers("dispatcher")
    manager = await auth_headers("manager")
    trips = [list(row) for row in TEMPLATE_TRIPS]
    trips[0][1] = "LT-999-ZZ"
    bad = build_workbook(day="2027-01-12", orders=TEMPLATE_ORDERS, trips=trips)

    response = await client.post("/imports/reference_day/preview", files=_files(bad), headers=headers)
    assert response.status_code == 201
    rejected = response.json()
    assert rejected["status"] == "rejected" and rejected["can_apply"] is False
    assert rejected["report"]["issues"] == [
        {
            "row": 2, "column": "Tournées › Camion", "value": None,
            "message": "Camion inconnu : LT-999-ZZ.", "severity": "error",
        }
    ]  # fmt: skip
    assert (await client.post(f"/imports/{rejected['batch_id']}/apply", headers=headers)).status_code == 409

    response = await client.post("/imports/reference_day/preview", files=_files(bad), headers=manager)
    assert response.status_code == 403

    # Journée déjà importée : la prévisualisation est rejetée, sauf avec replace=true.
    first = (await _import(client, headers)).json()
    template = _files(TEMPLATE.read_bytes())
    response = await client.post("/imports/reference_day/preview", files=template, headers=headers)
    assert response.json()["status"] == "rejected"
    assert "existe déjà" in response.json()["report"]["issues"][0]["message"]
    response = await client.post(
        "/imports/reference_day/preview", params={"replace": "true"}, files=template, headers=headers
    )
    assert response.json()["status"] == "previewed"
    response = await client.post(f"/imports/{response.json()['batch_id']}/apply", headers=headers)
    assert response.status_code == 200, response.text
    old, new = await _plans(db)
    assert str(old.id) == first["plan_id"] and old.status == PlanStatus.ARCHIVED
    assert new.status == PlanStatus.DRAFT


async def test_controle_seul_puis_application_par_le_registre(client, db, world, auth_headers):
    """Un lot `previewed` produit par `dry_run` de la route en une étape s'applique par `/imports`."""
    headers = await auth_headers("dispatcher")
    preview = (await _import(client, headers, dry_run="true")).json()
    response = await client.post(f"/imports/{preview['batch_id']}/apply", headers=headers)
    assert response.status_code == 200, response.text
    (plan,) = await _plans(db)
    assert plan.kind == PlanKind.MANUAL_REFERENCE and plan.label == "Journée A — exemple"
