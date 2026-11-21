"""Résumé de la disponibilité du jour (écran « Journée »)."""

from datetime import date

from app.core.enums import DriverStatus, OrderPriority, OrderStatus, TruckStatus
from tests.integration.orders.factories import (
    DAY,
    make_depot,
    make_driver,
    make_order,
    make_station,
    make_truck,
)

URL = "/availability/summary"
PARAMS = {"day": DAY.isoformat()}


async def test_resume_d_une_journee_vide(client, auth_headers):
    response = await client.get(URL, params=PARAMS, headers=await auth_headers("manager"))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["day"] == DAY.isoformat()
    assert body["orders"]["total"] == 0
    assert set(body["orders"]["by_status"]) == {s.value for s in OrderStatus}
    assert body["trucks"] == {"total": 0, "assignable": 0, "blocked": 0}
    assert body["drivers"]["total"] == 0
    assert body["depot_stocks"] == {
        "expected": 0,
        "entered": 0,
        "missing": 0,
        "complete": False,
        "last_entered_at": None,
        "missing_items": [],
    }


async def test_resume_compteurs(client, db, auth_headers, products):
    station = await make_station(db)
    depot = await make_depot(db)
    super_, gasoil = products["SUPER"], products["GASOIL"]
    await make_order(db, station, super_)
    await make_order(db, station, super_, priority=OrderPriority.URGENT)
    await make_order(db, station, gasoil, status=OrderStatus.CONFIRMED, priority=OrderPriority.URGENT)
    await make_order(db, station, gasoil, status=OrderStatus.CONFIRMED)
    await make_order(db, station, gasoil, status=OrderStatus.DELIVERED, priority=OrderPriority.URGENT)
    await make_order(db, station, gasoil, status=OrderStatus.CANCELLED)
    await make_order(db, station, gasoil, day=date(2027, 1, 13))

    t1 = await make_truck(db, "LT-001-AA")
    t2 = await make_truck(db, "LT-002-BB")
    await make_truck(db, "LT-003-CC", status=TruckStatus.BROKEN)
    await make_driver(db, "Jean Mbarga", default_truck=t1)
    await make_driver(db, "Paul Essomba")
    await make_driver(db, "Luc Expiré", license_expiry=date(2026, 1, 1))
    await make_driver(db, "Marc En repos", status=DriverStatus.REST)
    t2_id, depot_id = str(t2.id), str(depot.id)
    super_id, gasoil_id = str(super_.id), str(gasoil.id)

    marked = await client.put(
        "/availability/trucks",
        params=PARAMS,
        json={"items": [{"truck_id": t2_id, "available": False, "reason": "Révision"}]},
        headers=await auth_headers("dispatcher"),
    )
    assert marked.status_code == 200
    for value in (100000, 90000):
        saved = await client.put(
            "/availability/depot-stocks",
            params=PARAMS,
            json={"items": [{"depot_id": depot_id, "product_id": super_id, "available_l": value}]},
            headers=await auth_headers("supply"),
        )
        assert saved.status_code == 200

    for role in ("dispatcher", "fleet", "supply", "manager", "admin"):
        response = await client.get(URL, params=PARAMS, headers=await auth_headers(role))
        assert response.status_code == 200, response.text
    body = response.json()

    assert body["orders"]["total"] == 6
    assert body["orders"]["by_status"] == {
        "draft": 2,
        "confirmed": 2,
        "planned": 0,
        "loaded": 0,
        "delivered": 1,
        "cancelled": 1,
        "postponed": 0,
    }
    assert body["orders"]["urgent_pending"] == 2
    assert body["trucks"] == {"total": 3, "assignable": 1, "blocked": 2}
    assert body["drivers"] == {
        "total": 4,
        "assignable": 2,
        "blocked": 2,
        "blocked_rm03": 1,
        "assignable_without_truck": 1,
    }
    stocks = body["depot_stocks"]
    assert (stocks["expected"], stocks["entered"], stocks["missing"], stocks["complete"]) == (3, 1, 2, False)
    assert stocks["last_entered_at"].endswith("Z")
    assert {(m["depot_code"], m["product_code"]) for m in stocks["missing_items"]} == {
        ("SCDP-DLA", "GASOIL"),
        ("SCDP-DLA", "PETROLE"),
    }

    saved = await client.put(
        "/availability/depot-stocks",
        params=PARAMS,
        json={
            "items": [
                {"depot_id": depot_id, "product_id": gasoil_id, "available_l": 0},
                {"depot_id": depot_id, "product_id": str(products["PETROLE"].id), "available_l": 40000},
            ]
        },
        headers=await auth_headers("supply"),
    )
    assert saved.status_code == 200
    stocks = (await client.get(URL, params=PARAMS, headers=await auth_headers("manager"))).json()[
        "depot_stocks"
    ]
    assert (stocks["entered"], stocks["missing"], stocks["complete"]) == (3, 0, True)  # 0 L = renseigné

    assert (await client.get(URL, params=PARAMS)).status_code == 401
    assert (await client.get(URL, headers=await auth_headers("manager"))).status_code == 422
