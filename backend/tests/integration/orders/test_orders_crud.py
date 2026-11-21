"""Commandes : saisie, lecture, filtres, modification, suppression, rôles (F3.1)."""

import uuid

import pytest

from app.core.enums import OrderPriority, OrderStatus
from tests.integration.orders.factories import DAY, make_order, make_station


def _payload(station, product, **overrides) -> dict:
    body = {
        "day": DAY.isoformat(),
        "station_id": str(station.id),
        "product_id": str(product.id),
        "requested_l": 12000,
    }
    body.update(overrides)
    return body


async def test_creation_renvoie_un_brouillon_avec_libelles(client, db, auth_headers, products):
    station = await make_station(db, "ST-AKWA")
    response = await client.post(
        "/orders",
        json=_payload(
            station,
            products["SUPER"],
            priority="urgent",
            window_start="08:00",
            window_end="12:30",
            comment="Livrer avant midi",
        ),
        headers=await auth_headers("dispatcher"),
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["status"] == "draft"
    assert body["source"] == "manual"
    assert body["station_code"] == "ST-AKWA"
    assert body["station_name"] == "Station ST-AKWA"
    assert body["product_code"] == "SUPER"
    assert body["product_label"] == "Super"
    assert body["requested_l"] == 12000.0
    assert isinstance(body["requested_l"], float)
    assert (body["window_start"], body["window_end"]) == ("08:00", "12:30")
    assert body["priority"] == "urgent"
    assert body["created_at"].endswith("Z")
    # La station n'a pas de cuve : l'avertissement F3.4 est visible dès la saisie.
    assert [w["code"] for w in body["warnings"]] == ["tank_unknown"]

    read = await client.get(f"/orders/{body['id']}", headers=await auth_headers("manager"))
    assert read.status_code == 200
    assert read.json()["comment"] == "Livrer avant midi"


@pytest.mark.parametrize(
    ("overrides", "field"),
    [
        ({"window_start": "14:00", "window_end": "09:00"}, None),
        ({"window_start": "09:00", "window_end": "09:00"}, None),
        ({"requested_l": 0}, "requested_l"),
        ({"requested_l": -5}, "requested_l"),
        ({"priority": "critique"}, "priority"),
    ],
)
async def test_creation_refuse_les_saisies_incoherentes(client, db, auth_headers, products, overrides, field):
    station = await make_station(db)
    response = await client.post(
        "/orders", json=_payload(station, products["SUPER"], **overrides), headers=await auth_headers()
    )
    assert response.status_code == 422, response.text
    body = response.json()
    assert body["code"] == "validation_error"
    if field:
        assert any(field in detail["field"] for detail in body["details"])
    else:
        assert "fenêtre de livraison" in str(body["details"])


async def test_creation_station_ou_produit_inconnu_ou_station_inactive(client, db, auth_headers, products):
    station = await make_station(db)
    inactive = await make_station(db, "ST-FERMEE", active=False)
    headers = await auth_headers()
    unknown = str(uuid.uuid4())
    # Corps préparés d'avance : une requête en erreur annule la session et expire les objets.
    unknown_station = _payload(station, products["SUPER"], station_id=unknown)
    unknown_product = _payload(station, products["SUPER"], product_id=unknown)
    inactive_station = _payload(inactive, products["SUPER"])

    response = await client.post("/orders", json=unknown_station, headers=headers)
    assert response.status_code == 422
    assert response.json()["message"] == "Station inconnue."

    response = await client.post("/orders", json=unknown_product, headers=headers)
    assert response.status_code == 422
    assert response.json()["message"] == "Produit inconnu."

    response = await client.post("/orders", json=inactive_station, headers=headers)
    assert response.status_code == 422
    assert "inactive" in response.json()["message"]


async def test_roles_ecriture_dispatcher_lecture_tous(client, db, auth_headers, products):
    station = await make_station(db)
    order = await make_order(db, station, products["SUPER"])
    order_id = order.id
    body = _payload(station, products["GASOIL"])

    for role in ("fleet", "supply", "manager"):
        headers = await auth_headers(role)
        assert (await client.post("/orders", json=body, headers=headers)).status_code == 403
        assert (
            await client.patch(f"/orders/{order_id}", json={"comment": "x"}, headers=headers)
        ).status_code == 403
        assert (await client.put(f"/orders/{order_id}", json=body, headers=headers)).status_code == 403
        assert (await client.delete(f"/orders/{order_id}", headers=headers)).status_code == 403
        for action in ("confirm", "cancel", "postpone"):
            assert (await client.post(f"/orders/{order_id}/{action}", headers=headers)).status_code == 403
        refused = await client.post("/orders/confirm", json={"order_ids": [str(order_id)]}, headers=headers)
        assert refused.status_code == 403
        assert refused.json()["code"] == "forbidden"
        assert (await client.get("/orders", headers=headers)).status_code == 200
        assert (await client.get(f"/orders/{order_id}", headers=headers)).status_code == 200

    assert (await client.post("/orders", json=body, headers=await auth_headers("admin"))).status_code == 201
    assert (await client.get("/orders")).status_code == 401
    assert (await client.post("/orders", json=body)).status_code == 401


async def test_liste_filtres_et_pagination(client, db, auth_headers, products):
    akwa = await make_station(db, "ST-AKWA")
    bali = await make_station(db, "ST-BALI")
    other_day = DAY.replace(day=13)
    await make_order(db, akwa, products["SUPER"])
    await make_order(db, akwa, products["GASOIL"], status=OrderStatus.CONFIRMED)
    await make_order(db, bali, products["SUPER"], priority=OrderPriority.URGENT)
    await make_order(db, bali, products["GASOIL"], status=OrderStatus.CANCELLED)
    await make_order(db, bali, products["SUPER"], day=other_day)
    headers = await auth_headers("manager")

    async def total(**params) -> int:
        response = await client.get("/orders", params=params, headers=headers)
        assert response.status_code == 200, response.text
        return response.json()["total"]

    assert await total() == 5
    assert await total(day=DAY.isoformat()) == 4
    assert await total(day=other_day.isoformat()) == 1
    assert await total(day=DAY.isoformat(), station_id=str(akwa.id)) == 2
    assert await total(day=DAY.isoformat(), product_id=str(products["SUPER"].id)) == 2
    assert await total(day=DAY.isoformat(), status="confirmed") == 1
    assert await total(day=DAY.isoformat(), status=["draft", "cancelled"]) == 3
    assert await total(day=DAY.isoformat(), priority="urgent") == 1
    assert await total(day=DAY.isoformat(), station_id=str(bali.id), status="draft", priority="normal") == 0

    page = (
        await client.get("/orders", params={"day": DAY.isoformat(), "limit": 3, "offset": 3}, headers=headers)
    ).json()
    assert (page["total"], page["limit"], page["offset"], len(page["items"])) == (4, 3, 3, 1)
    assert set(page["items"][0]) >= {"station_code", "station_name", "product_code"}

    assert (await client.get("/orders", params={"status": "inconnu"}, headers=headers)).status_code == 422


async def test_modification_partielle_et_complete(client, db, auth_headers, products):
    station = await make_station(db, "ST-AKWA")
    other = await make_station(db, "ST-BALI")
    order = await make_order(db, station, products["SUPER"])
    order_id = order.id
    replacement = _payload(other, products["GASOIL"], requested_l=5000)
    headers = await auth_headers()

    patched = await client.patch(
        f"/orders/{order_id}",
        json={"requested_l": 8000.5, "window_start": "07:00", "window_end": "10:00"},
        headers=headers,
    )
    assert patched.status_code == 200, patched.text
    body = patched.json()
    assert body["requested_l"] == 8000.5
    assert body["window_start"] == "07:00"
    assert body["station_code"] == "ST-AKWA"

    # La cohérence de la fenêtre est contrôlée sur la commande résultante.
    bad = await client.patch(f"/orders/{order_id}", json={"window_end": "06:00"}, headers=headers)
    assert bad.status_code == 422
    assert "fenêtre de livraison" in bad.json()["message"]
    assert (
        await client.patch(f"/orders/{order_id}", json={"requested_l": None}, headers=headers)
    ).status_code == 422

    cleared = await client.patch(f"/orders/{order_id}", json={"window_start": None}, headers=headers)
    assert cleared.status_code == 200
    assert cleared.json()["window_start"] is None
    assert cleared.json()["window_end"] == "10:00"

    replaced = await client.put(f"/orders/{order_id}", json=replacement, headers=headers)
    assert replaced.status_code == 200, replaced.text
    body = replaced.json()
    assert (body["station_code"], body["product_code"], body["requested_l"]) == ("ST-BALI", "GASOIL", 5000.0)
    assert body["window_end"] is None
    assert body["status"] == "draft"

    missing = await client.patch(f"/orders/{uuid.uuid4()}", json={"comment": "x"}, headers=headers)
    assert missing.status_code == 404
    assert missing.json()["code"] == "not_found"


@pytest.mark.parametrize(
    "status",
    [
        OrderStatus.PLANNED,
        OrderStatus.LOADED,
        OrderStatus.DELIVERED,
        OrderStatus.CANCELLED,
        OrderStatus.POSTPONED,
    ],
)
async def test_commande_non_modifiable_hors_brouillon_et_confirmee(
    client, db, auth_headers, products, status
):
    station = await make_station(db)
    order = await make_order(db, station, products["SUPER"], status=status)
    order_id = order.id
    headers = await auth_headers()
    response = await client.patch(f"/orders/{order_id}", json={"requested_l": 1}, headers=headers)
    assert response.status_code == 409
    assert response.json()["code"] == "order_not_editable"
    assert "ne peut plus être modifiée" in response.json()["message"]
    assert (await client.get(f"/orders/{order_id}", headers=headers)).json()["requested_l"] == 10000.0


async def test_suppression_seulement_en_brouillon(client, db, auth_headers, products):
    station = await make_station(db)
    draft = await make_order(db, station, products["SUPER"])
    confirmed = await make_order(db, station, products["GASOIL"], status=OrderStatus.CONFIRMED)
    draft_id, confirmed_id = draft.id, confirmed.id
    headers = await auth_headers()

    assert (await client.delete(f"/orders/{draft_id}", headers=headers)).status_code == 204
    assert (await client.get(f"/orders/{draft_id}", headers=headers)).status_code == 404

    refused = await client.delete(f"/orders/{confirmed_id}", headers=headers)
    assert refused.status_code == 409
    assert refused.json()["code"] == "order_not_deletable"
    assert (await client.get(f"/orders/{confirmed_id}", headers=headers)).status_code == 200
