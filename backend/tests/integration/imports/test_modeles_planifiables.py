"""Les cinq fichiers modèles forment un jeu cohérent : importés tels quels, ils donnent une journée que le
vrai moteur planifie entièrement, sans violation bloquante (moteur OR-Tools et règles réels, sans doublure).

OSRM est absent en test : la matrice vient du repli haversine (plan marqué `approximate`).
"""

from datetime import date
from pathlib import Path

import pytest
from sqlalchemy import select

from app.core.context import current_user_id
from app.core.enums import OrderStatus
from app.orders.models import Order
from app.planning import service

from .helpers import apply, preview

TEMPLATES = Path(__file__).resolve().parents[4] / "data" / "templates"
FAST = {"solver_time_limit_s": 8, "solver_no_improvement_s": 3}
ORDER = ("depots", "stations", "trucks", "drivers", "orders")


async def import_templates(client, admin, day: date) -> dict[str, dict]:
    batches = {}
    for kind in ORDER:
        params = {"day": day.isoformat()} if kind == "orders" else {}
        content = (TEMPLATES / f"{kind}.xlsx").read_bytes()
        batch = (await preview(client, admin, kind, content, f"{kind}.xlsx", **params)).json()
        assert batch["status"] == "previewed", (kind, batch["report"]["issues"])
        assert (await apply(client, admin, batch)).status_code == 200, kind
        batches[kind] = batch
    return batches


# Un mardi et un dimanche : les horaires d'exemple laissent chaque jour de la semaine planifiable.
@pytest.mark.parametrize("day", [date(2027, 3, 2), date(2027, 3, 7)], ids=["mardi", "dimanche"])
async def test_les_cinq_modeles_donnent_une_journee_planifiable(
    client, auth_headers, make_user, db, products, day
):
    admin = await auth_headers("admin")
    batches = await import_templates(client, admin, day)
    assert {k: b["report"]["summary"]["created"] for k, b in batches.items()} == {
        "depots": 2,
        "stations": 6,
        "trucks": 4,
        "drivers": 5,
        "orders": 7,
    }
    # Aucun avertissement sur les commandes : chaque station a la cuve du produit commandé.
    assert batches["orders"]["report"]["summary"]["warnings"] == 0

    # Le jeu d'exemple : gabarits variés, une station à gabarit limité, des ressources indisponibles.
    stations = {s["code"]: s for s in (await client.get("/stations", headers=admin)).json()["items"]}
    assert (
        stations["ST-DEIDO"]["max_truck_size"] == "small" and stations["ST-AKWA"]["max_truck_size"] == "large"
    )
    trucks = {t["plate"]: t for t in (await client.get("/trucks", headers=admin)).json()["items"]}
    assert sorted(t["size"] for t in trucks.values() if t["status"] == "available") == [
        "large",
        "medium",
        "small",
    ]
    assert trucks["LT 456 CD"]["status"] == "maintenance"
    drivers = (await client.get("/drivers", headers=admin)).json()["items"]
    assert len(drivers) == 5 and sum(d["license_expiry"] < day.isoformat() for d in drivers) == 1

    # Supply saisit les stocks, le dispatcher confirme les commandes importées (brouillons).
    depots = (await client.get("/depots", headers=admin)).json()["items"]
    stocks = [
        {"depot_id": d["id"], "product_id": str(p.id), "available_l": 200000}
        for d in depots
        for p in products.values()
    ]
    saved = await client.put(
        "/availability/depot-stocks", params={"day": day.isoformat()}, json={"items": stocks}, headers=admin
    )
    assert saved.status_code == 200, saved.text
    orders = (await client.get("/orders", params={"day": day.isoformat()}, headers=admin)).json()["items"]
    assert len(orders) == 7 and {o["status"] for o in orders} == {"draft"}
    confirmed = await client.post(
        "/orders/confirm", json={"order_ids": [o["id"] for o in orders]}, headers=admin
    )
    assert confirmed.status_code == 200, confirmed.text
    statuses = (await db.execute(select(Order.status).execution_options(populate_existing=True))).scalars()
    assert set(statuses) == {OrderStatus.CONFIRMED}, confirmed.text

    # Vrai calcul.
    user = await make_user("dispatcher", email="planif@tourneo-test.cm")
    await db.commit()
    token = current_user_id.set(user.id)
    try:
        plan = await service.run_compute(db, day, params_override=FAST)
        await db.commit()
    finally:
        current_user_id.reset(token)

    body = (await client.get(f"/plans/{plan.id}", headers=admin)).json()
    assert body["unserved"] == [], body["unserved"]
    assert body["blocking_count"] == 0, body["violations"]
    assert body["publishable"] is True
    delivered = {d["order_id"] for t in body["trips"] for s in t["stops"] for d in s["deliveries"]}
    assert delivered == {o["id"] for o in orders}
    # Ni le camion en maintenance ni le chauffeur au permis expiré ne sont utilisés ; RM-09 respectée.
    assert "LT 456 CD" not in {t["truck_plate"] for t in body["trips"]}
    assert "Pierre Ewodo" not in {t["driver_name"] for t in body["trips"]}
    deido = next(
        t for t in body["trips"] if any(s["station_id"] == stations["ST-DEIDO"]["id"] for s in t["stops"])
    )
    assert trucks[deido["truck_plate"]]["size"] == "small"
    published = await client.post(f"/plans/{plan.id}/publish", headers=admin)
    assert published.status_code == 200, published.text
