"""Bout en bout SANS doublure : base → vrai moteur OR-Tools → vraies règles → plan enregistré → API.

Test d'intégration de la vague 1 (lots L1, L2, L5). OSRM est absent en test : la matrice est
construite par le repli haversine, le plan est donc marqué `approximate`.
"""

from sqlalchemy import select

from app.core.enums import OrderStatus, PlanKind, PlanStatus
from app.orders.models import Order
from app.planning import engine, service
from app.planning.models import Plan

FAST = {"solver_time_limit_s": 5, "solver_no_improvement_s": 2}


async def test_calcul_reel_puis_edition_publication_et_feuille_de_route(
    client, db, world, dispatcher, auth_headers
):
    plan = await service.run_compute(db, world.day, params_override=FAST)
    await db.commit()
    headers = await auth_headers("dispatcher")

    body = (await client.get(f"/plans/{plan.id}", headers=headers)).json()
    assert body["engine_version"] == engine.ENGINE_VERSION
    assert body["approximate"] is True  # pas d'OSRM en test : repli haversine
    assert body["unserved"] == []
    assert body["blocking_count"] == 0, body["violations"]
    assert body["publishable"] is True
    delivered = {d["order_id"] for t in body["trips"] for s in t["stops"] for d in s["deliveries"]}
    assert delivered == {str(o.id) for o in world.orders.values()}
    for trip in body["trips"]:
        assert trip["driver_id"] and trip["loads"], trip
        assert trip["distance_m"] > 0 and trip["planned_depart_at"] < trip["planned_return_at"]

    # Édition manuelle : inverser l'ordre des arrêts d'une tournée qui en a plusieurs → recontrôle réel.
    multi = next((t for t in body["trips"] if len(t["stops"]) > 1), None)
    if multi is not None:
        reordered = await client.post(
            f"/plans/{plan.id}/trips/{multi['id']}/reorder",
            json={"stop_ids": [s["id"] for s in reversed(multi["stops"])]},
            headers=headers,
        )
        assert reordered.status_code == 200, reordered.text
        assert reordered.json()["blocking_count"] == 0, reordered.json()["violations"]

    published = await client.post(f"/plans/{plan.id}/publish", headers=headers)
    assert published.status_code == 200, published.text
    assert published.json()["status"] == "published"
    statuses = {
        o.status
        for o in (await db.execute(select(Order).execution_options(populate_existing=True))).scalars()
    }
    assert statuses == {OrderStatus.PLANNED}

    pdf = await client.get(f"/plans/{plan.id}/route-sheets.pdf", headers=headers)
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF")


async def test_recalcul_reel_conserve_une_tournee_verrouillee(client, db, world, dispatcher, auth_headers):
    plan = await service.run_compute(db, world.day, params_override=FAST)
    await db.commit()
    headers = await auth_headers("dispatcher")
    before = (await client.get(f"/plans/{plan.id}", headers=headers)).json()
    locked = before["trips"][0]
    assert (
        await client.post(f"/plans/{plan.id}/trips/{locked['id']}/lock", headers=headers)
    ).status_code == 200

    recomputed = await service.run_recompute(db, plan.id, params_override=FAST)
    await db.commit()
    after = (await client.get(f"/plans/{recomputed.id}", headers=headers)).json()

    kept = next(t for t in after["trips"] if t["locked"])
    assert kept["truck_id"] == locked["truck_id"] and kept["driver_id"] == locked["driver_id"]
    assert [s["station_id"] for s in kept["stops"]] == [s["station_id"] for s in locked["stops"]]
    assert after["blocking_count"] == 0, after["violations"]
    assert after["unserved"] == []


async def test_stock_depot_insuffisant_non_servie_avec_sa_raison(client, db, world, dispatcher, auth_headers):
    from app.availability.service import record_depot_stock

    await record_depot_stock(
        db,
        depot_id=world.depot.id,
        product_id=world.products["GASOIL"].id,
        day=world.day,
        available_l=9000,
        user_id=dispatcher.id,
    )
    await db.commit()
    plan = await service.run_compute(db, world.day, params_override=FAST)
    await db.commit()
    body = (await client.get(f"/plans/{plan.id}", headers=await auth_headers("dispatcher"))).json()

    assert [u["reason_code"] for u in body["unserved"]] == ["depot_stock"]
    assert body["unserved"][0]["product_code"] == "GASOIL"
    assert body["blocking_count"] == 0, body["violations"]  # la non-servie est normale, pas urgente
    assert (await db.get(Plan, plan.id)).kind == PlanKind.COMPUTED
    assert (await db.get(Plan, plan.id)).status == PlanStatus.DRAFT
