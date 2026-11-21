"""Commandes : machine à états (F3.3), contrôle à la confirmation (F3.4), confirmation en masse,
fonctions de service offertes aux autres lots."""

import uuid

import pytest

from app.core.enums import OrderStatus
from app.core.errors import ConflictError, NotFoundError
from app.orders import service
from app.orders.models import Order
from tests.integration.orders.factories import make_order, make_station

S = OrderStatus
USER_ACTIONS = {"confirm": S.CONFIRMED, "cancel": S.CANCELLED, "postpone": S.POSTPONED}
ALLOWED_BY_USER = {
    ("confirm", S.DRAFT),
    ("cancel", S.DRAFT),
    ("cancel", S.CONFIRMED),
    ("postpone", S.DRAFT),
    ("postpone", S.CONFIRMED),
}


@pytest.mark.parametrize("action", list(USER_ACTIONS))
@pytest.mark.parametrize("status", list(S))
async def test_F3_3_transitions_par_les_routes(client, db, auth_headers, products, action, status):
    station = await make_station(db, tanks={products["SUPER"]: (30000, 3000)})
    order = await make_order(db, station, products["SUPER"], status=status)
    order_id = order.id
    headers = await auth_headers()

    response = await client.post(f"/orders/{order_id}/{action}", headers=headers)
    current = (await client.get(f"/orders/{order_id}", headers=headers)).json()["status"]
    if (action, status) in ALLOWED_BY_USER:
        assert response.status_code == 200, response.text
        assert response.json()["status"] == USER_ACTIONS[action].value == current
    else:
        assert response.status_code == 409, response.text
        body = response.json()
        assert body["code"] == "invalid_order_transition"
        assert body["message"].startswith("Transition interdite")
        assert body["details"][0] == {
            "order_id": str(order_id),
            "from": status.value,
            "to": USER_ACTIONS[action].value,
        }
        assert current == status.value


async def test_F3_3_transition_sur_commande_inconnue(client, auth_headers):
    response = await client.post(f"/orders/{uuid.uuid4()}/confirm", headers=await auth_headers())
    assert response.status_code == 404


def test_F3_3_table_des_transitions():
    allowed = {(a, b) for a, targets in service.ALLOWED_TRANSITIONS.items() for b in targets}
    assert allowed == {
        (S.DRAFT, S.CONFIRMED),
        (S.DRAFT, S.CANCELLED),
        (S.DRAFT, S.POSTPONED),
        (S.CONFIRMED, S.PLANNED),
        (S.CONFIRMED, S.CANCELLED),
        (S.CONFIRMED, S.POSTPONED),
        (S.PLANNED, S.LOADED),
        (S.PLANNED, S.CONFIRMED),
        (S.PLANNED, S.POSTPONED),
        (S.LOADED, S.DELIVERED),
        (S.LOADED, S.CONFIRMED),
    }
    # Statuts finaux.
    for final in (S.DELIVERED, S.CANCELLED, S.POSTPONED):
        assert not service.ALLOWED_TRANSITIONS[final]
    assert set(service.ALLOWED_TRANSITIONS) == set(S)


def test_apply_status_idempotence_et_refus():
    order = Order(id=uuid.uuid4(), status=S.CONFIRMED)
    assert service.apply_status(order, S.CONFIRMED) is False
    with pytest.raises(ConflictError):
        service.apply_status(order, S.CONFIRMED, idempotent=False)
    assert service.apply_status(order, S.PLANNED) is True
    with pytest.raises(ConflictError) as error:
        service.apply_status(order, S.DELIVERED)
    assert "« planifiée »" in error.value.message and "« livrée »" in error.value.message
    assert order.status == S.PLANNED


# --- F3.4 ------------------------------------------------------------------------------------


async def test_F3_4_volume_superieur_a_la_cuve_bloque_la_confirmation(client, db, auth_headers, products):
    station = await make_station(db, tanks={products["SUPER"]: (30000, 3000)})
    order = await make_order(db, station, products["SUPER"], requested_l=27000.01)
    order_id = order.id
    headers = await auth_headers()

    response = await client.post(f"/orders/{order_id}/confirm", headers=headers)
    assert response.status_code == 422, response.text
    body = response.json()
    assert body["code"] == "order_exceeds_tank_capacity"
    assert "27 000 L" in body["message"]
    assert body["details"][0]["max_l"] == 27000.0
    assert (await client.get(f"/orders/{order_id}", headers=headers)).json()["status"] == "draft"


async def test_F3_4_volume_egal_au_recevable_accepte_sans_avertissement(client, db, auth_headers, products):
    station = await make_station(db, tanks={products["SUPER"]: (30000, 3000)})
    order = await make_order(db, station, products["SUPER"], requested_l=27000)
    response = await client.post(f"/orders/{order.id}/confirm", headers=await auth_headers())
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "confirmed"
    assert response.json()["warnings"] == []


async def test_F3_4_cuve_non_renseignee_avertissement_non_bloquant(client, db, auth_headers, products):
    # La station a une cuve de super, pas de gasoil : la commande de gasoil ne peut pas être contrôlée.
    station = await make_station(db, tanks={products["SUPER"]: (30000, 3000)})
    order = await make_order(db, station, products["GASOIL"], requested_l=90000)
    response = await client.post(f"/orders/{order.id}/confirm", headers=await auth_headers())
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "confirmed"
    assert [w["code"] for w in body["warnings"]] == ["tank_unknown"]
    assert "Cuve non renseignée" in body["warnings"][0]["message"]


async def test_F3_4_recontrole_a_la_modification_d_une_commande_confirmee(client, db, auth_headers, products):
    station = await make_station(db, tanks={products["SUPER"]: (30000, 3000)})
    order = await make_order(db, station, products["SUPER"], status=S.CONFIRMED)
    draft = await make_order(db, station, products["SUPER"])
    order_id, draft_id = order.id, draft.id
    headers = await auth_headers()

    refused = await client.patch(f"/orders/{order_id}", json={"requested_l": 28000}, headers=headers)
    assert refused.status_code == 422
    assert refused.json()["code"] == "order_exceeds_tank_capacity"
    assert (await client.get(f"/orders/{order_id}", headers=headers)).json()["requested_l"] == 10000.0

    accepted = await client.patch(f"/orders/{order_id}", json={"requested_l": 20000}, headers=headers)
    assert accepted.status_code == 200
    assert accepted.json()["status"] == "confirmed"

    # Un brouillon n'est contrôlé qu'à sa confirmation.
    loose = await client.patch(f"/orders/{draft_id}", json={"requested_l": 99000}, headers=headers)
    assert loose.status_code == 200


# --- Confirmation en masse -------------------------------------------------------------------


async def test_confirmation_en_masse_un_resultat_par_commande(client, db, auth_headers, products):
    station = await make_station(db, tanks={products["SUPER"]: (30000, 3000)})
    ok = await make_order(db, station, products["SUPER"])
    warned = await make_order(db, station, products["GASOIL"])
    too_big = await make_order(db, station, products["SUPER"], requested_l=50000)
    cancelled = await make_order(db, station, products["SUPER"], status=S.CANCELLED)
    unknown = uuid.uuid4()
    ids = [ok.id, warned.id, too_big.id, cancelled.id, unknown]
    headers = await auth_headers()

    response = await client.post(
        "/orders/confirm", json={"order_ids": [str(i) for i in ids] + [str(ok.id)]}, headers=headers
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["confirmed"], body["failed"]) == (2, 3)
    results = body["results"]
    assert [r["order_id"] for r in results] == [str(i) for i in ids]
    assert [r["ok"] for r in results] == [True, True, False, False, False]
    assert results[0]["order"]["status"] == "confirmed"
    assert results[0]["order"]["station_code"] == station.code
    assert results[0]["warnings"] == []
    assert results[1]["warnings"][0]["code"] == "tank_unknown"
    assert [r["error"]["code"] for r in results[2:]] == [
        "order_exceeds_tank_capacity",
        "invalid_order_transition",
        "not_found",
    ]
    assert results[2]["order"] is None

    statuses = {
        item["id"]: item["status"] for item in (await client.get("/orders", headers=headers)).json()["items"]
    }
    assert statuses == {
        str(ok.id): "confirmed",
        str(warned.id): "confirmed",
        str(too_big.id): "draft",
        str(cancelled.id): "cancelled",
    }


async def test_confirmation_en_masse_liste_vide_refusee(client, auth_headers):
    response = await client.post("/orders/confirm", json={"order_ids": []}, headers=await auth_headers())
    assert response.status_code == 422


# --- Fonctions de service pour les autres lots -----------------------------------------------


async def test_service_cycle_publication_chargement_livraison(db, products):
    station = await make_station(db)
    orders = [await make_order(db, station, products["SUPER"], status=S.CONFIRMED) for _ in range(2)]
    ids = [o.id for o in orders]

    planned = await service.mark_planned(db, ids)
    assert [o.status for o in planned] == [S.PLANNED, S.PLANNED]
    # Idempotent : republier un plan ne lève pas d'erreur.
    await service.mark_planned(db, ids)
    await service.mark_loaded(db, ids)
    await service.mark_delivered(db, ids[:1])
    await service.release_to_confirmed(db, ids[1:])
    await db.commit()

    assert (await db.get(Order, ids[0])).status == S.DELIVERED
    assert (await db.get(Order, ids[1])).status == S.CONFIRMED
    assert await service.set_orders_status(db, [], S.PLANNED) == []


async def test_service_transition_interdite_tout_ou_rien(db, products):
    station = await make_station(db)
    confirmed = await make_order(db, station, products["SUPER"], status=S.CONFIRMED)
    draft = await make_order(db, station, products["SUPER"])

    with pytest.raises(ConflictError) as error:
        await service.mark_planned(db, [confirmed.id, draft.id])
    assert error.value.code == "invalid_order_transition"
    assert error.value.status_code == 409
    assert confirmed.status == S.CONFIRMED  # rien n'a été appliqué

    with pytest.raises(ConflictError):
        await service.mark_delivered(db, [confirmed.id])  # pas de saut d'étape
    with pytest.raises(NotFoundError):
        await service.mark_planned(db, [confirmed.id, uuid.uuid4()])


async def test_service_report_d_une_commande_planifiee(db, products):
    station = await make_station(db)
    planned = await make_order(db, station, products["SUPER"], status=S.PLANNED)
    loaded = await make_order(db, station, products["SUPER"], status=S.LOADED)
    assert (await service.mark_postponed(db, [planned.id]))[0].status == S.POSTPONED
    with pytest.raises(ConflictError):
        await service.mark_postponed(db, [loaded.id])


def test_service_variante_synchrone(db, products):
    # Vérifie seulement la signature et le chemin sans accès base (liste vide).
    assert service.set_orders_status_sync(None, [], S.PLANNED) == []


async def test_F3_4_avertissements_recalcules_en_lecture(client, db, auth_headers, products):
    station = await make_station(db, tanks={products["SUPER"]: (30000, 3000)})
    fits = await make_order(db, station, products["SUPER"])
    no_tank_draft = await make_order(db, station, products["GASOIL"])
    no_tank_confirmed = await make_order(db, station, products["GASOIL"], status=S.CONFIRMED)
    too_big = await make_order(db, station, products["SUPER"], requested_l=50000)
    planned = await make_order(db, station, products["GASOIL"], status=S.PLANNED)
    cancelled = await make_order(db, station, products["GASOIL"], status=S.CANCELLED)
    headers = await auth_headers("manager")

    listing = (await client.get("/orders", headers=headers)).json()["items"]
    codes = {item["id"]: [w["code"] for w in item["warnings"]] for item in listing}
    assert codes == {
        str(fits.id): [],
        str(no_tank_draft.id): ["tank_unknown"],
        str(no_tank_confirmed.id): ["tank_unknown"],
        str(too_big.id): ["exceeds_tank_capacity"],
        # Au-delà de `confirmed`, la commande n'est plus modifiable : plus d'avertissement.
        str(planned.id): [],
        str(cancelled.id): [],
    }

    one = (await client.get(f"/orders/{no_tank_confirmed.id}", headers=headers)).json()
    assert "Cuve non renseignée" in one["warnings"][0]["message"]
    big = (await client.get(f"/orders/{too_big.id}", headers=headers)).json()
    assert "27 000 L" in big["warnings"][0]["message"]
    assert (await client.get(f"/orders/{planned.id}", headers=headers)).json()["warnings"] == []


async def test_F3_4_lecture_charge_les_cuves_en_une_requete(client, db, auth_headers, products):
    from sqlalchemy import event, select

    from app.core.db import async_engine

    stations = [await make_station(db, f"ST-{i:03d}") for i in range(6)]
    for station in stations:
        await make_order(db, station, products["SUPER"])
    headers = await auth_headers("manager")

    statements: list[str] = []

    def _count(conn, cursor, statement, *args):
        statements.append(statement)

    event.listen(async_engine.sync_engine, "before_cursor_execute", _count)
    try:
        response = await client.get("/orders", headers=headers)
    finally:
        event.remove(async_engine.sync_engine, "before_cursor_execute", _count)
    body = response.json()
    assert body["total"] == 6
    assert all(item["warnings"][0]["code"] == "tank_unknown" for item in body["items"])
    # Nombre de requêtes indépendant du nombre de commandes (pas de requête par ligne).
    assert sum("FROM station_tanks" in s for s in statements) <= 2

    # Variante pour les autres modules, sans station chargée : une requête pour tout le lot.
    orders = (await db.execute(select(Order))).scalars().all()
    statements.clear()
    event.listen(async_engine.sync_engine, "before_cursor_execute", _count)
    try:
        warnings = await service.order_warnings(db, orders)
    finally:
        event.remove(async_engine.sync_engine, "before_cursor_execute", _count)
    assert len(statements) == 1
    assert len(warnings) == 6
