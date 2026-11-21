"""Référentiels F1.4 (transporteurs, camions, compartiments) et F1.5 (chauffeurs)."""

import pytest_asyncio


@pytest_asyncio.fixture
async def admin(auth_headers):
    return await auth_headers("admin")


async def make_carrier(client, admin, name="Transcam", type_="third_party"):
    response = await client.post("/carriers", json={"name": name, "type": type_}, headers=admin)
    assert response.status_code == 201, response.text
    return response.json()


def truck_payload(products, carrier_id=None, **overrides):
    payload = {
        "plate": "lt 123 ab",
        "carrier_id": carrier_id,
        "size": "large",
        "total_capacity_l": 33000,
        "avg_speed_kmh": 45.5,
        "cost_per_km": 650,
        "compartments": [
            {"position": 2, "capacity_l": 11000, "allowed_product_ids": [str(products["GASOIL"].id)]},
            {"position": 1, "capacity_l": 11000},
            {"position": 3, "capacity_l": 11000, "allowed_product_ids": None},
        ],
    }
    payload.update(overrides)
    return payload


async def test_transporteur_crud(client, admin, auth_headers):
    carrier = await make_carrier(client, admin, "OLA Flotte", "own")
    assert carrier["type"] == "own"
    duplicate = await client.post("/carriers", json={"name": "ola flotte"}, headers=admin)
    assert duplicate.status_code == 409
    assert "déjà utilisé" in duplicate.json()["message"]

    updated = await client.put(f"/carriers/{carrier['id']}", json={"contact": "M. Essomba"}, headers=admin)
    assert updated.json()["contact"] == "M. Essomba" and updated.json()["name"] == "OLA Flotte"

    await make_carrier(client, admin)
    reader = await auth_headers("dispatcher")
    assert (await client.get("/carriers", headers=reader)).json()["total"] == 2
    assert [
        c["name"]
        for c in (await client.get("/carriers", params={"type": "own"}, headers=reader)).json()["items"]
    ] == ["OLA Flotte"]
    assert (await client.post("/carriers", json={"name": "X"}, headers=reader)).status_code == 403

    assert (await client.delete(f"/carriers/{carrier['id']}", headers=admin)).status_code == 204
    assert (await client.get(f"/carriers/{carrier['id']}", headers=admin)).status_code == 404


async def test_transporteur_avec_camions_non_supprimable(client, admin, products):
    carrier = await make_carrier(client, admin)
    truck = (await client.post("/trucks", json=truck_payload(products, carrier["id"]), headers=admin)).json()
    refused = await client.delete(f"/carriers/{carrier['id']}", headers=admin)
    assert refused.status_code == 409 and refused.json()["code"] == "in_use"
    await client.delete(f"/trucks/{truck['id']}", headers=admin)
    assert (await client.delete(f"/carriers/{carrier['id']}", headers=admin)).status_code == 204


async def test_camion_crud_avec_compartiments(client, admin, auth_headers, products):
    carrier = await make_carrier(client, admin)
    created = await client.post("/trucks", json=truck_payload(products, carrier["id"]), headers=admin)
    assert created.status_code == 201, created.text
    truck = created.json()
    assert truck["plate"] == "LT 123 AB"
    assert truck["carrier_name"] == "Transcam" and truck["carrier_type"] == "third_party"
    assert truck["status"] == "available" and truck["total_capacity_l"] == 33000
    assert [c["position"] for c in truck["compartments"]] == [1, 2, 3]
    assert truck["compartments"][0]["allowed_product_ids"] is None
    assert truck["compartments"][0]["allowed_product_codes"] is None
    assert truck["compartments"][1]["allowed_product_codes"] == ["GASOIL"]

    read = await client.get(f"/trucks/{truck['id']}", headers=await auth_headers("fleet"))
    assert read.status_code == 200 and len(read.json()["compartments"]) == 3

    updated = await client.put(
        f"/trucks/{truck['id']}", json={"status": "maintenance", "notes": "Révision"}, headers=admin
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["status"] == "maintenance" and len(updated.json()["compartments"]) == 3

    # Remplacement de la liste des compartiments.
    replaced = await client.put(
        f"/trucks/{truck['id']}",
        json={"compartments": [{"position": 1, "capacity_l": 16000}, {"position": 4, "capacity_l": 17000}]},
        headers=admin,
    )
    assert replaced.status_code == 200, replaced.text
    assert [(c["position"], c["capacity_l"]) for c in replaced.json()["compartments"]] == [
        (1, 16000),
        (4, 17000),
    ]

    assert (await client.delete(f"/trucks/{truck['id']}", headers=admin)).status_code == 204
    assert (await client.get(f"/trucks/{truck['id']}", headers=admin)).status_code == 404


async def test_camion_capacite_totale_deduite_des_compartiments(client, admin, products):
    payload = truck_payload(products, total_capacity_l=None)
    created = await client.post("/trucks", json=payload, headers=admin)
    assert created.status_code == 201, created.text
    assert created.json()["total_capacity_l"] == 33000

    neither = await client.post(
        "/trucks",
        json=truck_payload(products, plate="LT 2", total_capacity_l=None, compartments=[]),
        headers=admin,
    )
    assert neither.status_code == 422


async def test_camion_validation(client, admin, products):
    assert (await client.post("/trucks", json=truck_payload(products), headers=admin)).status_code == 201

    duplicate = await client.post("/trucks", json=truck_payload(products, plate="LT 123 AB"), headers=admin)
    assert duplicate.status_code == 409
    assert "immatriculation" in duplicate.json()["message"].lower()

    # Somme des compartiments (33 000 L) supérieure à la capacité totale déclarée.
    incoherent = await client.post(
        "/trucks", json=truck_payload(products, plate="LT 2", total_capacity_l=30000), headers=admin
    )
    assert incoherent.status_code == 422
    assert "dépasse" in incoherent.json()["message"]

    unknown_product = truck_payload(
        products,
        plate="LT 2",
        compartments=[
            {
                "position": 1,
                "capacity_l": 100,
                "allowed_product_ids": ["00000000-0000-7000-8000-000000000000"],
            }
        ],
    )
    assert (await client.post("/trucks", json=unknown_product, headers=admin)).status_code == 422

    empty_list = truck_payload(
        products, plate="LT 2", compartments=[{"position": 1, "capacity_l": 100, "allowed_product_ids": []}]
    )
    assert (await client.post("/trucks", json=empty_list, headers=admin)).status_code == 422

    same_position = truck_payload(
        products, plate="LT 2", compartments=[{"position": 1, "capacity_l": 100}] * 2
    )
    assert (await client.post("/trucks", json=same_position, headers=admin)).status_code == 409

    assert (
        await client.post("/trucks", json=truck_payload(products, plate="LT 2", size="xl"), headers=admin)
    ).status_code == 422
    unknown_carrier = truck_payload(products, "00000000-0000-7000-8000-000000000000", plate="LT 2")
    assert (await client.post("/trucks", json=unknown_carrier, headers=admin)).status_code == 404


async def test_camion_filtres(client, admin, auth_headers, products):
    carrier = await make_carrier(client, admin)
    await client.post("/trucks", json=truck_payload(products, carrier["id"]), headers=admin)
    await client.post(
        "/trucks",
        json=truck_payload(
            products,
            plate="CE 999 ZZ",
            size="small",
            total_capacity_l=12000,
            status="broken",
            compartments=[],
        ),
        headers=admin,
    )
    reader = await auth_headers("supply")

    async def plates(**params):
        response = await client.get("/trucks", params=params, headers=reader)
        assert response.status_code == 200, response.text
        return [t["plate"] for t in response.json()["items"]]

    assert await plates() == ["CE 999 ZZ", "LT 123 AB"]
    assert await plates(carrier_id=carrier["id"]) == ["LT 123 AB"]
    assert await plates(status="broken") == ["CE 999 ZZ"]
    assert await plates(size="large") == ["LT 123 AB"]
    assert await plates(q="999") == ["CE 999 ZZ"]


async def test_compartiments_sous_ressource_crud(client, admin, auth_headers, products):
    truck = (
        await client.post(
            "/trucks", json=truck_payload(products, total_capacity_l=30000, compartments=[]), headers=admin
        )
    ).json()
    base = f"/trucks/{truck['id']}/compartments"

    first = await client.post(base, json={"position": 1, "capacity_l": 15000}, headers=admin)
    assert first.status_code == 201, first.text
    compartment = first.json()
    assert compartment["allowed_product_ids"] is None and compartment["truck_id"] == truck["id"]

    assert (
        await client.post(base, json={"position": 1, "capacity_l": 100}, headers=admin)
    ).status_code == 409
    # 15 000 + 16 000 > 30 000 : incohérent avec la capacité totale.
    assert (
        await client.post(base, json={"position": 2, "capacity_l": 16000}, headers=admin)
    ).status_code == 422
    second = (
        await client.post(
            base,
            json={"position": 2, "capacity_l": 15000, "allowed_product_ids": [str(products["SUPER"].id)]},
            headers=admin,
        )
    ).json()
    assert second["allowed_product_codes"] == ["SUPER"]

    assert (
        await client.put(f"{base}/{second['id']}", json={"capacity_l": 15001}, headers=admin)
    ).status_code == 422
    assert (
        await client.put(f"{base}/{second['id']}", json={"position": 1}, headers=admin)
    ).status_code == 409
    opened = await client.put(
        f"{base}/{second['id']}", json={"allowed_product_ids": None, "capacity_l": 14000}, headers=admin
    )
    assert opened.status_code == 200, opened.text
    assert opened.json()["allowed_product_ids"] is None and opened.json()["capacity_l"] == 14000
    # La capacité totale du camion ne peut pas passer sous la somme des compartiments.
    assert (
        await client.put(f"/trucks/{truck['id']}", json={"total_capacity_l": 20000}, headers=admin)
    ).status_code == 422

    reader = await auth_headers("dispatcher")
    listing = await client.get(base, headers=reader)
    assert [c["position"] for c in listing.json()["items"]] == [1, 2] and listing.json()["total"] == 2
    assert (await client.get(f"{base}/{compartment['id']}", headers=reader)).status_code == 200
    assert (await client.post(base, json={"position": 3, "capacity_l": 1}, headers=reader)).status_code == 403
    assert (await client.delete(f"{base}/{compartment['id']}", headers=reader)).status_code == 403

    assert (await client.delete(f"{base}/{compartment['id']}", headers=admin)).status_code == 204
    assert (await client.get(base, headers=admin)).json()["total"] == 1


async def test_chauffeur_crud_et_libelles(client, admin, auth_headers, products):
    carrier = await make_carrier(client, admin)
    truck = (await client.post("/trucks", json=truck_payload(products, carrier["id"]), headers=admin)).json()
    created = await client.post(
        "/drivers",
        json={
            "full_name": "Jean Mbarga",
            "phone": "+237 6 77 00 00 01",
            "license_no": "CM-2020-0001",
            "license_expiry": "2028-06-30",
            "hazmat_cert": True,
            "hazmat_expiry": "2027-12-31",
            "carrier_id": carrier["id"],
            "default_truck_id": truck["id"],
        },
        headers=admin,
    )
    assert created.status_code == 201, created.text
    driver = created.json()
    assert driver["carrier_name"] == "Transcam"
    assert driver["default_truck_plate"] == "LT 123 AB"
    assert driver["status"] == "available" and driver["license_expiry"] == "2028-06-30"

    duplicate = await client.post(
        "/drivers", json={"full_name": "Autre", "license_no": "cm-2020-0001"}, headers=admin
    )
    assert duplicate.status_code == 409
    assert "permis" in duplicate.json()["message"]

    other = await client.post(
        "/drivers", json={"full_name": "Paul Atangana", "status": "leave"}, headers=admin
    )
    assert other.status_code == 201, other.text
    assert other.json()["carrier_name"] is None and other.json()["hazmat_cert"] is False

    updated = await client.put(
        f"/drivers/{driver['id']}", json={"status": "sick", "default_truck_id": None}, headers=admin
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["status"] == "sick" and updated.json()["default_truck_plate"] is None
    assert updated.json()["full_name"] == "Jean Mbarga"

    reader = await auth_headers("manager")

    async def names(**params):
        response = await client.get("/drivers", params=params, headers=reader)
        assert response.status_code == 200, response.text
        return [d["full_name"] for d in response.json()["items"]]

    assert await names() == ["Jean Mbarga", "Paul Atangana"]
    assert await names(status="leave") == ["Paul Atangana"]
    assert await names(carrier_id=carrier["id"]) == ["Jean Mbarga"]
    assert await names(q="atang") == ["Paul Atangana"]
    assert (await client.post("/drivers", json={"full_name": "X"}, headers=reader)).status_code == 403

    bad_truck = await client.put(
        f"/drivers/{driver['id']}",
        json={"default_truck_id": "00000000-0000-7000-8000-000000000000"},
        headers=admin,
    )
    assert bad_truck.status_code == 404
    assert (
        await client.post("/drivers", json={"full_name": "Y", "license_expiry": "30/06/2028"}, headers=admin)
    ).status_code == 422

    assert (await client.delete(f"/drivers/{driver['id']}", headers=admin)).status_code == 204
    assert (await client.get(f"/drivers/{driver['id']}", headers=admin)).status_code == 404
    assert await names() == ["Paul Atangana"]
