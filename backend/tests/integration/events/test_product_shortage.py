"""F6.3 — produit indisponible au dépôt : déclaration (Supply), tournées impactées, résolution."""

import pytest
from sqlalchemy import func, select

from app.availability.models import DailyDepotStock
from app.core.enums import OrderStatus, PlanStatus
from app.orders.models import Order
from app.planning.checking import load_plan
from app.planning.models import Plan
from tests.integration.events.conftest import DAY
from tests.integration.events.helpers import advance, get_plan, record_loading, trip_by_seq


def _declare(world, code="GASOIL", liters=9000, **extra) -> dict:
    return {
        "depot_id": str(world.depot.id),
        "product_id": str(world.products[code].id),
        "new_available_l": liters,
        "day": DAY.isoformat(),
        **extra,
    }


async def _status(db, order) -> OrderStatus:
    return (await db.execute(select(Order.status).where(Order.id == order.id))).scalar_one()


async def _open_shortage(client, auth_headers, world, **kwargs) -> dict:
    response = await client.post(
        "/events/product-shortage", json=_declare(world, **kwargs), headers=await auth_headers("supply")
    )
    assert response.status_code == 200, response.text
    return response.json()


async def test_declaration_signale_les_tournees_impactees(client, db, auth_headers, world, published, spare):
    """Gasoil : 8 000 L sur la tournée 1 et 9 000 L sur la tournée 2. Le stock tombe à 9 000 L."""
    body = await _open_shortage(client, auth_headers, world, comment="Bac 3 hors service")
    assert body["status"] == "open" and body["depot_code"] == "SCDP-DLA" and body["product_code"] == "GASOIL"
    assert body["previous_available_l"] == 200000 and body["new_available_l"] == 9000
    assert body["loaded_l"] == 0 and body["remaining_l"] == 9000
    assert body["planned_unloaded_l"] == 17000 and body["shortfall_l"] == 8000

    assert [t["trip_seq"] for t in body["impacted_trips"]] == [2]  # la tournée 1 est encore couverte
    trip = body["impacted_trips"][0]
    assert (
        trip["truck_plate"] == "LT-002-BB" and trip["driver_name"] == "Biya" and trip["status"] == "planned"
    )
    assert (trip["planned_l"], trip["covered_l"], trip["shortfall_l"]) == (9000, 1000, 8000)
    assert trip["options"] == ["reduce", "postpone", "change_depot"]
    assert [(o["station_code"], o["planned_l"], o["requested_l"]) for o in trip["orders"]] == [
        ("ST-04", 9000, 9000)
    ]
    assert trip["orders"][0]["order_id"] == str(world.orders["o4"].id)
    assert trip["alternative_depots"] == [
        {
            "depot_id": str(spare.depot2.id),
            "code": "DEP-BON",
            "name": "Dépôt Bonabéri",
            "available_l": 100000,
            "planned_l": 0,
            "remaining_l": 100000,
            "sufficient": True,
        }
    ]

    # Le stock est historisé (la nouvelle saisie fait foi, l'ancienne est conservée).
    rows = (
        await db.execute(
            select(DailyDepotStock.available_l)
            .where(
                DailyDepotStock.depot_id == world.depot.id,
                DailyDepotStock.product_id == world.products["GASOIL"].id,
            )
            .order_by(DailyDepotStock.entered_at)
        )
    ).scalars()
    assert [float(v) for v in rows] == [200000, 9000]

    # Le plan publié n'est pas modifié par la déclaration.
    assert (await db.execute(select(func.count()).select_from(Plan))).scalar_one() == 1

    # Alerte lisible par Fleet et Supply : journal et tableau de bord.
    event = body["event"]
    assert event["type"] == "product_shortage" and event["actor_name"] == "Test supply"
    assert "GASOIL" in event["summary"] and "1 tournée(s) impactée(s)" in event["summary"]
    journal = await client.get(
        "/events", params={"day": DAY.isoformat()}, headers=await auth_headers("fleet")
    )
    assert event["id"] in [e["id"] for e in journal.json()["items"]]
    dashboard = await client.get(
        "/dashboard", params={"day": DAY.isoformat()}, headers=await auth_headers("fleet")
    )
    assert dashboard.status_code == 200, dashboard.text
    alert = next(a for a in dashboard.json()["alerts"] if a["source"] == "event")
    assert alert["code"] == "product_shortage" and alert["event_id"] == event["id"]
    assert alert["payload"]["new_available_l"] == 9000 and alert["payload"]["status"] == "open"
    assert alert["payload"]["impacted_trips"][0]["trip_seq"] == 2 and alert["payload"]["summary"]

    live = await client.get(f"/events/{event['id']}/impact", headers=await auth_headers("supply"))
    assert live.status_code == 200 and [t["trip_seq"] for t in live.json()["impacted_trips"]] == [2]


async def test_declaration_tient_compte_de_ce_qui_est_deja_charge(
    client, auth_headers, world, published, spare
):
    fleet = await auth_headers("fleet")
    trip1 = trip_by_seq(await get_plan(client, fleet, published.id), 1)
    await record_loading(client, fleet, trip1)
    await advance(client, fleet, trip1["id"], "at_depot", "loaded")

    # Stock total du jour inférieur à ce qui est déjà parti : saisie incohérente.
    refused = await client.post(
        "/events/product-shortage", json=_declare(world, liters=5000), headers=await auth_headers("supply")
    )
    assert refused.status_code == 422 and refused.json()["code"] == "stock_below_loaded"
    assert refused.json()["details"][0]["loaded_l"] == 8000

    body = await _open_shortage(client, auth_headers, world, liters=10000)
    assert body["loaded_l"] == 8000 and body["remaining_l"] == 2000 and body["planned_unloaded_l"] == 9000
    trip = body["impacted_trips"][0]
    assert (trip["trip_seq"], trip["covered_l"], trip["shortfall_l"]) == (2, 2000, 7000)


async def test_stock_suffisant_aucune_tournee_impactee(client, auth_headers, world, published, spare):
    body = await _open_shortage(client, auth_headers, world, liters=50000)
    assert body["status"] == "no_impact" and body["impacted_trips"] == [] and body["shortfall_l"] == 0
    assert "Aucune tournée impactée" in body["event"]["summary"]
    trip2 = next(t for t in published.trips if t.seq == 2)
    response = await client.post(
        f"/events/{body['event']['id']}/resolve",
        json={"resolutions": [{"trip_id": str(trip2.id), "action": "postpone"}]},
        headers=await auth_headers("dispatcher"),
    )
    assert response.status_code == 409 and response.json()["code"] == "shortage_not_open"


async def test_resolution_reduire(client, db, auth_headers, world, published, spare):
    shortage = await _open_shortage(client, auth_headers, world)
    trip_id = shortage["impacted_trips"][0]["trip_id"]
    response = await client.post(
        f"/events/{shortage['event']['id']}/resolve",
        json={"resolutions": [{"trip_id": trip_id, "action": "reduce"}]},
        headers=await auth_headers("dispatcher"),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "resolved" and body["impacted_trips"] == []
    result = body["results"][0]
    assert result["plan_version"] == 2 and result["published"] is True and result["blocking_count"] == 0
    assert result["previous_plan_status"] == "archived"
    trip = trip_by_seq(result["plan"], 2)
    volumes = {d["product_code"]: d["planned_l"] for s in trip["stops"] for d in s["deliveries"]}
    assert volumes == {"GASOIL": 1000, "SUPER": 5000}  # réduit au stock restant, le super ne bouge pas
    # RM-16 : livraison partielle sous le seuil → avertissement, le reliquat reste à planifier.
    assert "RM-16" in {v["rule_code"] for v in result["violations"]}
    assert await _status(db, world.orders["o4"]) == OrderStatus.CONFIRMED
    assert await _status(db, world.orders["o5"]) == OrderStatus.PLANNED
    # L'ancienne version garde ses volumes.
    old = await load_plan(db, published.id)
    assert old.status == PlanStatus.ARCHIVED
    assert sorted(
        float(d.planned_l) for t in old.trips if t.seq == 2 for s in t.stops for d in s.deliveries
    ) == [5000, 9000]

    # L'alerte porte la décision ; la résolution est aussi journalisée comme modification du plan.
    payload = body["event"]["payload"]
    assert payload["status"] == "resolved" and payload["resolved_at"]
    assert payload["impacted_trips"][0]["resolution"]["action"] == "reduce"
    assert payload["impacted_trips"][0]["resolution"]["to_l"] == 1000
    journal = await client.get(
        "/events",
        params={"day": DAY.isoformat(), "type": "manual_edit"},
        headers=await auth_headers("supply"),
    )
    edit = next(e for e in journal.json()["items"] if e["action"] == "shortage_resolution")
    assert (
        "réduit de 9 000 L à 1 000 L" in edit["summary"]
        and edit["payload"]["shortage_event_id"] == body["event"]["id"]
    )


async def test_resolution_reduire_avec_volumes_choisis(client, auth_headers, world, published, spare):
    shortage = await _open_shortage(
        client, auth_headers, world, liters=13000
    )  # reste 5 000 L pour la tournée 2
    trip_id = shortage["impacted_trips"][0]["trip_id"]
    url = f"/events/{shortage['event']['id']}/resolve"
    headers = await auth_headers("dispatcher")
    order = str(world.orders["o4"].id)

    def body(liters, order_id=order):
        return {
            "resolutions": [
                {
                    "trip_id": trip_id,
                    "action": "reduce",
                    "deliveries": [{"order_id": order_id, "planned_l": liters}],
                }
            ]
        }

    assert (await client.post(url, json=body(9500), headers=headers)).status_code == 422  # augmentation
    assert (
        await client.post(url, json=body(100, str(world.orders["o5"].id)), headers=headers)
    ).status_code == 422
    response = await client.post(url, json=body(5000), headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "resolved" and response.json()["results"][0]["published"] is True
    trip = trip_by_seq(response.json()["results"][0]["plan"], 2)
    assert {d["product_code"]: d["planned_l"] for s in trip["stops"] for d in s["deliveries"]}[
        "GASOIL"
    ] == 5000


async def test_resolution_reporter(client, db, auth_headers, world, published, spare):
    shortage = await _open_shortage(client, auth_headers, world)
    trip_id = shortage["impacted_trips"][0]["trip_id"]
    response = await client.post(
        f"/events/{shortage['event']['id']}/resolve",
        json={"resolutions": [{"trip_id": trip_id, "action": "postpone"}]},
        headers=await auth_headers("dispatcher"),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "resolved"
    result = body["results"][0]
    assert result["published"] is True and result["blocking_count"] == 0
    trip = trip_by_seq(result["plan"], 2)
    assert [d["product_code"] for s in trip["stops"] for d in s["deliveries"]] == ["SUPER"]
    assert await _status(db, world.orders["o4"]) == OrderStatus.POSTPONED
    unserved = result["plan"]["unserved"]
    assert [(u["order_id"], u["reason_code"], u["order_status"]) for u in unserved] == [
        (str(world.orders["o4"].id), "depot_stock", "postponed")
    ]
    assert body["event"]["payload"]["impacted_trips"][0]["resolution"]["postponed_l"] == 9000


async def test_resolution_changer_de_depot(client, auth_headers, world, published, spare):
    shortage = await _open_shortage(client, auth_headers, world)
    trip_id = shortage["impacted_trips"][0]["trip_id"]
    url = f"/events/{shortage['event']['id']}/resolve"
    headers = await auth_headers("dispatcher")
    missing = await client.post(
        url, json={"resolutions": [{"trip_id": trip_id, "action": "change_depot"}]}, headers=headers
    )
    assert missing.status_code == 422
    same = {"resolutions": [{"trip_id": trip_id, "action": "change_depot", "depot_id": str(world.depot.id)}]}
    assert (await client.post(url, json=same, headers=headers)).status_code == 422

    response = await client.post(
        url,
        json={
            "resolutions": [{"trip_id": trip_id, "action": "change_depot", "depot_id": str(spare.depot2.id)}]
        },
        headers=headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "resolved" and body["results"][0]["published"] is True
    trip = trip_by_seq(body["results"][0]["plan"], 2)
    assert trip["depot_code"] == "DEP-BON" and trip["planned_l"] == 14000
    assert trip["distance_m"] > 0 and trip["stops"][0]["distance_from_prev_m"] > 0  # horaires recalculés
    assert trip_by_seq(body["results"][0]["plan"], 1)["depot_code"] == "SCDP-DLA"


async def test_resolution_en_plusieurs_fois_sur_la_meme_version(
    client, db, auth_headers, world, published, spare
):
    """Super : 16 000 L sur la tournée 1, 5 000 L sur la tournée 2 ; le stock tombe à 12 000 L."""
    shortage = await _open_shortage(client, auth_headers, world, code="SUPER", liters=12000)
    by_seq = {t["trip_seq"]: t for t in shortage["impacted_trips"]}
    assert (by_seq[1]["covered_l"], by_seq[1]["shortfall_l"]) == (12000, 4000)
    assert (by_seq[2]["covered_l"], by_seq[2]["options"]) == (0, ["postpone", "change_depot"])
    url = f"/events/{shortage['event']['id']}/resolve"
    headers = await auth_headers("dispatcher")

    nothing = await client.post(
        url, json={"resolutions": [{"trip_id": by_seq[2]["trip_id"], "action": "reduce"}]}, headers=headers
    )
    assert nothing.status_code == 422 and nothing.json()["code"] == "nothing_left_to_load"
    assert (await db.execute(select(func.count()).select_from(Plan))).scalar_one() == 1

    first = await client.post(
        url, json={"resolutions": [{"trip_id": by_seq[2]["trip_id"], "action": "postpone"}]}, headers=headers
    )
    assert first.status_code == 200, first.text
    body = first.json()
    # Il manque encore du super pour la tournée 1 : RM-08 bloque, la version 2 reste en brouillon.
    assert body["status"] == "open" and [t["trip_seq"] for t in body["impacted_trips"]] == [1]
    assert body["results"][0]["published"] is False and body["results"][0]["plan_status"] == "draft"
    assert "RM-08" in {
        v["rule_code"] for v in body["results"][0]["violations"] if v["severity"] == "blocking"
    }
    assert (await load_plan(db, published.id)).status == PlanStatus.PUBLISHED

    # Seconde décision avec l'identifiant de la tournée publiée : elle se poursuit sur le brouillon.
    second = await client.post(
        url,
        json={"resolutions": [{"trip_id": by_seq[1]["trip_id"], "action": "reduce"}], "publish": True},
        headers=headers,
    )
    assert second.status_code == 200, second.text
    body = second.json()
    assert body["status"] == "resolved" and body["results"][0]["plan_version"] == 2
    assert body["results"][0]["published"] is True and body["results"][0]["version_created"] is False
    trip = trip_by_seq(body["results"][0]["plan"], 1)
    volumes = sorted(
        d["planned_l"] for s in trip["stops"] for d in s["deliveries"] if d["product_code"] == "SUPER"
    )
    assert volumes == [4500, 7500]  # réduction proportionnelle de 16 000 L à 12 000 L
    assert (await db.execute(select(func.count()).select_from(Plan))).scalar_one() == 2
    assert (await load_plan(db, published.id)).status == PlanStatus.ARCHIVED
    assert len(body["event"]["payload"]["resolutions"]) == 2
    assert all(t["resolution"] for t in body["event"]["payload"]["impacted_trips"])

    again = await client.post(
        url, json={"resolutions": [{"trip_id": by_seq[1]["trip_id"], "action": "postpone"}]}, headers=headers
    )
    assert again.status_code == 409 and again.json()["code"] == "shortage_not_open"


async def test_resolution_refusee_sur_une_tournee_non_concernee_ou_un_autre_evenement(
    client, auth_headers, world, published, spare
):
    shortage = await _open_shortage(client, auth_headers, world)
    headers = await auth_headers("dispatcher")
    url = f"/events/{shortage['event']['id']}/resolve"
    fleet = await auth_headers("fleet")
    trip2 = trip_by_seq(await get_plan(client, fleet, published.id), 2)
    await record_loading(client, fleet, trip2)
    loaded = await client.post(
        url, json={"resolutions": [{"trip_id": trip2["id"], "action": "postpone"}]}, headers=headers
    )
    assert loaded.status_code == 409 and loaded.json()["code"] == "trip_already_loaded"

    publish_event = (
        await client.get("/events", params={"day": DAY.isoformat(), "type": "publish"}, headers=headers)
    ).json()["items"][0]
    other = await client.post(
        f"/events/{publish_event['id']}/resolve",
        json={"resolutions": [{"trip_id": trip2["id"], "action": "postpone"}]},
        headers=headers,
    )
    assert other.status_code == 409 and other.json()["code"] == "event_not_resolvable"
    unknown = await client.post(
        "/events/00000000-0000-7000-8000-000000000000/resolve",
        json={"resolutions": [{"trip_id": trip2["id"], "action": "postpone"}]},
        headers=headers,
    )
    assert unknown.status_code == 404


@pytest.mark.parametrize(
    ("role", "declare", "resolve"),
    [
        ("supply", 200, 403),
        ("dispatcher", 403, 200),
        ("admin", 200, 200),
        ("fleet", 403, 403),
        ("manager", 403, 403),
    ],
)
async def test_roles_sur_la_penurie(client, auth_headers, world, published, spare, role, declare, resolve):
    headers = await auth_headers(role)
    response = await client.post("/events/product-shortage", json=_declare(world), headers=headers)
    assert response.status_code == declare, response.text
    shortage = await _open_shortage(client, auth_headers, world, liters=8500)
    trip_id = shortage["impacted_trips"][0]["trip_id"]
    response = await client.post(
        f"/events/{shortage['event']['id']}/resolve",
        json={"resolutions": [{"trip_id": trip_id, "action": "postpone"}]},
        headers=headers,
    )
    assert response.status_code == resolve, response.text


async def test_reduire_la_premiere_tournee_avant_de_traiter_la_seconde(
    client, db, auth_headers, world, published, spare
):
    """Ce que `/impact` annonce comme couvert est accordé par `/resolve`, quel que soit l'ordre :
    super à 12 000 L, tournée 1 couverte à 12 000 L sur 16 000, tournée 2 non couverte."""
    shortage = await _open_shortage(client, auth_headers, world, code="SUPER", liters=12000)
    headers = await auth_headers("dispatcher")
    event_id = shortage["event"]["id"]
    impact = (await client.get(f"/events/{event_id}/impact", headers=headers)).json()
    by_seq = {t["trip_seq"]: t for t in impact["impacted_trips"]}
    assert by_seq[1]["covered_l"] == 12000 and "reduce" in by_seq[1]["options"]
    assert by_seq[2]["covered_l"] == 0

    response = await client.post(
        f"/events/{event_id}/resolve",
        json={"resolutions": [{"trip_id": by_seq[1]["trip_id"], "action": "reduce"}]},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    trip = trip_by_seq(body["results"][0]["plan"], 1)
    volumes = sorted(
        d["planned_l"] for s in trip["stops"] for d in s["deliveries"] if d["product_code"] == "SUPER"
    )
    assert volumes == [4500, 7500]  # 16 000 L ramenés aux 12 000 L annoncés
    # La tournée 2 reste à traiter : l'alerte reste ouverte, la version reste en brouillon (RM-08).
    assert body["status"] == "open" and [t["trip_seq"] for t in body["impacted_trips"]] == [2]
    assert body["impacted_trips"][0]["covered_l"] == 0 and body["results"][0]["published"] is False

    second = await client.post(
        f"/events/{event_id}/resolve",
        json={
            "resolutions": [{"trip_id": body["impacted_trips"][0]["trip_id"], "action": "postpone"}],
            "publish": True,
        },
        headers=headers,
    )
    assert second.status_code == 200, second.text
    assert second.json()["status"] == "resolved" and second.json()["results"][0]["published"] is True
    assert await _status(db, world.orders["o5"]) == OrderStatus.POSTPONED


async def test_heure_de_la_penurie_et_de_sa_resolution(client, auth_headers, world, published, spare):
    from tests.integration.events.conftest import at, iso

    shortage = await _open_shortage(client, auth_headers, world, occurred_at=iso(at(9, 15)))
    assert shortage["event"]["occurred_at"] == iso(at(9, 15))
    headers = await auth_headers("dispatcher")
    response = await client.post(
        f"/events/{shortage['event']['id']}/resolve",
        json={
            "resolutions": [{"trip_id": shortage["impacted_trips"][0]["trip_id"], "action": "postpone"}],
            "occurred_at": iso(at(9, 40)),
        },
        headers=headers,
    )
    assert response.status_code == 200, response.text
    journal = await client.get(
        "/events",
        params={"day": DAY.isoformat(), "type": ["manual_edit", "product_shortage"]},
        headers=headers,
    )
    times = {e["action"]: e["occurred_at"] for e in journal.json()["items"]}
    assert times["declared"] == iso(at(9, 15)) and times["shortage_resolution"] == iso(at(9, 40))
