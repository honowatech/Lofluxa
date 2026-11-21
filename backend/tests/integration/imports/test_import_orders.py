"""Import des commandes du jour (F3.2) : rôle dispatcher, commandes créées en brouillon."""

import uuid
from datetime import date, time

import pytest_asyncio
from sqlalchemy import select

from app.core.enums import OrderPriority, OrderSource, OrderStatus
from app.core.geo import point
from app.orders.models import Order
from app.referentials.models import Station, StationTank

from .helpers import apply, changes, csv_file, issues, preview, xlsx

HEADERS = [
    "Date",
    "Code station",
    "Produit",
    "Volume (L)",
    "Priorité",
    "Fenêtre début",
    "Fenêtre fin",
    "Commentaire",
]
DAY = date(2027, 1, 12)


@pytest_asyncio.fixture
async def stations(db, products):
    akwa = Station(code="ST-AKWA", name="OLA Akwa", location=point(4.05, 9.7))
    akwa.tanks = [
        StationTank(product_id=products["SUPER"].id, capacity_l=30000, safety_stock_l=3000),
        StationTank(product_id=products["GASOIL"].id, capacity_l=40000, safety_stock_l=4000),
    ]
    bonab = Station(code="ST-BONAB", name="OLA Bonabéri", location=point(4.07, 9.66), active=False)
    db.add_all([akwa, bonab])
    await db.commit()
    return {"ST-AKWA": akwa.id, "ST-BONAB": bonab.id}


def order_rows():
    return [
        [DAY, "ST-AKWA", "SUPER", 12000, "normale", time(8, 0), time(12, 0), None],
        ["12/01/2027", "st-akwa", "gasoil", "15000,5", "urgente", None, None, "Rupture annoncée"],
        [DAY, "ST-BONAB", "GASOIL", 20000, None, None, None, None],
    ]


async def orders_in_db(db) -> list[Order]:
    db.expire_all()
    return list((await db.execute(select(Order).order_by(Order.requested_l))).scalars())


async def test_import_commandes_cycle_complet(client, auth_headers, db, products, stations):
    dispatcher = await auth_headers("dispatcher")

    bad = order_rows()
    bad[0][1] = "ST-INCONNUE"
    bad[1][3] = "15.000"  # 15 ou 15 000 ? refusé
    bad[2][2] = "KEROSENE"
    bad.append([DAY, "ST-AKWA", "PETROLE", -5, None, None, None, None])
    bad.append([DAY, "ST-AKWA", "PETROLE", 3000, "prioritaire", "14:00", "10:00", None])
    bad.append([None, "ST-AKWA", "PETROLE", 3000, None, None, None, None])
    response = await preview(client, dispatcher, "orders", xlsx(HEADERS, bad))
    assert response.status_code == 201, response.text
    batch = response.json()
    assert batch["status"] == "rejected" and batch["row_count"] == 6
    assert set(issues(batch)) == {
        (2, "Code station"),
        (3, "Volume (L)"),
        (4, "Produit"),
        (5, "Volume (L)"),
        (6, "Priorité"),
        (6, "Fenêtre fin"),
        (7, "Date"),
    }
    ambiguous = next(i for i in batch["report"]["issues"] if i["row"] == 3)
    assert ambiguous["value"] == "15.000" and "ambigu" in ambiguous["message"]
    assert (await apply(client, dispatcher, batch)).status_code == 409
    assert await orders_in_db(db) == []

    # Fichier corrigé.
    response = await preview(client, dispatcher, "orders", xlsx(HEADERS, order_rows()), day="2027-01-12")
    batch = response.json()
    assert batch["status"] == "previewed", batch["report"]["issues"]
    assert batch["report"]["summary"] == {
        "created": 3,
        "updated": 0,
        "unchanged": 0,
        "errors": 0,
        "warnings": 2,
    }
    assert batch["report"]["options"] == {"day": "2027-01-12"}
    # Station inactive et sans cuve GASOIL : simples avertissements, la commande est importée.
    assert issues(batch, "warning") == [(4, "Code station"), (4, "Produit")]
    assert batch["report"]["items"][0]["label"] == "12/01/2027 — ST-AKWA — SUPER — 12000 L"
    assert await orders_in_db(db) == []

    applied = await apply(client, dispatcher, batch)
    assert applied.status_code == 200, applied.text
    assert applied.json()["report"]["applied"]["created"] == 3

    orders = await orders_in_db(db)
    assert [float(o.requested_l) for o in orders] == [12000, 15000.5, 20000]
    assert all(o.status == OrderStatus.DRAFT and o.source == OrderSource.IMPORT for o in orders)
    assert all(o.import_batch_id == uuid.UUID(batch["id"]) and o.day == DAY for o in orders)
    first, second, third = orders
    assert first.station_id == stations["ST-AKWA"] and first.product_id == products["SUPER"].id
    assert (first.window_start, first.window_end) == (time(8, 0), time(12, 0))
    assert first.priority == OrderPriority.NORMAL
    assert second.priority == OrderPriority.URGENT and second.comment == "Rupture annoncée"
    assert second.window_start is None
    assert third.station_id == stations["ST-BONAB"] and third.priority == OrderPriority.NORMAL

    assert (await apply(client, dispatcher, batch)).json()["code"] == "already_applied"
    assert len(await orders_in_db(db)) == 3


async def test_reimport_commandes_mises_a_jour_annoncees(client, auth_headers, db, products, stations):
    dispatcher = await auth_headers("dispatcher")
    batch = (await preview(client, dispatcher, "orders", xlsx(HEADERS, order_rows()))).json()
    assert (await apply(client, dispatcher, batch)).status_code == 200

    # Même fichier : aucun doublon créé.
    same = (await preview(client, dispatcher, "orders", xlsx(HEADERS, order_rows()))).json()
    assert same["report"]["summary"]["unchanged"] == 3 and same["report"]["summary"]["created"] == 0

    # La commande GASOIL d'Akwa est confirmée entre-temps.
    orders = await orders_in_db(db)
    orders[1].status = OrderStatus.CONFIRMED
    await db.commit()

    rows = [
        ["2027-01-12", "ST-AKWA", "SUPER", "14000", "urgente", "09:00", "", "Volume revu"],
        ["2027-01-12", "ST-AKWA", "GASOIL", "18000", "", "", "", ""],  # déjà confirmée : refus
        ["2027-01-12", "ST-AKWA", "PETROLE", "2000", "", "", "", ""],  # pas de cuve PETROLE : avertissement
    ]
    batch = (await preview(client, dispatcher, "orders", csv_file(HEADERS, rows), "commandes.csv")).json()
    assert batch["status"] == "rejected"
    assert issues(batch) == [(3, "Volume (L)")]
    assert "confirmée" in batch["report"]["issues"][0]["message"]

    rows[1][3] = "15000,5"  # identique à la commande confirmée : inchangée
    batch = (await preview(client, dispatcher, "orders", csv_file(HEADERS, rows), "commandes.csv")).json()
    assert batch["status"] == "previewed", batch["report"]["issues"]
    assert batch["report"]["summary"] == {
        "created": 1,
        "updated": 1,
        "unchanged": 1,
        "errors": 0,
        "warnings": 1,
    }
    assert "pas de cuve PETROLE" in next(i for i in batch["report"]["issues"])["message"]
    assert changes(batch["report"]["items"][0]) == {
        "requested_l": (12000, 14000),
        "priority": ("normal", "urgent"),
        "window_start": ("08:00", "09:00"),
        "comment": (None, "Volume revu"),
    }
    assert (await apply(client, dispatcher, batch)).status_code == 200

    orders = {float(o.requested_l): o for o in await orders_in_db(db)}
    assert set(orders) == {2000, 14000, 15000.5, 20000}
    updated = orders[14000]
    assert updated.priority == OrderPriority.URGENT and updated.comment == "Volume revu"
    assert (updated.window_start, updated.window_end) == (
        time(9, 0),
        time(12, 0),
    )  # fin non fournie : conservée
    assert updated.status == OrderStatus.DRAFT
    assert orders[15000.5].status == OrderStatus.CONFIRMED


async def test_import_commandes_journee_imposee_et_doublons(client, auth_headers, products, stations):
    dispatcher = await auth_headers("dispatcher")
    rows = [
        [None, "ST-AKWA", "SUPER", 12000, None, None, None, None],  # date vide : prend la journée demandée
        [date(2027, 1, 13), "ST-AKWA", "GASOIL", 5000, None, None, None, None],  # autre journée
        [DAY, "ST-AKWA", "SUPER", 3000, None, None, None, None],  # doublon de la ligne 2
    ]
    batch = (await preview(client, dispatcher, "orders", xlsx(HEADERS, rows), day="2027-01-12")).json()
    assert batch["status"] == "rejected"
    assert issues(batch) == [(3, "Date"), (4, "Code station")]
    assert "ligne 2" in batch["report"]["issues"][1]["message"]

    invalid = await preview(client, dispatcher, "orders", xlsx(HEADERS, rows), day="12/01/2027")
    assert invalid.status_code == 422
