"""Chauffeurs du jour (F2.3, RM-03) et affectation chauffeur ↔ camion (F2.4)."""

import uuid
from datetime import date, timedelta

from app.availability import service
from app.core.enums import DriverStatus, TruckStatus
from tests.integration.orders.factories import DAY, make_driver, make_truck

URL = "/availability/drivers"
PARAMS = {"day": DAY.isoformat()}


async def _put(client, headers, *items, day=DAY):
    return await client.put(
        URL, params={"day": day.isoformat()}, json={"items": list(items)}, headers=headers
    )


async def _rows(client, headers, **params) -> dict[str, dict]:
    response = await client.get(URL, params={**PARAMS, **params}, headers=headers)
    assert response.status_code == 200, response.text
    return {row["full_name"]: row for row in response.json()["items"]}


async def test_RM_03_permis_ou_habilitation_expires_chauffeur_non_affectable(client, db, auth_headers):
    await make_driver(db, "A Valide")
    await make_driver(db, "B Permis expiré", license_expiry=DAY - timedelta(days=1))
    await make_driver(db, "C Habilitation expirée", hazmat_expiry=date(2026, 12, 31))
    await make_driver(db, "D Sans habilitation", hazmat_cert=False, hazmat_expiry=None)
    await make_driver(db, "E Expire le jour J", license_expiry=DAY, hazmat_expiry=DAY)
    await make_driver(db, "F Dates non renseignées", license_expiry=None, hazmat_expiry=None)
    await make_driver(db, "G En congé", status=DriverStatus.LEAVE)

    rows = await _rows(client, await auth_headers("manager"))
    assert list(rows) == sorted(rows)
    assert len(rows) == 7

    assert rows["A Valide"]["assignable"] is True
    assert rows["A Valide"]["block_reason"] is None and rows["A Valide"]["rule_code"] is None
    assert rows["E Expire le jour J"]["assignable"] is True  # valable jusqu'au jour J inclus
    assert rows["F Dates non renseignées"]["assignable"] is True  # décision provisoire S8

    expected = {
        "B Permis expiré": "Permis de conduire expiré depuis le 11/01/2027.",
        "C Habilitation expirée": "Habilitation matières dangereuses expirée depuis le 31/12/2026.",
        "D Sans habilitation": "Habilitation matières dangereuses absente.",
    }
    for name, message in expected.items():
        assert rows[name]["assignable"] is False
        assert rows[name]["block_reason"] == message
        assert rows[name]["rule_code"] == "RM-03"

    # Statut du référentiel : non affectable, mais ce n'est pas RM-03.
    assert rows["G En congé"]["assignable"] is False
    assert rows["G En congé"]["rule_code"] is None
    assert "congé" in rows["G En congé"]["block_reason"]

    ok = await _rows(client, await auth_headers("manager"), assignable="true")
    assert list(ok) == ["A Valide", "E Expire le jour J", "F Dates non renseignées"]
    # Le contrôle dépend de la date : la veille de l'expiration, B est affectable.
    earlier = await client.get(URL, params={"day": "2027-01-11"}, headers=await auth_headers("manager"))
    by_name = {row["full_name"]: row for row in earlier.json()["items"]}
    assert by_name["B Permis expiré"]["assignable"] is True


async def test_F2_3_marquer_puis_demarquer_un_chauffeur(client, db, auth_headers):
    driver = await make_driver(db, "Jean Mbarga")
    expired = await make_driver(db, "Paul Expiré", license_expiry=date(2026, 1, 1))
    driver_id, expired_id = str(driver.id), str(expired.id)
    headers = await auth_headers()

    marked = await _put(client, headers, {"driver_id": driver_id, "available": False, "reason": "Malade"})
    assert marked.status_code == 200, marked.text
    row = marked.json()[0]
    assert (row["available_today"], row["day_reason"], row["assignable"]) == (False, "Malade", False)
    assert row["block_reason"] == "Chauffeur marqué indisponible pour la journée."
    assert row["rule_code"] is None

    cleared = await _put(client, headers, {"driver_id": driver_id, "available": True})
    assert cleared.json()[0]["assignable"] is True
    assert cleared.json()[0]["day_reason"] is None

    # Démarquer un chauffeur au permis expiré ne le rend pas affectable (RM-03 reste bloquant).
    still = await _put(client, headers, {"driver_id": expired_id, "available": True})
    assert still.status_code == 200
    assert still.json()[0]["assignable"] is False
    assert still.json()[0]["rule_code"] == "RM-03"


async def test_F2_4_camion_habituel_par_defaut_puis_affectation_du_jour(client, db, auth_headers):
    t1 = await make_truck(db, "LT-001-AA")
    t2 = await make_truck(db, "LT-002-BB")
    jean = await make_driver(db, "Jean Mbarga", default_truck=t1)
    paul = await make_driver(db, "Paul Essomba")
    t1_id, t2_id, jean_id, paul_id = t1.id, t2.id, jean.id, paul.id
    headers = await auth_headers()

    rows = await _rows(client, headers)
    assert rows["Jean Mbarga"]["truck_plate"] == "LT-001-AA"
    assert rows["Jean Mbarga"]["default_truck_plate"] == "LT-001-AA"
    assert rows["Jean Mbarga"]["assignment_source"] == "default"
    assert rows["Paul Essomba"]["truck_id"] is None
    assert rows["Paul Essomba"]["assignment_source"] is None

    # Modifiable : Jean prend le camion 2 pour la journée.
    changed = await _put(client, headers, {"driver_id": str(jean_id), "truck_id": str(t2_id)})
    assert changed.status_code == 200, changed.text
    row = changed.json()[0]
    assert (row["truck_plate"], row["assignment_source"]) == ("LT-002-BB", "daily")
    assert row["default_truck_plate"] == "LT-001-AA"

    # Paul reprend le camion habituel de Jean, désormais libre.
    taken = await _put(client, headers, {"driver_id": str(paul_id), "truck_id": str(t1_id)})
    assert taken.status_code == 200, taken.text
    assert (await service.load_day_resources(db, DAY)).assignments == {jean_id: t2_id, paul_id: t1_id}

    trucks = await client.get("/availability/trucks", params=PARAMS, headers=headers)
    assert {r["plate"]: r["driver_name"] for r in trucks.json()["items"]} == {
        "LT-001-AA": "Paul Essomba",
        "LT-002-BB": "Jean Mbarga",
    }
    # L'affectation du jour ne vaut que pour J.
    tomorrow = await client.get(URL, params={"day": "2027-01-13"}, headers=headers)
    by_name = {r["full_name"]: r for r in tomorrow.json()["items"]}
    assert by_name["Jean Mbarga"]["truck_plate"] == "LT-001-AA"
    assert by_name["Paul Essomba"]["truck_id"] is None

    # `truck_id: null` : retour au camion habituel — encore pris par Paul pour la journée.
    reset = await _put(client, headers, {"driver_id": str(jean_id), "truck_id": None})
    assert reset.status_code == 200
    assert reset.json()[0]["truck_id"] is None
    await _put(client, headers, {"driver_id": str(paul_id), "truck_id": None})
    rows = await _rows(client, headers)
    assert (rows["Jean Mbarga"]["truck_plate"], rows["Jean Mbarga"]["assignment_source"]) == (
        "LT-001-AA",
        "default",
    )
    assert rows["Paul Essomba"]["truck_id"] is None


async def test_F2_4_conflit_camion_deja_affecte_409(client, db, auth_headers):
    t1 = await make_truck(db, "LT-001-AA")
    jean = await make_driver(db, "Jean Mbarga")
    paul = await make_driver(db, "Paul Essomba")
    t1_id, jean_id, paul_id = str(t1.id), str(jean.id), str(paul.id)
    headers = await auth_headers()

    assert (await _put(client, headers, {"driver_id": jean_id, "truck_id": t1_id})).status_code == 200

    conflict = await _put(client, headers, {"driver_id": paul_id, "truck_id": t1_id})
    assert conflict.status_code == 409, conflict.text
    body = conflict.json()
    assert body["code"] == "truck_already_assigned"
    assert body["message"] == "Le camion LT-001-AA est déjà affecté à Jean Mbarga pour cette journée."
    assert body["details"][0]["driver_id"] == jean_id

    # Rien n'a changé ; le même camion reste libre un autre jour.
    rows = await _rows(client, headers)
    assert rows["Jean Mbarga"]["truck_plate"] == "LT-001-AA"
    assert rows["Paul Essomba"]["truck_id"] is None
    other_day = await _put(client, headers, {"driver_id": paul_id, "truck_id": t1_id}, day=date(2027, 1, 13))
    assert other_day.status_code == 200

    # Deux chauffeurs sur le même camion dans une même saisie : conflit aussi, rien n'est enregistré.
    t2 = await make_truck(db, "LT-002-BB")
    t2_id = str(t2.id)
    both = await _put(
        client, headers, {"driver_id": jean_id, "truck_id": t2_id}, {"driver_id": paul_id, "truck_id": t2_id}
    )
    assert both.status_code == 409
    assert (await _rows(client, headers))["Jean Mbarga"]["truck_plate"] == "LT-001-AA"


async def test_F2_4_echange_de_camions_dans_une_meme_saisie(client, db, auth_headers):
    t1 = await make_truck(db, "LT-001-AA")
    t2 = await make_truck(db, "LT-002-BB")
    jean = await make_driver(db, "Jean Mbarga")
    paul = await make_driver(db, "Paul Essomba")
    t1_id, t2_id, jean_id, paul_id = str(t1.id), str(t2.id), str(jean.id), str(paul.id)
    headers = await auth_headers()

    first = await _put(
        client, headers, {"driver_id": jean_id, "truck_id": t1_id}, {"driver_id": paul_id, "truck_id": t2_id}
    )
    assert first.status_code == 200, first.text
    swapped = await _put(
        client, headers, {"driver_id": jean_id, "truck_id": t2_id}, {"driver_id": paul_id, "truck_id": t1_id}
    )
    assert swapped.status_code == 200, swapped.text
    assert [r["truck_plate"] for r in swapped.json()] == ["LT-002-BB", "LT-001-AA"]


async def test_F2_4_camion_habituel_partage_un_seul_chauffeur_par_camion(client, db, auth_headers):
    truck = await make_truck(db, "LT-001-AA")
    await make_driver(db, "Abel En congé", status=DriverStatus.LEAVE, default_truck=truck)
    await make_driver(db, "Zoé Disponible", default_truck=truck)
    rows = await _rows(client, await auth_headers("supply"))
    # Le chauffeur affectable est servi d'abord ; l'autre n'a pas de camion ce jour-là.
    assert rows["Zoé Disponible"]["truck_plate"] == "LT-001-AA"
    assert rows["Abel En congé"]["truck_id"] is None
    assert rows["Abel En congé"]["default_truck_plate"] == "LT-001-AA"


async def test_RM_03_RM_04_affectation_refusee_si_ressource_non_affectable(client, db, auth_headers):
    ok_truck = await make_truck(db, "LT-001-AA")
    broken = await make_truck(db, "LT-002-BB", status=TruckStatus.BROKEN)
    marked = await make_truck(db, "LT-003-CC")
    expired = await make_driver(db, "Paul Expiré", hazmat_expiry=date(2026, 6, 30))
    valid = await make_driver(db, "Jean Mbarga")
    ok_id, broken_id, marked_id = str(ok_truck.id), str(broken.id), str(marked.id)
    expired_id, valid_id = str(expired.id), str(valid.id)
    headers = await auth_headers()
    mark = await client.put(
        "/availability/trucks",
        params=PARAMS,
        json={"items": [{"truck_id": marked_id, "available": False, "reason": "Révision"}]},
        headers=headers,
    )
    assert mark.status_code == 200

    refused = await _put(client, headers, {"driver_id": expired_id, "truck_id": ok_id})
    assert refused.status_code == 409, refused.text
    body = refused.json()
    assert body["code"] == "rule_violation"
    assert body["details"][0]["rule_code"] == "RM-03"
    assert "Habilitation matières dangereuses expirée depuis le 30/06/2026." in body["message"]

    for truck_id, message in (
        (broken_id, "Camion en panne."),
        (marked_id, "Camion marqué indisponible pour la journée."),
    ):
        refused = await _put(client, headers, {"driver_id": valid_id, "truck_id": truck_id})
        assert refused.status_code == 409, refused.text
        assert refused.json()["details"][0] == {
            "rule_code": "RM-04",
            "message": message,
            "truck_id": truck_id,
        }

    assert (await _rows(client, headers))["Jean Mbarga"]["truck_id"] is None
    assert (await _put(client, headers, {"driver_id": valid_id, "truck_id": ok_id})).status_code == 200


async def test_chauffeurs_roles_et_saisies_invalides(client, db, auth_headers):
    driver = await make_driver(db)
    driver_id = str(driver.id)
    item = {"driver_id": driver_id, "available": False, "reason": "Repos"}
    for role in ("fleet", "supply", "manager"):
        headers = await auth_headers(role)
        assert (await _put(client, headers, item)).status_code == 403
        assert (await client.get(URL, params=PARAMS, headers=headers)).status_code == 200
    assert (await client.get(URL, params=PARAMS)).status_code == 401

    headers = await auth_headers("admin")
    missing = await _put(client, headers, {"driver_id": str(uuid.uuid4()), "available": False})
    assert (missing.status_code, missing.json()["message"]) == (404, "Chauffeur introuvable.")
    missing = await _put(client, headers, {"driver_id": driver_id, "truck_id": str(uuid.uuid4())})
    assert (missing.status_code, missing.json()["message"]) == (404, "Camion introuvable.")
    assert (await _put(client, headers, item, item)).status_code == 422
    assert (await client.get(URL, headers=headers)).status_code == 422
    assert (await _put(client, headers, item)).status_code == 200
