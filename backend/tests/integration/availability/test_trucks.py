"""Camions du jour (F2.2, RM-04)."""

import uuid

from app.core.enums import TruckStatus
from tests.integration.orders.factories import DAY, make_carrier, make_driver, make_truck

URL = "/availability/trucks"
PARAMS = {"day": DAY.isoformat()}


async def test_RM_04_camions_du_jour_statut_du_referentiel(client, db, auth_headers):
    carrier = await make_carrier(db)
    ok = await make_truck(db, "LT-001-AA", carrier=carrier)
    await make_truck(db, "LT-002-BB", status=TruckStatus.MAINTENANCE)
    await make_truck(db, "LT-003-CC", status=TruckStatus.BROKEN)
    await make_truck(db, "LT-004-DD", status=TruckStatus.RESERVED)
    await make_driver(db, "Jean Mbarga", default_truck=ok)

    response = await client.get(URL, params=PARAMS, headers=await auth_headers("fleet"))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == 4
    rows = {row["plate"]: row for row in body["items"]}
    assert list(rows) == ["LT-001-AA", "LT-002-BB", "LT-003-CC", "LT-004-DD"]

    first = rows["LT-001-AA"]
    assert first["assignable"] is True
    assert first["block_reason"] is None and first["rule_code"] is None
    assert first["carrier_name"] == "Transports du Wouri"
    assert first["total_capacity_l"] == 30000.0
    assert (first["driver_name"], first["assignment_source"]) == ("Jean Mbarga", "default")

    assert rows["LT-002-BB"]["block_reason"] == "Camion en maintenance."
    assert rows["LT-003-CC"]["block_reason"] == "Camion en panne."
    assert rows["LT-004-DD"]["block_reason"] == "Camion réservé."
    for plate in ("LT-002-BB", "LT-003-CC", "LT-004-DD"):
        assert rows[plate]["assignable"] is False
        assert rows[plate]["rule_code"] == "RM-04"
        assert rows[plate]["available_today"] is True  # pas de marquage du jour

    headers = await auth_headers("fleet")
    only_ok = (await client.get(URL, params={**PARAMS, "assignable": "true"}, headers=headers)).json()
    assert [row["plate"] for row in only_ok["items"]] == ["LT-001-AA"]
    blocked = (
        await client.get(URL, params={**PARAMS, "assignable": "false", "limit": 2}, headers=headers)
    ).json()
    assert (blocked["total"], len(blocked["items"])) == (3, 2)


async def test_RM_04_marquer_puis_demarquer_un_camion_pour_la_journee(client, db, auth_headers):
    truck = await make_truck(db, "LT-001-AA")
    await make_truck(db, "LT-002-BB")
    headers = await auth_headers("dispatcher")
    truck_id = str(truck.id)

    marked = await client.put(
        URL,
        params=PARAMS,
        json={"items": [{"truck_id": truck_id, "available": False, "reason": "Contrôle technique"}]},
        headers=headers,
    )
    assert marked.status_code == 200, marked.text
    row = marked.json()[0]
    assert row["available_today"] is False
    assert row["day_reason"] == "Contrôle technique"
    assert row["assignable"] is False
    assert row["block_reason"] == "Camion marqué indisponible pour la journée."
    assert row["rule_code"] == "RM-04"

    # Nouveau motif : la ligne du jour est mise à jour, pas dupliquée.
    updated = await client.put(
        URL, params=PARAMS, json={"items": [{"truck_id": truck_id, "available": False}]}, headers=headers
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()[0]["day_reason"] is None
    assert updated.json()[0]["assignable"] is False

    listing = (await client.get(URL, params=PARAMS, headers=headers)).json()["items"]
    assert [r["assignable"] for r in listing] == [False, True]
    # Le marquage ne vaut que pour le jour J.
    tomorrow = (await client.get(URL, params={"day": "2027-01-13"}, headers=headers)).json()["items"]
    assert all(r["assignable"] for r in tomorrow)

    cleared = await client.put(
        URL, params=PARAMS, json={"items": [{"truck_id": truck_id, "available": True}]}, headers=headers
    )
    assert cleared.status_code == 200
    assert cleared.json()[0]["assignable"] is True
    assert cleared.json()[0]["available_today"] is True
    # Démarquer un camion non marqué est sans effet.
    again = await client.put(
        URL, params=PARAMS, json={"items": [{"truck_id": truck_id, "available": True}]}, headers=headers
    )
    assert again.status_code == 200


async def test_RM_04_demarquer_ne_rend_pas_affectable_un_camion_en_panne(client, db, auth_headers):
    truck = await make_truck(db, status=TruckStatus.BROKEN)
    response = await client.put(
        URL,
        params=PARAMS,
        json={"items": [{"truck_id": str(truck.id), "available": True}]},
        headers=await auth_headers(),
    )
    assert response.status_code == 200
    assert response.json()[0]["assignable"] is False
    assert response.json()[0]["block_reason"] == "Camion en panne."


async def test_camions_roles_et_saisies_invalides(client, db, auth_headers):
    truck = await make_truck(db)
    truck_id = str(truck.id)
    body = {"items": [{"truck_id": truck_id, "available": False, "reason": "x"}]}
    for role in ("fleet", "supply", "manager"):
        headers = await auth_headers(role)
        assert (await client.put(URL, params=PARAMS, json=body, headers=headers)).status_code == 403
        assert (await client.get(URL, params=PARAMS, headers=headers)).status_code == 200
    assert (await client.get(URL, params=PARAMS)).status_code == 401

    headers = await auth_headers("admin")
    unknown = {"items": [{"truck_id": str(uuid.uuid4()), "available": False}]}
    missing = await client.put(URL, params=PARAMS, json=unknown, headers=headers)
    assert (missing.status_code, missing.json()["message"]) == (404, "Camion introuvable.")
    twice = {"items": body["items"] * 2}
    assert (await client.put(URL, params=PARAMS, json=twice, headers=headers)).status_code == 422
    assert (await client.put(URL, json=body, headers=headers)).status_code == 422
    assert (await client.put(URL, params=PARAMS, json=body, headers=headers)).status_code == 200
