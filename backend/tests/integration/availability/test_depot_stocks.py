"""Stocks dépôt du jour (F2.1) : saisie Supply, historique conservé, valeur courante."""

import uuid

from sqlalchemy import select

from app.audit.models import AuditLog
from app.availability import service
from tests.integration.orders.factories import DAY, make_depot

URL = "/availability/depot-stocks"
PARAMS = {"day": DAY.isoformat()}


def _items(*triples) -> dict:
    return {
        "items": [
            {"depot_id": str(depot.id), "product_id": str(product.id), "available_l": value}
            for depot, product, value in triples
        ]
    }


async def test_F2_1_grille_non_renseignee_puis_saisie(client, db, auth_headers, products):
    depot = await make_depot(db, "SCDP-DLA")
    await make_depot(db, "SCDP-INACTIF", active=False)
    reader = await auth_headers("manager")

    grid = (await client.get(URL, params=PARAMS, headers=reader)).json()
    assert grid["total"] == 3  # un dépôt actif × trois produits
    assert [row["product_code"] for row in grid["items"]] == ["GASOIL", "PETROLE", "SUPER"]
    assert all(row["available_l"] is None and row["history_count"] == 0 for row in grid["items"])
    assert grid["items"][0]["depot_code"] == "SCDP-DLA"

    saved = await client.put(
        URL,
        params=PARAMS,
        json=_items((depot, products["SUPER"], 120000), (depot, products["GASOIL"], 80000.5)),
        headers=await auth_headers("supply"),
    )
    assert saved.status_code == 200, saved.text
    rows = {row["product_code"]: row for row in saved.json()}
    assert rows["SUPER"]["available_l"] == 120000.0
    assert rows["GASOIL"]["available_l"] == 80000.5
    assert rows["SUPER"]["entered_by_name"] == "Test supply"
    assert rows["SUPER"]["entered_at"].endswith("Z")
    assert rows["SUPER"]["history_count"] == 1

    grid = (await client.get(URL, params=PARAMS, headers=reader)).json()
    by_code = {row["product_code"]: row["available_l"] for row in grid["items"]}
    assert by_code == {"GASOIL": 80000.5, "PETROLE": None, "SUPER": 120000.0}

    only_super = await client.get(
        URL, params={**PARAMS, "product_id": str(products["SUPER"].id)}, headers=reader
    )
    assert only_super.json()["total"] == 1
    # Un autre jour n'est pas renseigné.
    other_day = (await client.get(URL, params={"day": "2027-01-13"}, headers=reader)).json()
    assert all(row["available_l"] is None for row in other_day["items"])


async def test_F2_1_une_nouvelle_saisie_n_ecrase_pas_la_precedente(client, db, auth_headers, products):
    depot = await make_depot(db)
    supply = await auth_headers("supply")
    admin = await auth_headers("admin")
    super_ = products["SUPER"]

    for headers, value in ((supply, 120000), (supply, 95000), (admin, 60000)):
        response = await client.put(URL, params=PARAMS, json=_items((depot, super_, value)), headers=headers)
        assert response.status_code == 200, response.text
    # Valeur inchangée : pas de nouvelle ligne.
    again = await client.put(URL, params=PARAMS, json=_items((depot, super_, 60000)), headers=supply)
    assert again.json()[0]["history_count"] == 3

    current = (await client.get(URL, params=PARAMS, headers=supply)).json()["items"]
    row = next(r for r in current if r["product_code"] == "SUPER")
    assert row["available_l"] == 60000.0
    assert row["entered_by_name"] == "Test admin"
    assert row["history_count"] == 3

    history = await client.get(f"{URL}/history", params=PARAMS, headers=await auth_headers("manager"))
    assert history.status_code == 200, history.text
    body = history.json()
    assert body["total"] == 3
    assert [e["available_l"] for e in body["items"]] == [60000.0, 95000.0, 120000.0]
    assert [e["is_current"] for e in body["items"]] == [True, False, False]
    assert [e["entered_by_name"] for e in body["items"]] == ["Test admin", "Test supply", "Test supply"]
    assert body["items"][0]["entered_at"] > body["items"][1]["entered_at"] > body["items"][2]["entered_at"]
    assert body["items"][0]["id"] == row["id"]

    filtered = await client.get(
        f"{URL}/history", params={**PARAMS, "product_id": str(products["GASOIL"].id)}, headers=supply
    )
    assert filtered.json()["total"] == 0
    paged = await client.get(f"{URL}/history", params={**PARAMS, "limit": 1, "offset": 1}, headers=supply)
    assert [e["available_l"] for e in paged.json()["items"]] == [95000.0]

    # Fonction de service offerte aux autres lots : la plus récente fait foi.
    stocks = await service.current_depot_stocks(db, DAY)
    assert float(stocks[(depot.id, super_.id)].available_l) == 60000.0

    # Chaque saisie est journalisée (F9.3).
    audited = (
        (await db.execute(select(AuditLog).where(AuditLog.table_name == "daily_depot_stocks")))
        .scalars()
        .all()
    )
    assert len(audited) == 3
    assert all(entry.action == "insert" and entry.actor_id is not None for entry in audited)


async def test_F2_1_roles(client, db, auth_headers, products):
    depot = await make_depot(db)
    body = _items((depot, products["SUPER"], 1000))
    for role in ("dispatcher", "fleet", "manager"):
        headers = await auth_headers(role)
        refused = await client.put(URL, params=PARAMS, json=body, headers=headers)
        assert refused.status_code == 403
        assert (await client.get(URL, params=PARAMS, headers=headers)).status_code == 200
        assert (await client.get(f"{URL}/history", params=PARAMS, headers=headers)).status_code == 200
    assert (
        await client.put(URL, params=PARAMS, json=body, headers=await auth_headers("admin"))
    ).status_code == 200
    assert (await client.get(URL, params=PARAMS)).status_code == 401
    assert (await client.put(URL, params=PARAMS, json=body)).status_code == 401


async def test_F2_1_saisies_invalides(client, db, auth_headers, products):
    depot = await make_depot(db)
    headers = await auth_headers("supply")
    negative = _items((depot, products["SUPER"], -1))
    duplicate = _items((depot, products["SUPER"], 10), (depot, products["SUPER"], 20))
    unknown_depot = {
        "items": [{"depot_id": str(uuid.uuid4()), "product_id": str(products["SUPER"].id), "available_l": 1}]
    }
    unknown_product = {
        "items": [{"depot_id": str(depot.id), "product_id": str(uuid.uuid4()), "available_l": 1}]
    }

    assert (await client.put(URL, params=PARAMS, json=negative, headers=headers)).status_code == 422
    assert (await client.put(URL, params=PARAMS, json=duplicate, headers=headers)).status_code == 422
    assert (await client.put(URL, params=PARAMS, json={"items": []}, headers=headers)).status_code == 422
    assert (await client.put(URL, json=negative, headers=headers)).status_code == 422  # jour obligatoire
    assert (await client.get(URL, headers=headers)).status_code == 422
    missing = await client.put(URL, params=PARAMS, json=unknown_depot, headers=headers)
    assert (missing.status_code, missing.json()["message"]) == (404, "Dépôt introuvable.")
    missing = await client.put(URL, params=PARAMS, json=unknown_product, headers=headers)
    assert (missing.status_code, missing.json()["message"]) == (404, "Produit introuvable.")
    assert (await client.get(f"{URL}/history", params=PARAMS, headers=headers)).json()["total"] == 0
