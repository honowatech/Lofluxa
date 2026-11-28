"""RM-16 × F7.4 — livraison d'une commande planifiée en partie (défaut D8).

Une commande planifiée en partie reste `confirmed` à la publication (son reliquat est à replanifier).
La saisie de sa livraison n'est jamais refusée ; la commande ne passe `delivered` que lorsqu'elle est
entièrement livrée (somme des volumes réels des plans publiés ≥ volume demandé, à la tolérance
`loading_tolerance_pct` près).
"""

from decimal import Decimal

import pytest

from app.admin.models import Setting
from app.core.enums import OrderStatus, StopStatus
from app.planning import service as planning_service
from tests.integration.loading.factory import at, iso, make_trip_scenario


async def _depart(client, headers, scenario) -> None:
    response = await client.post(
        f"/trips/{scenario.trip.id}/loading", json=scenario.loading_payload(), headers=headers
    )
    assert response.status_code == 200, response.text
    for status in ("at_depot", "loaded", "in_progress"):
        response = await client.put(
            f"/trips/{scenario.trip.id}/status", json={"status": status}, headers=headers
        )
        assert response.status_code == 200, response.text


async def _deliver(client, headers, scenario, index, volumes=None):
    stop = scenario.stops[index]
    body = {
        "actual_arrival_at": iso(at(9, 0)),
        "deliveries": [
            {"order_id": str(d.order_id), "actual_l": (volumes or {}).get(d.order_id, float(d.planned_l))}
            for d in stop.deliveries
        ],
    }
    return await client.put(f"/stops/{stop.id}/delivery", json=body, headers=headers)


async def _partial(db, scenario, requested="20000"):
    """La commande de l'arrêt 2 demande 20 000 L, le plan n'en porte que 10 000 : elle reste `confirmed`."""
    order = scenario.orders[2]
    order.requested_l = Decimal(requested)
    order.status = OrderStatus.CONFIRMED
    await db.flush()
    return order


async def test_RM_16_livraison_partielle_enregistree_la_commande_reste_a_replanifier(
    client, db, auth_headers, scenario
):
    headers = await auth_headers("fleet")
    order = await _partial(db, scenario)

    await _depart(client, headers, scenario)
    # Passage à `loaded` : la commande planifiée en partie garde son statut, les autres sont chargées.
    assert order.status == OrderStatus.CONFIRMED
    assert {scenario.orders[0].status, scenario.orders[1].status} == {OrderStatus.LOADED}

    response = await _deliver(client, headers, scenario, 1)

    assert response.status_code == 200, response.text  # jamais de 409 `invalid_order_transition`
    body = response.json()
    assert body["status"] == "delivered"
    assert body["deliveries"][0]["actual_l"] == 10000
    assert body["deliveries"][0]["order_status"] == "confirmed"
    assert scenario.stops[1].status == StopStatus.DELIVERED
    assert scenario.stops[1].deliveries[0].actual_l == Decimal("10000")
    assert order.status == OrderStatus.CONFIRMED
    # Le reliquat (demandé − planifié) reste à planifier pour le service de plans.
    assert await planning_service.order_remainders(db, [order.id]) == {order.id: 10000.0}

    # La tournée se clôture normalement.
    await _deliver(client, headers, scenario, 0)
    done = await client.put(
        f"/trips/{scenario.trip.id}/status",
        json={"status": "completed", "actual_return_at": iso(at(12, 0))},
        headers=headers,
    )
    assert done.status_code == 200, done.text


async def test_RM_16_livraison_complete_en_deux_fois_cloture_la_commande(client, db, auth_headers, products):
    headers = await auth_headers("fleet")
    first = await make_trip_scenario(db, products)
    order = await _partial(db, first)
    await _depart(client, headers, first)
    assert (await _deliver(client, headers, first, 1)).status_code == 200
    assert order.status == OrderStatus.CONFIRMED  # 10 000 L livrés sur 20 000

    # Second plan publié du jour : il porte le reliquat ; à sa publication la commande est `planned`.
    second = await make_trip_scenario(db, products, suffix="-R")
    second.stops[1].deliveries[0].order_id = order.id
    order.status = OrderStatus.PLANNED
    await db.flush()
    await _depart(client, headers, second)
    assert order.status == OrderStatus.LOADED

    response = await _deliver(client, headers, second, 1)

    assert response.status_code == 200, response.text
    assert response.json()["deliveries"][0]["order_status"] == "delivered"
    assert order.status == OrderStatus.DELIVERED  # 10 000 + 10 000 = volume demandé


async def test_RM_16_premiere_livraison_alors_que_le_reste_est_deja_planifie(
    client, db, auth_headers, products
):
    # Les deux plans sont publiés avant toute livraison : la commande est entièrement planifiée.
    headers = await auth_headers("fleet")
    first = await make_trip_scenario(db, products)
    order = first.orders[2]
    order.requested_l = Decimal("20000")
    second = await make_trip_scenario(db, products, suffix="-R")
    second.stops[1].deliveries[0].order_id = order.id
    await db.flush()
    await _depart(client, headers, first)
    assert order.status == OrderStatus.LOADED

    response = await _deliver(client, headers, first, 1)

    # Livrée à moitié, le reste attend sur un arrêt d'un plan publié : statut inchangé, rien à replanifier.
    assert response.status_code == 200, response.text
    assert order.status == OrderStatus.LOADED
    await _depart(client, headers, second)
    assert (await _deliver(client, headers, second, 1)).status_code == 200
    assert order.status == OrderStatus.DELIVERED


@pytest.mark.parametrize(
    ("delivered_l", "expected"),
    [
        (10000, OrderStatus.DELIVERED),
        (9800, OrderStatus.DELIVERED),  # exactement à la tolérance (2 %)
        (9799, OrderStatus.CONFIRMED),  # en dessous : le reliquat reste à replanifier
        (5000, OrderStatus.CONFIRMED),
    ],
)
async def test_commande_entierement_livree_a_la_tolerance_pres(
    client, auth_headers, scenario, delivered_l, expected
):
    headers = await auth_headers("fleet")
    await _depart(client, headers, scenario)
    order = scenario.orders[2]

    response = await _deliver(client, headers, scenario, 1, {order.id: delivered_l})

    assert response.status_code == 200, response.text
    assert order.status == expected


async def test_tolerance_de_livraison_lue_dans_les_parametres(client, db, auth_headers, scenario):
    db.add(Setting(key="loading_tolerance_pct", value=10.0))
    await db.flush()
    headers = await auth_headers("fleet")
    await _depart(client, headers, scenario)
    order = scenario.orders[2]

    assert (await _deliver(client, headers, scenario, 1, {order.id: 9100})).status_code == 200

    assert order.status == OrderStatus.DELIVERED


@pytest.mark.xfail(
    strict=True,
    reason="L5 — app/planning/mapping.py::planned_elsewhere calcule le reliquat sur le volume PLANIFIÉ "
    "des arrêts livrés (`planned_l`), pas sur le volume réellement livré (`actual_l`) : une commande "
    "planifiée en entier mais livrée en dessous du seuil repasse `confirmed` (lot L6) sans que son "
    "reliquat réel soit repris par un nouveau calcul. Correction attendue côté service de plans : "
    "pour un arrêt `delivered`, compter coalesce(actual_l, planned_l).",
)
async def test_reliquat_d_une_commande_sous_livree_repris_par_le_service_de_plans(
    client, db, auth_headers, scenario
):
    headers = await auth_headers("fleet")
    await _depart(client, headers, scenario)
    order = scenario.orders[2]
    assert (await _deliver(client, headers, scenario, 1, {order.id: 7000})).status_code == 200
    assert order.status == OrderStatus.CONFIRMED

    # Attendu : 10 000 demandés − 7 000 réellement livrés = 3 000 L à replanifier.
    assert await planning_service.order_remainders(db, [order.id]) == {order.id: 3000.0}
