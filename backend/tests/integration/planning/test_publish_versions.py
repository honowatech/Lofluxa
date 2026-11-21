"""Recalcul (F5.3, RM-17), publication (F5.4, RM-15), livraison partielle (RM-16), versions (F5.5, RM-18)."""

from decimal import Decimal

import pytest
from sqlalchemy import select

from app.audit.models import AuditLog
from app.core.enums import EventType, OrderPriority, OrderStatus, PlanStatus, Severity, TripStatus
from app.core.errors import ConflictError, RuleViolationError
from app.events.models import Event
from app.orders.models import Order
from app.planning import service
from app.planning.checking import load_plan
from app.planning.domain import ViolationD


def _trip(body, seq):
    return next(t for t in body["trips"] if t["seq"] == seq)


async def _statuses(db, world):
    rows = await db.execute(select(Order.id, Order.status))
    by_id = dict(rows.all())
    return {key: str(by_id[order_id]) for key, order_id in world.order_ids.items()}


@pytest.fixture(autouse=True)
def _order_ids(world):
    world.order_ids = {key: order.id for key, order in world.orders.items()}


# --------------------------------------------------------------------------- recalcul


async def test_RM_17_recalcul_conserve_les_tournees_verrouillees(db, world, plan, fakes):
    """RM-17 : une tournée verrouillée n'est pas modifiée par un recalcul."""
    first, second = plan.trips
    first.locked = True
    extra = Order(
        day=world.day,
        station_id=world.stations["ST-02"].id,
        product_id=world.products["SUPER"].id,
        requested_l=Decimal("3000"),
        priority=OrderPriority.NORMAL,
        status=OrderStatus.CONFIRMED,
    )
    db.add(extra)
    await db.commit()
    first = (await load_plan(db, plan.id)).trips[0]
    frozen = {
        "id": first.id,
        "seq": first.seq,
        "updated_at": first.updated_at,
        "depart": first.planned_depart_at,
        "distance": first.distance_m,
        "stops": [(s.id, s.seq, s.planned_arrival_at) for s in first.stops],
        "loads": sorted(x.id for x in first.compartment_loads),
    }
    old_second_id = second.id
    seen = []

    result = await service.run_recompute(db, plan.id, progress=lambda pct, msg: seen.append(pct))

    assert result.id == plan.id and result.status == PlanStatus.DRAFT  # brouillon : recalculé sur place
    problem = fakes.engine.calls[-1]
    assert [t.ref for t in problem.locked_trips] == [str(first.id)] and problem.locked_trips[0].locked
    assert str(extra.id) in {o.id for o in problem.orders}  # nouvelle commande confirmée prise en compte

    kept = next(t for t in result.trips if t.id == frozen["id"])
    assert kept.locked and kept.seq == frozen["seq"] and kept.updated_at == frozen["updated_at"]
    assert kept.planned_depart_at == frozen["depart"] and kept.distance_m == frozen["distance"]
    assert [(s.id, s.seq, s.planned_arrival_at) for s in kept.stops] == frozen["stops"]
    assert sorted(x.id for x in kept.compartment_loads) == frozen["loads"]
    audit = await db.execute(
        select(AuditLog).where(
            AuditLog.table_name == "trips", AuditLog.row_id == str(first.id), AuditLog.action == "update"
        )
    )
    assert [a.after for a in audit.scalars()] == [{"locked": True}]  # seule écriture : le verrouillage

    others = [t for t in result.trips if t.id != frozen["id"]]
    assert len(others) == 1 and others[0].id != old_second_id and others[0].seq == 2
    delivered = {d.order_id for s in others[0].stops for d in s.deliveries}
    assert delivered == {world.orders["o4"].id, world.orders["o5"].id, extra.id}
    assert result.metrics["orders_served"] == 6 and result.unserved == []
    assert seen[-1] == 100

    event = (await db.execute(select(Event).where(Event.type == EventType.REPLAN))).scalar_one()
    assert event.plan_id == plan.id and event.payload["kept_trip_ids"] == [str(first.id)]


async def test_recalcul_fige_aussi_une_tournee_deja_commencee(db, plan, fakes):
    second = plan.trips[1]
    second.status = TripStatus.LOADED
    await db.commit()
    result = await service.run_recompute(db, plan.id)
    assert {t.ref for t in fakes.engine.calls[-1].locked_trips} == {str(second.id)}
    assert second.id in {t.id for t in result.trips}


# --------------------------------------------------------------------------- publication


async def test_publication_fige_le_plan_et_planifie_les_commandes(client, auth_headers, db, world, plan):
    response = await client.post(f"/plans/{plan.id}/publish", headers=await auth_headers())
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "published" and body["version"] == 1 and body["publishable"] is False
    assert set((await _statuses(db, world)).values()) == {"planned"}

    event = (await db.execute(select(Event).where(Event.type == EventType.PUBLISH))).scalar_one()
    assert event.plan_id == plan.id and event.actor_id is not None
    assert event.payload["orders_planned"] == 5 and event.payload["archived_plan_id"] is None

    again = await client.post(f"/plans/{plan.id}/publish", headers=await auth_headers())
    assert again.status_code == 409 and again.json()["code"] == "plan_already_published"


async def test_publication_refusee_409_si_violation_bloquante(client, auth_headers, db, world, plan, fakes):
    plan_id, trip_id = plan.id, plan.trips[1].id
    fakes.rules.extra = [
        ViolationD(
            "RM-11", Severity.BLOCKING, "Tournée 2 : durée de service de 12 h 10 (maximum 11 h).", trip_seq=2
        ),
        ViolationD("RM-10", Severity.WARNING, "Arrivée 10 min après la fermeture.", trip_seq=1, stop_seq=1),
    ]
    response = await client.post(f"/plans/{plan_id}/publish", headers=await auth_headers())
    assert response.status_code == 409
    error = response.json()
    assert error["code"] == "rule_violation" and "1 violation" in error["message"]
    assert error["details"] == [
        {
            "rule_code": "RM-11",
            "message": "Tournée 2 : durée de service de 12 h 10 (maximum 11 h).",
            "severity": "blocking",
            "trip_id": str(trip_id),
            "stop_id": None,
        }
    ]
    assert (await load_plan(db, plan_id)).status == PlanStatus.DRAFT
    assert set((await _statuses(db, world)).values()) == {"confirmed"}

    # Un avertissement seul ne bloque pas la publication (F5.2).
    fakes.rules.extra = fakes.rules.extra[1:]
    response = await client.post(f"/plans/{plan_id}/publish", headers=await auth_headers())
    assert response.status_code == 200 and response.json()["warning_count"] == 1


async def test_RM_15_commande_urgente_non_servie_bloque_la_publication(db, world, fakes, dispatcher):
    """RM-15 : une commande urgente non servie bloque la publication tant qu'elle n'est pas
    reportée explicitement."""
    urgent = world.orders["o3"]
    fakes.engine.skip = {str(urgent.id)}
    plan = await service.run_compute(db, world.day)
    await db.commit()

    with pytest.raises(RuleViolationError) as excinfo:
        await service.publish_plan(db, plan.id)
    assert excinfo.value.status_code == 409
    assert [d["rule_code"] for d in excinfo.value.details] == ["RM-15"]

    urgent.status = OrderStatus.POSTPONED  # report explicite (route du lot commandes)
    await db.commit()
    published = await service.publish_plan(db, plan.id)
    assert published.status == PlanStatus.PUBLISHED and published.violations == []
    assert [u.order_id for u in published.unserved] == [urgent.id]  # reste visible, jamais effacée
    statuses = await _statuses(db, world)
    assert statuses.pop("o3") == "postponed" and set(statuses.values()) == {"planned"}


async def test_RM_16_reliquat_d_une_livraison_partielle_reste_a_planifier(db, world, fakes, dispatcher):
    """RM-16 : la commande planifiée en partie reste `confirmed` ; son reliquat (demandé − planifié
    dans les plans publiés) est repris par le calcul suivant."""
    partial = world.orders["o1"]  # 10 000 L demandés
    fakes.engine.partial = {str(partial.id): 6000.0}
    first = await service.publish_plan(db, (await service.run_compute(db, world.day)).id)
    assert first.metrics["orders_partial"] == 1

    statuses = await _statuses(db, world)
    assert statuses.pop("o1") == "confirmed" and set(statuses.values()) == {"planned"}
    assert await service.order_remainders(db, [partial.id, world.orders["o2"].id]) == {
        partial.id: 4000.0,
        world.orders["o2"].id: 0.0,
    }

    problem = await service.build_problem(db, world.day)
    assert [(o.id, o.requested_l) for o in problem.orders] == [(str(partial.id), 4000.0)]

    fakes.engine.partial = {}
    second = await service.run_compute(db, world.day)
    assert second.root_plan_id != first.root_plan_id
    assert [float(d.planned_l) for t in second.trips for s in t.stops for d in s.deliveries] == [4000.0]
    # Recontrôlé, le second plan voit toujours 4 000 L demandés (les 6 000 L sont dans un autre plan publié).
    await service.recheck_plan(db, second.id)
    second = await service.publish_plan(db, second.id)
    assert second.metrics["orders_partial"] == 1  # vis-à-vis du volume total demandé
    assert (await _statuses(db, world))["o1"] == "planned"
    assert await service.order_remainders(db, [partial.id]) == {partial.id: 0.0}


# --------------------------------------------------------------------------- versions


async def test_RM_18_modifier_un_plan_publie_cree_une_nouvelle_version(client, auth_headers, db, world, plan):
    """RM-18 : toute modification d'un plan publié crée une nouvelle version ; la version publiée
    précédente est archivée (à la publication de la nouvelle), jamais écrasée."""
    headers = await auth_headers()
    v1_id = plan.id
    first, second = plan.trips
    stop = first.stops[2]
    v1 = (await client.post(f"/plans/{v1_id}/publish", headers=headers)).json()

    # La modification vise la version publiée, avec SES identifiants de tournées et d'arrêts.
    move = {"stop_id": str(stop.id), "to_trip_id": str(second.id), "to_seq": 2}
    response = await client.post(f"/plans/{v1_id}/trips/{first.id}/move-stop", json=move, headers=headers)
    assert response.status_code == 200, response.text
    v2 = response.json()
    assert v2["id"] != str(v1_id) and v2["status"] == "draft" and v2["version"] == 2
    assert v2["parent_plan_id"] == str(v1_id) and v2["root_plan_id"] == str(v1_id)
    assert [s["station_code"] for s in _trip(v2, 2)["stops"]] == ["ST-04", "ST-03"]
    assert not {t["id"] for t in v2["trips"]} & {t["id"] for t in v1["trips"]}

    # La version publiée n'est pas écrasée : contenu identique, toujours publiée.
    current = (await client.get(f"/plans/{v1_id}", headers=headers)).json()
    assert current["status"] == "published" and current["trips"] == v1["trips"]
    assert set((await _statuses(db, world)).values()) == {"planned"}

    # Tant que la version 2 est en préparation, la version publiée ne se modifie pas une seconde fois.
    again = await client.post(f"/plans/{v1_id}/trips/{first.id}/lock", headers=headers)
    assert again.status_code == 409 and again.json()["code"] == "draft_version_exists"
    assert again.json()["details"] == [{"draft_plan_id": v2["id"], "version": 2}]

    # Le brouillon v2 se modifie sur place, puis sa publication archive la v1.
    locked = await client.post(f"/plans/{v2['id']}/trips/{_trip(v2, 1)['id']}/lock", headers=headers)
    assert locked.status_code == 200 and locked.json()["id"] == v2["id"]
    published = await client.post(f"/plans/{v2['id']}/publish", headers=headers)
    assert published.status_code == 200 and published.json()["status"] == "published"
    archived = (await client.get(f"/plans/{v1_id}", headers=headers)).json()
    assert archived["status"] == "archived" and archived["trips"] == v1["trips"]
    refused = await client.post(f"/plans/{v1_id}/trips/{first.id}/lock", headers=headers)
    assert refused.status_code == 409 and refused.json()["code"] == "plan_archived"
    assert (await client.post(f"/plans/{v1_id}/publish", headers=headers)).status_code == 409

    # Historique : qui a changé quoi, quand.
    listing = (await client.get(f"/plans/{v2['id']}/versions", headers=await auth_headers("manager"))).json()
    assert listing["total"] == 2
    h1, h2 = listing["items"]
    assert (h1["version"], h1["status"], h1["is_current"]) == (1, "archived", False)
    assert (h2["version"], h2["status"], h2["is_current"], h2["parent_plan_id"]) == (
        2,
        "published",
        True,
        str(v1_id),
    )
    assert [c["action"] for c in h1["changes"]] == ["publish"]
    assert [c["action"] for c in h2["changes"]] == ["new_version", "move_stop", "lock", "publish"]
    assert "Déplacement d'un arrêt" in h2["reason"] and h2["published_at"] and h2["published_by_name"]
    for change in h2["changes"]:
        assert change["actor_name"] == "Test dispatcher" and change["occurred_at"].endswith("Z")
        assert change["summary"] and change["type"] in ("manual_edit", "publish")
    assert "ST-03" in h2["changes"][1]["summary"]


async def test_new_version_contrat_du_service(db, plan, dispatcher):
    with pytest.raises(ConflictError):  # un brouillon se modifie sur place
        await service.new_version(db, plan.id, reason="Essai")
    published = await service.publish_plan(db, plan.id)
    old_trip, old_stop = published.trips[0], published.trips[0].stops[0]
    old_trip.status = TripStatus.LOADED
    await db.flush()

    copy, ids = await service.new_version_with_ids(db, plan.id, reason="Panne du camion LT-001-AA")
    assert copy.status == PlanStatus.DRAFT and copy.version == 2 and copy.parent_plan_id == plan.id
    new_trip = next(t for t in copy.trips if t.id == ids.trip(old_trip.id))
    assert new_trip.id != old_trip.id and new_trip.seq == old_trip.seq
    assert new_trip.status == TripStatus.LOADED  # l'état d'exécution suit la nouvelle version
    assert ids.stop(old_stop.id) in {s.id for s in new_trip.stops}
    assert len(copy.trips) == 2 and copy.metrics == published.metrics
    event = (await db.execute(select(Event).where(Event.plan_id == copy.id))).scalar_one()
    assert event.payload["reason"] == "Panne du camion LT-001-AA" and event.actor_id == dispatcher.id


async def test_restauration_d_une_version(client, auth_headers, db, plan):
    headers = await auth_headers()
    v1_id = plan.id
    first, second = plan.trips
    move = {"stop_id": str(first.stops[0].id), "to_trip_id": str(second.id), "to_seq": 1}
    v1 = (await client.post(f"/plans/{v1_id}/publish", headers=headers)).json()

    # Rien à restaurer tant que la seule autre version est le brouillon en cours.
    v2 = (await client.post(f"/plans/{v1_id}/trips/{first.id}/move-stop", json=move, headers=headers)).json()
    assert (await client.post(f"/plans/{v1_id}/versions/2/restore", headers=headers)).status_code == 409
    assert (await client.post(f"/plans/{v1_id}/versions/9/restore", headers=headers)).status_code == 404
    v2 = (await client.post(f"/plans/{v2['id']}/publish", headers=headers)).json()
    v3 = (await client.post(f"/plans/{v2['id']}/trips/{_trip(v2, 1)['id']}/lock", headers=headers)).json()
    assert v3["version"] == 3 and v3["status"] == "draft"

    # Restaurer la v1 : nouvelle version 4 (copie de la v1), le brouillon v3 est abandonné (archivé).
    response = await client.post(f"/plans/{v3['id']}/versions/1/restore", headers=headers)
    assert response.status_code == 200, response.text
    v4 = response.json()
    assert v4["version"] == 4 and v4["status"] == "draft" and v4["parent_plan_id"] == str(v1_id)

    def shape(body):
        return [(t["seq"], t["truck_plate"], [s["station_code"] for s in t["stops"]]) for t in body["trips"]]

    assert shape(v4) == shape(v1) and shape(v4) != shape(v2)
    assert [t["planned_depart_at"] for t in v4["trips"]] == [t["planned_depart_at"] for t in v1["trips"]]

    listing = (await client.get(f"/plans/{v1_id}/versions", headers=headers)).json()["items"]
    assert [(v["version"], v["status"]) for v in listing] == [
        (1, "archived"),
        (2, "published"),
        (3, "archived"),
        (4, "draft"),
    ]
    assert [v["is_current"] for v in listing] == [False, True, False, False]
    assert listing[3]["changes"][0]["action"] == "restore" and "version 1" in listing[3]["reason"]

    # La version restaurée prend effet à sa publication.
    assert (await client.post(f"/plans/{v4['id']}/publish", headers=headers)).status_code == 200
    statuses = {
        p["version"]: p["status"] for p in (await client.get("/plans", headers=headers)).json()["items"]
    }
    assert statuses == {1: "archived", 2: "archived", 3: "archived", 4: "published"}
    page = (
        await client.get(f"/plans/{v1_id}/versions", params={"limit": 1, "offset": 3}, headers=headers)
    ).json()
    assert page["total"] == 4 and [v["version"] for v in page["items"]] == [4]


async def test_recalcul_d_un_plan_publie_cree_une_version(db, plan, fakes, dispatcher):
    await service.publish_plan(db, plan.id)
    result = await service.run_recompute(db, plan.id)
    assert result.id != plan.id and result.version == 2 and result.status == PlanStatus.DRAFT
    assert (await load_plan(db, plan.id)).status == PlanStatus.PUBLISHED
    # Les commandes du plan, passées `planned`, sont bien replanifiées.
    assert result.metrics["orders_served"] == 5 and len(result.trips) == 2


async def test_RM_13_violations_du_chargement_conservees(db, plan, dispatcher):
    """Les violations RM-13 sont écrites par le chargement (lot L6), pas par `check_plan` : un
    recontrôle ne les efface pas, et une nouvelle version les reprend sur la tournée copiée."""
    from app.planning.models import ConstraintViolation

    trip = plan.trips[0]
    plan.violations.append(
        ConstraintViolation(
            trip_id=trip.id,
            rule_code="RM-13",
            severity=Severity.WARNING,
            message="Écart de 3,1 % au chargement.",
        )
    )
    await db.flush()

    await service.recheck_plan(db, plan.id)
    await service.recheck_plan(db, plan.id)
    reloaded = await load_plan(db, plan.id)
    assert [(v.rule_code, v.trip_id) for v in reloaded.violations] == [("RM-13", trip.id)]
    assert reloaded.metrics["warning_count"] == 1

    # Une modification manuelle (recontrôle complet) la conserve aussi.
    from app.planning import editing

    edited = await editing.reorder_stops(db, plan.id, trip.id, [s.id for s in reversed(trip.stops)])
    assert [v.rule_code for v in edited.violations] == ["RM-13"]

    await service.publish_plan(db, plan.id)  # un avertissement ne bloque pas
    copy, ids = await service.new_version_with_ids(db, plan.id, reason="Panne")
    assert [(v.rule_code, v.trip_id) for v in copy.violations] == [("RM-13", ids.trip(trip.id))]
    await service.recheck_plan(db, copy.id)
    assert [v.rule_code for v in (await load_plan(db, copy.id)).violations] == ["RM-13"]


async def test_recalcul_conserve_RM_13_des_tournees_figees_seulement(db, plan, fakes, dispatcher):
    from app.planning.models import ConstraintViolation

    first, second = plan.trips
    first.locked = True
    for trip in (first, second):
        plan.violations.append(
            ConstraintViolation(
                trip_id=trip.id, rule_code="RM-13", severity=Severity.WARNING, message="Écart."
            )
        )
    await db.flush()
    result = await service.run_recompute(db, plan.id)
    assert [(v.rule_code, v.trip_id) for v in result.violations] == [("RM-13", first.id)]
