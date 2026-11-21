"""Référentiels F1.1 (produits) et F1.2 (dépôts) : CRUD, validation, rôles."""

HOURS = {"mon": [["06:00", "18:00"]], "sat": [["6:00", "12:00"]]}


def depot_payload(**overrides):
    payload = {
        "code": "scdp-dla",
        "name": "SCDP Douala",
        "operator": "scdp",
        "lat": 4.0435,
        "lon": 9.7043,
        "address": "Zone portuaire",
        "opening_hours": HOURS,
        "avg_wait_min": 90,
        "max_loadings_per_truck_day": 2,
    }
    payload.update(overrides)
    return payload


async def test_produit_crud_complet(client, auth_headers):
    admin = await auth_headers("admin")
    created = await client.post(
        "/products",
        json={"code": "super", "label": "Super", "ref_density_15": 0.745, "thermal_coeff": 0.0012},
        headers=admin,
    )
    assert created.status_code == 201, created.text
    product = created.json()
    assert product["code"] == "SUPER"
    assert product["ref_density_15"] == 0.745
    assert product["color"] == "#888888"

    updated = await client.put(f"/products/{product['id']}", json={"color": "#E11D48"}, headers=admin)
    assert updated.status_code == 200, updated.text
    assert updated.json()["color"] == "#e11d48"
    assert updated.json()["label"] == "Super"

    listing = await client.get("/products", params={"q": "sup"}, headers=await auth_headers("manager"))
    assert listing.status_code == 200
    assert listing.json()["total"] == 1
    assert set(listing.json()) == {"items", "total", "limit", "offset"}

    assert (await client.delete(f"/products/{product['id']}", headers=admin)).status_code == 204
    assert (await client.get(f"/products/{product['id']}", headers=admin)).status_code == 404
    assert (await client.get("/products", headers=admin)).json()["total"] == 0


async def test_produit_code_en_double_409_lisible(client, auth_headers, products):
    response = await client.post(
        "/products",
        json={"code": "gasoil", "label": "Gasoil bis", "ref_density_15": 0.84, "thermal_coeff": 0.0008},
        headers=await auth_headers("admin"),
    )
    assert response.status_code == 409
    body = response.json()
    assert body["code"] == "duplicate"
    assert "GASOIL" in body["message"] and "déjà utilisé" in body["message"]
    assert body["details"][0]["field"] == "code"


async def test_produit_utilise_par_une_cuve_non_supprimable(client, auth_headers, products):
    admin = await auth_headers("admin")
    station = await client.post(
        "/stations",
        json={
            "code": "ST1",
            "name": "Station 1",
            "lat": 4.05,
            "lon": 9.7,
            "tanks": [{"product_id": str(products["SUPER"].id), "capacity_l": 30000}],
        },
        headers=admin,
    )
    assert station.status_code == 201, station.text
    refused = await client.delete(f"/products/{products['SUPER'].id}", headers=admin)
    assert refused.status_code == 409
    assert refused.json()["code"] == "in_use"


async def test_ecriture_reservee_a_l_admin(client, auth_headers):
    payload = {"code": "X", "label": "X", "ref_density_15": 0.8, "thermal_coeff": 0.001}
    for role in ("dispatcher", "fleet", "supply", "manager"):
        headers = await auth_headers(role)
        assert (await client.post("/products", json=payload, headers=headers)).status_code == 403
        assert (await client.post("/depots", json=depot_payload(), headers=headers)).status_code == 403
        assert (await client.get("/products", headers=headers)).status_code == 200
        assert (await client.get("/depots", headers=headers)).status_code == 200
    assert (await client.get("/products")).status_code == 401
    assert (await client.post("/depots", json=depot_payload())).status_code == 401


async def test_depot_crud_complet(client, auth_headers):
    admin = await auth_headers("admin")
    created = await client.post("/depots", json=depot_payload(), headers=admin)
    assert created.status_code == 201, created.text
    depot = created.json()
    assert depot["code"] == "SCDP-DLA"
    assert (depot["lat"], depot["lon"]) == (4.0435, 9.7043)
    assert "location" not in depot
    # Horaires normalisés : heures sur deux chiffres, jours non cités fermés.
    assert depot["opening_hours"]["sat"] == [["06:00", "12:00"]]
    assert depot["opening_hours"]["sun"] == []

    moved = await client.patch(f"/depots/{depot['id']}", json={"lat": 4.1, "active": False}, headers=admin)
    assert moved.status_code == 200, moved.text
    assert (moved.json()["lat"], moved.json()["lon"]) == (4.1, 9.7043)
    assert moved.json()["name"] == "SCDP Douala"

    await client.post(
        "/depots",
        json=depot_payload(code="INT-YDE", name="Dépôt Yaoundé", operator="internal"),
        headers=admin,
    )
    reader = await auth_headers("supply")
    assert (await client.get("/depots", params={"active": "true"}, headers=reader)).json()["total"] == 1
    assert (await client.get("/depots", params={"operator": "scdp"}, headers=reader)).json()["total"] == 1
    page = (await client.get("/depots", params={"limit": 1, "offset": 1}, headers=reader)).json()
    assert page["total"] == 2 and len(page["items"]) == 1 and page["items"][0]["code"] == "SCDP-DLA"

    assert (await client.delete(f"/depots/{depot['id']}", headers=admin)).status_code == 204
    assert (await client.get(f"/depots/{depot['id']}", headers=reader)).status_code == 404
    assert (await client.get("/depots", headers=reader)).json()["total"] == 1
    # Le code d'un dépôt supprimé reste réservé : 409 explicite.
    again = await client.post("/depots", json=depot_payload(), headers=admin)
    assert again.status_code == 409
    assert "supprimé" in again.json()["message"]


async def test_depot_validation_coordonnees_et_horaires(client, auth_headers):
    admin = await auth_headers("admin")
    bad_lat = await client.post("/depots", json=depot_payload(lat=120), headers=admin)
    assert bad_lat.status_code == 422
    assert bad_lat.json()["code"] == "validation_error"
    assert any("lat" in d["field"] for d in bad_lat.json()["details"])

    for hours in (
        {"lundi": [["06:00", "18:00"]]},
        {"mon": [["18:00", "06:00"]]},
        {"mon": [["06:00", "25:00"]]},
        {"mon": [["06:00", "12:00"], ["11:00", "18:00"]]},
        {"mon": ["06:00", "18:00"]},
    ):
        response = await client.post("/depots", json=depot_payload(opening_hours=hours), headers=admin)
        assert response.status_code == 422, hours

    missing = await client.post("/depots", json={"code": "D2", "name": "Sans position"}, headers=admin)
    assert missing.status_code == 422
