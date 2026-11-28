"""Plusieurs plans le même jour : ressources déjà engagées (RM-02, RM-11, RM-14), reliquat du
réellement livré (RM-16), libellé d'affichage et version en vigueur."""

from decimal import Decimal

from sqlalchemy import select

from app.core.enums import OrderPriority, OrderStatus, PlanKind, PlanStatus, StopStatus
from app.orders.models import Order
from app.planning import checking, mapping, service
from app.planning.checking import load_plan
from app.planning.models import Trip


async def _second_plan(db, world, plan):
    """Publie le premier plan, puis calcule un second plan du jour pour une nouvelle commande."""
    await service.publish_plan(db, plan.id)
    extra = Order(
        day=world.day,
        station_id=world.stations["ST-02"].id,
        product_id=world.products["SUPER"].id,
        requested_l=Decimal("3000"),
        priority=OrderPriority.NORMAL,
        status=OrderStatus.CONFIRMED,
    )
    db.add(extra)
    await db.flush()
    return await service.run_compute(db, world.day), extra


async def test_RM_02_RM_14_second_plan_tient_compte_des_tournees_du_premier(
    db, world, plan, fakes, dispatcher
):
    """Le second plan du jour voit les tournées du premier plan publié : passées au moteur comme
    tournées figées, jamais rattachées au second plan, et prises en compte par les règles."""
    first = await load_plan(db, plan.id)
    second, extra = await _second_plan(db, world, plan)

    # Le moteur a reçu les deux tournées du premier plan, figées, sans livraisons ni chargement.
    problem = fakes.engine.calls[-1]
    assert {t.ref for t in problem.locked_trips} == {str(t.id) for t in first.trips}
    assert all(t.locked and t.seq > mapping.FOREIGN_SEQ_BASE for t in problem.locked_trips)
    assert all(not t.loads and not any(s.deliveries for s in t.stops) for t in problem.locked_trips)
    assert [o.id for o in problem.orders] == [str(extra.id)]

    # Elles ne sont pas recopiées dans le second plan, et celles du premier ne sont pas réécrites.
    assert second.root_plan_id != first.id and len(second.trips) == 1
    assert {t.plan_id for t in (await db.execute(select(Trip))).scalars()} == {first.id, second.id}
    assert len((await load_plan(db, first.id)).trips) == 2
    trip = second.trips[0]
    same_truck = next(t for t in first.trips if t.truck_id == trip.truck_id)
    assert trip.planned_start_at >= same_truck.planned_return_at  # pas de chevauchement (RM-02)
    assert second.violations == [] and second.metrics["trips_count"] == 1

    # Affectation manuelle fautive : la tournée est avancée à l'heure où le camion roule déjà.
    trip.planned_start_at = same_truck.planned_start_at
    await db.flush()
    violations = await service.recheck_plan(db, second.id)
    rm02 = [v for v in violations if v.rule_code == "RM-02"]
    assert rm02 and all(v.severity == "blocking" for v in rm02)
    assert any("du plan publié (version 1)" in v.message for v in rm02)  # tournée de l'autre plan nommée
    assert not any("900" in v.message for v in violations), [v.message for v in violations]
    stored = (await load_plan(db, second.id)).violations
    assert {v.rule_code for v in stored} == {"RM-02"}
    assert all(v.trip_id in (None, trip.id) for v in stored)  # jamais rattachée à une tournée d'un autre plan

    # Le premier plan, lui, n'est pas affecté par un brouillon.
    assert (await load_plan(db, first.id)).violations == []


async def test_RM_14_chargements_du_jour_cumules_entre_plans(db, world, plan, fakes, dispatcher):
    second, _ = await _second_plan(db, world, plan)
    assert second.violations == []
    world.depot.max_loadings_per_truck_day = 1  # le camion a déjà chargé une fois dans le premier plan
    await db.flush()
    violations = await service.recheck_plan(db, second.id)
    assert [v.rule_code for v in violations] == ["RM-14"]
    assert "2 chargements" in violations[0].message and "du plan publié (version 1)" in violations[0].message

    # Un nouveau calcul ne confie plus rien à un camion arrivé à sa limite : commande non servie.
    third_order = Order(
        day=world.day,
        station_id=world.stations["ST-01"].id,
        product_id=world.products["GASOIL"].id,
        requested_l=Decimal("2000"),
        status=OrderStatus.CONFIRMED,
    )
    db.add(third_order)
    await db.flush()
    third = await service.run_compute(db, world.day)
    assert third.trips == [] and {u.order_id for u in third.unserved} >= {third_order.id}


async def test_RM_11_service_du_chauffeur_cumule_entre_plans(db, world, plan, fakes, dispatcher):
    second, _ = await _second_plan(db, world, plan)
    first = await load_plan(db, plan.id)
    own = second.trips[0]
    other = next(t for t in first.trips if t.driver_id == own.driver_id)
    total_h = (other.duration_s + own.duration_s) / 3600
    # Maximum de service placé entre la plus longue des deux tournées et leur cumul.
    limit = round(max(other.duration_s, own.duration_s) / 3600 + 0.05, 2)
    assert limit < total_h
    second.params_snapshot = {**second.params_snapshot, "max_service_hours": limit}
    await db.flush()
    violations = await service.recheck_plan(db, second.id)
    assert [v.rule_code for v in violations] == ["RM-11"]
    assert "cumulées" in violations[0].message and "du plan publié (version 1)" in violations[0].message


async def test_violations_propres_a_l_autre_plan_ecartees(db, world, plan, fakes, dispatcher):
    """Un défaut interne au premier plan (ici ses deux tournées mises sur le même camion à la même
    heure) n'est pas reporté sur le second plan."""
    first = await load_plan(db, plan.id)
    await service.publish_plan(db, plan.id)
    first = await load_plan(db, plan.id)
    first.trips[1].truck_id = first.trips[0].truck_id  # écriture directe : chevauchement dans le plan publié
    first.trips[1].driver_id = None
    extra = Order(
        day=world.day,
        station_id=world.stations["ST-02"].id,
        product_id=world.products["SUPER"].id,
        requested_l=Decimal("3000"),
        status=OrderStatus.CONFIRMED,
    )
    db.add(extra)
    await db.flush()
    second = await service.run_compute(db, world.day)
    # LT-001 est à sa limite (2 chargements dans le premier plan) : c'est LT-002 qui sert.
    assert [t.truck_id for t in second.trips] == [world.trucks["LT-002-BB"].id]
    assert second.violations == []


async def test_RM_16_reliquat_tient_compte_du_reellement_livre(db, world, plan, fakes, dispatcher):
    """RM-16 : un arrêt livré avec un volume réel inférieur au planifié laisse la différence à planifier."""
    order = world.orders["o1"]  # 10 000 L de Super, tournée 1, arrêt 1
    published = await service.publish_plan(db, plan.id)
    assert await service.order_remainders(db, [order.id]) == {order.id: 0.0}

    stop = published.trips[0].stops[0]
    stop.status = StopStatus.DELIVERED
    stop.deliveries[0].actual_l = Decimal("7000")
    order.status = OrderStatus.CONFIRMED  # livraison incomplète : la commande n'est pas soldée (lot L6)
    await db.flush()

    assert await service.order_remainders(db, [order.id]) == {order.id: 3000.0}
    assert await mapping.planned_elsewhere(db, [order.id]) == {order.id: 7000.0}
    problem = await service.build_problem(db, world.day)
    assert [(o.id, o.requested_l) for o in problem.orders] == [(str(order.id), 3000.0)]

    # Tant que l'arrêt n'est pas livré, ou si le réel dépasse le planifié, c'est le planifié qui compte.
    stop.deliveries[0].actual_l = Decimal("10400")
    await db.flush()
    assert await service.order_remainders(db, [order.id]) == {order.id: 0.0}
    stop.status = StopStatus.PENDING
    stop.deliveries[0].actual_l = Decimal("7000")
    await db.flush()
    assert await service.order_remainders(db, [order.id]) == {order.id: 0.0}

    # Le reliquat se replanifie dans un second plan ; publié, la commande repasse « planned ».
    stop.status = StopStatus.DELIVERED
    await db.flush()
    second = await service.run_compute(db, world.day)
    assert [float(d.planned_l) for t in second.trips for s in t.stops for d in s.deliveries] == [3000.0]
    await service.publish_plan(db, second.id)
    assert order.status == OrderStatus.PLANNED
    assert await service.order_remainders(db, [order.id]) == {order.id: 0.0}


async def test_E2_libelle_d_affichage_et_version_en_vigueur(client, auth_headers, db, world, plan, fakes):
    headers = await auth_headers()

    async def listing():
        items = (await client.get("/plans", params={"day": "2027-01-12"}, headers=headers)).json()["items"]
        return {(p["display_label"], p["status"]): p["is_current"] for p in items}

    assert await listing() == {("Plan du jour — version 1", "draft"): True}
    body = (await client.get(f"/plans/{plan.id}", headers=headers)).json()
    assert body["display_label"] == "Plan du jour — version 1" and body["is_current"] is True

    # Version 2 en préparation : la version publiée reste en vigueur.
    await client.post(f"/plans/{plan.id}/publish", headers=headers)
    trip_id = plan.trips[0].id
    draft = (await client.post(f"/plans/{plan.id}/trips/{trip_id}/lock", headers=headers)).json()
    assert draft["display_label"] == "Plan du jour — version 2" and draft["is_current"] is False
    assert await listing() == {
        ("Plan du jour — version 1", "published"): True,
        ("Plan du jour — version 2", "draft"): False,
    }
    await client.post(f"/plans/{draft['id']}/publish", headers=headers)
    assert await listing() == {
        ("Plan du jour — version 1", "archived"): False,
        ("Plan du jour — version 2", "published"): True,
    }

    # Journée de référence, rejeu et second plan du jour : chacun dit sa nature.
    ids = [world.orders["o1"].id]
    reference = await service.run_compute(
        db, world.day, kind=PlanKind.MANUAL_REFERENCE, order_ids=ids, label="Mardi type"
    )
    await service.run_compute(db, world.day, kind=PlanKind.REPLAY, order_ids=ids, parent_plan_id=reference.id)
    db.add(
        Order(
            day=world.day,
            station_id=world.stations["ST-02"].id,
            product_id=world.products["SUPER"].id,
            requested_l=Decimal("3000"),
            status=OrderStatus.CONFIRMED,
        )
    )
    await db.flush()
    await service.run_compute(db, world.day)
    await db.commit()
    assert await listing() == {
        ("Plan n° 1 du jour — version 1", "archived"): False,
        ("Plan n° 1 du jour — version 2", "published"): True,
        ("Plan n° 2 du jour — version 1", "draft"): True,
        ("Journée de référence — Mardi type", "draft"): True,
        ("Rejeu du 12/01", "draft"): True,
    }
    assert PlanStatus.ARCHIVED and checking  # (imports utilisés par les aides ci-dessus)
