"""Référentiel F1.3 : stations et cuves."""


def station_payload(products, **overrides):
    payload = {
        "code": "ST-AKWA",
        "name": "OLA Akwa",
        "region": "Littoral",
        "city": "Douala",
        "lat": 4.0511,
        "lon": 9.7085,
        "opening_hours": {"mon": [["06:00", "20:00"]]},
        "max_truck_size": "medium",
        "unload_time_min": 40,
        "contact_name": "M. Ndongo",
        "contact_phone": "+237 6 99 00 00 01",
        "contact_email": "akwa@example.cm",
        "tanks": [
            {"product_id": str(products["SUPER"].id), "capacity_l": 30000, "safety_stock_l": 3000},
            {"product_id": str(products["GASOIL"].id), "capacity_l": 40000.5},
        ],
    }
    payload.update(overrides)
    return payload


async def test_station_crud_avec_cuves(client, auth_headers, products):
    admin = await auth_headers("admin")
    created = await client.post("/stations", json=station_payload(products), headers=admin)
    assert created.status_code == 201, created.text
    station = created.json()
    assert station["code"] == "ST-AKWA"
    assert (station["lat"], station["lon"]) == (4.0511, 9.7085)
    assert [t["product_code"] for t in station["tanks"]] == ["GASOIL", "SUPER"]
    gasoil = station["tanks"][0]
    assert gasoil["capacity_l"] == 40000.5 and gasoil["safety_stock_l"] == 0
    assert gasoil["product_label"] == "Gasoil"

    # Lecture par un rôle non admin : la station renvoie ses cuves.
    read = await client.get(f"/stations/{station['id']}", headers=await auth_headers("dispatcher"))
    assert read.status_code == 200
    assert len(read.json()["tanks"]) == 2

    # Mise à jour partielle : les cuves ne bougent pas si `tanks` est absent.
    renamed = await client.put(f"/stations/{station['id']}", json={"name": "OLA Akwa Nord"}, headers=admin)
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "OLA Akwa Nord"
    assert len(renamed.json()["tanks"]) == 2

    # `tanks` fourni : remplace la liste (SUPER modifiée, GASOIL retirée, PETROLE ajoutée).
    replaced = await client.put(
        f"/stations/{station['id']}",
        json={
            "tanks": [
                {"product_id": str(products["SUPER"].id), "capacity_l": 35000, "safety_stock_l": 3500},
                {"product_id": str(products["PETROLE"].id), "capacity_l": 10000},
            ]
        },
        headers=admin,
    )
    assert replaced.status_code == 200, replaced.text
    assert {t["product_code"]: t["capacity_l"] for t in replaced.json()["tanks"]} == {
        "SUPER": 35000,
        "PETROLE": 10000,
    }

    assert (await client.delete(f"/stations/{station['id']}", headers=admin)).status_code == 204
    assert (await client.get(f"/stations/{station['id']}", headers=admin)).status_code == 404
    assert (await client.get(f"/stations/{station['id']}/tanks", headers=admin)).status_code == 404


async def test_station_filtres_et_recherche(client, auth_headers, products):
    admin = await auth_headers("admin")
    await client.post("/stations", json=station_payload(products), headers=admin)
    await client.post(
        "/stations",
        json=station_payload(
            products,
            code="ST-BAF",
            name="OLA Bafoussam",
            region="Ouest",
            city="Bafoussam",
            max_truck_size="large",
            active=False,
            tanks=[],
        ),
        headers=admin,
    )
    reader = await auth_headers("fleet")

    async def codes(**params):
        response = await client.get("/stations", params=params, headers=reader)
        assert response.status_code == 200, response.text
        return [s["code"] for s in response.json()["items"]]

    assert await codes() == ["ST-AKWA", "ST-BAF"]
    assert await codes(region="ouest") == ["ST-BAF"]
    assert await codes(city="Douala") == ["ST-AKWA"]
    assert await codes(active="false") == ["ST-BAF"]
    assert await codes(max_truck_size="medium") == ["ST-AKWA"]
    assert await codes(q="bafou") == ["ST-BAF"]
    assert await codes(product_id=str(products["SUPER"].id)) == ["ST-AKWA"]
    assert await codes(q="100%") == []


async def test_station_validation(client, auth_headers, products):
    admin = await auth_headers("admin")
    assert (await client.post("/stations", json=station_payload(products), headers=admin)).status_code == 201

    duplicate = await client.post("/stations", json=station_payload(products, name="Autre"), headers=admin)
    assert duplicate.status_code == 409
    assert "ST-AKWA" in duplicate.json()["message"]

    cases = [
        station_payload(products, code="S2", lon=200),
        station_payload(products, code="S2", max_truck_size="énorme"),
        station_payload(products, code="S2", opening_hours={"mon": [["8h", "18h"]]}),
        station_payload(products, code="S2", contact_email="pas-un-email"),
        station_payload(products, code="S 2"),
        # Produit inexistant
        station_payload(
            products,
            code="S2",
            tanks=[{"product_id": "00000000-0000-7000-8000-000000000000", "capacity_l": 1000}],
        ),
        # Stock de sécurité supérieur à la capacité
        station_payload(
            products,
            code="S2",
            tanks=[{"product_id": str(products["SUPER"].id), "capacity_l": 1000, "safety_stock_l": 2000}],
        ),
        # Capacité nulle
        station_payload(
            products, code="S2", tanks=[{"product_id": str(products["SUPER"].id), "capacity_l": 0}]
        ),
    ]
    for payload in cases:
        response = await client.post("/stations", json=payload, headers=admin)
        assert response.status_code == 422, (payload, response.text)
        assert response.json()["code"] == "validation_error"

    twice = station_payload(
        products,
        code="S2",
        tanks=[{"product_id": str(products["SUPER"].id), "capacity_l": 1000}] * 2,
    )
    assert (await client.post("/stations", json=twice, headers=admin)).status_code == 409
    assert (await client.get("/stations", headers=admin)).json()["total"] == 1


async def test_cuves_sous_ressource_crud(client, auth_headers, products):
    admin = await auth_headers("admin")
    station = (await client.post("/stations", json=station_payload(products, tanks=[]), headers=admin)).json()
    base = f"/stations/{station['id']}/tanks"

    created = await client.post(
        base,
        json={"product_id": str(products["SUPER"].id), "capacity_l": 20000, "safety_stock_l": 2000},
        headers=admin,
    )
    assert created.status_code == 201, created.text
    tank = created.json()
    assert tank["product_code"] == "SUPER" and tank["station_id"] == station["id"]

    again = await client.post(
        base, json={"product_id": str(products["SUPER"].id), "capacity_l": 1}, headers=admin
    )
    assert again.status_code == 409
    assert "déjà une cuve de SUPER" in again.json()["message"]

    too_much = await client.put(f"{base}/{tank['id']}", json={"safety_stock_l": 25000}, headers=admin)
    assert too_much.status_code == 422

    updated = await client.put(f"{base}/{tank['id']}", json={"capacity_l": 26000}, headers=admin)
    assert updated.status_code == 200, updated.text
    assert updated.json()["capacity_l"] == 26000 and updated.json()["safety_stock_l"] == 2000

    reader = await auth_headers("manager")
    listing = await client.get(base, headers=reader)
    assert listing.json()["total"] == 1 and listing.json()["items"][0]["id"] == tank["id"]
    assert (await client.get(f"{base}/{tank['id']}", headers=reader)).status_code == 200
    assert (
        await client.post(
            base, json={"product_id": str(products["GASOIL"].id), "capacity_l": 1}, headers=reader
        )
    ).status_code == 403
    assert (await client.delete(f"{base}/{tank['id']}", headers=reader)).status_code == 403

    assert (await client.delete(f"{base}/{tank['id']}", headers=admin)).status_code == 204
    assert (await client.get(base, headers=admin)).json()["total"] == 0
    assert (await client.get(f"{base}/{tank['id']}", headers=admin)).status_code == 404
