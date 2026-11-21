"""Import des stations et de leurs cuves (F1.6) : cycle complet prévisualiser → corriger → appliquer."""

from .helpers import apply, changes, csv_file, issues, preview, xlsx

HEADERS = [
    "Code station",
    "Nom",
    "Région",
    "Ville",
    "Latitude",
    "Longitude",
    "Horaires de réception",
    "Gabarit max",
    "Temps de dépotage (min)",
    "Contact",
    "Téléphone",
    "E-mail",
    "Active",
    "Produit",
    "Capacité cuve (L)",
    "Stock de sécurité (L)",
]


def station_rows():
    return [
        [
            "ST-AKWA",
            "OLA Akwa",
            "Littoral",
            "Douala",
            4.0511,
            9.7085,
            "lun-sam 06:00-20:00",
            "moyen",
            45,
            "M. Ndongo",
            "+237 699 00 00 01",
            "akwa@example.cm",
            "oui",
            "SUPER",
            30000,
            3000,
        ],
        [
            "ST-AKWA",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            "GASOIL",
            40000,
            4000,
        ],
        [
            "ST-BONAB",
            "OLA Bonabéri",
            "Littoral",
            "Douala",
            4.0712,
            9.6601,
            "24h/24",
            "grand",
            None,
            None,
            None,
            None,
            None,
            "GASOIL",
            50000,
            None,
        ],
    ]


async def test_import_stations_cycle_complet(client, auth_headers, products):
    admin = await auth_headers("admin")

    # 1. Fichier avec erreurs : rapport ligne par ligne, lot non applicable, rien n'est créé.
    bad = station_rows()
    bad[0][4] = "quatre"  # latitude illisible
    bad[1][13] = "KEROSENE"  # produit inconnu
    bad[2][15] = 60000  # stock de sécurité > capacité
    bad.append(
        ["ST-NEW", None, None, None, None, 9.7, None, "géant", None, None, None, None, None, None, None, None]
    )
    response = await preview(client, admin, "stations", xlsx(HEADERS, bad))
    assert response.status_code == 201, response.text
    batch = response.json()
    assert batch["status"] == "rejected" and batch["can_apply"] is False
    assert batch["batch_id"] == batch["id"] and batch["kind"] == "stations"
    assert batch["row_count"] == 4
    assert batch["error_count"] == batch["report"]["summary"]["errors"] == len(issues(batch))
    assert set(issues(batch)) >= {
        (2, "Latitude"),
        (4, "Stock de sécurité (L)"),
        (5, "Gabarit max"),
    }
    latitude = next(i for i in batch["report"]["issues"] if i["column"] == "Latitude")
    assert latitude["value"] == "quatre" and "Latitude invalide" not in latitude["message"]
    assert "Nombre attendu" in latitude["message"]
    gabarit = next(i for i in batch["report"]["issues"] if i["column"] == "Gabarit max")
    assert "petit, moyen, grand" in gabarit["message"]

    refused = await apply(client, admin, batch)
    assert refused.status_code == 409
    assert refused.json()["code"] == "import_has_errors"
    assert (await client.get("/stations", headers=admin)).json()["total"] == 0

    # Le produit inconnu est détecté dès que la ligne est lisible.
    bad = station_rows()
    bad[1][13] = "KEROSENE"
    batch = (await preview(client, admin, "stations", xlsx(HEADERS, bad))).json()
    assert issues(batch) == [(3, "Produit")]
    assert "KEROSENE" in batch["report"]["issues"][0]["message"]
    assert "GASOIL" in batch["report"]["issues"][0]["message"]

    # 2. Fichier corrigé : créations annoncées, puis application.
    response = await preview(client, admin, "stations", xlsx(HEADERS, station_rows()), include_data="true")
    batch = response.json()
    assert batch["status"] == "previewed" and batch["can_apply"] is True, batch["report"]["issues"]
    assert batch["report"]["summary"] == {
        "created": 2,
        "updated": 0,
        "unchanged": 0,
        "errors": 0,
        "warnings": 0,
    }
    assert [(i["row"], i["key"], i["action"]) for i in batch["report"]["items"]] == [
        (2, "ST-AKWA", "create"),
        (4, "ST-BONAB", "create"),
    ]
    assert batch["report"]["data"][0]["tanks"][1] == {
        "row": 3,
        "product_code": "GASOIL",
        "capacity_l": 40000.0,
        "safety_stock_l": 4000.0,
    }
    assert (await client.get("/stations", headers=admin)).json()["total"] == 0  # rien avant « appliquer »

    applied = await apply(client, admin, batch)
    assert applied.status_code == 200, applied.text
    assert applied.json()["status"] == "applied"
    assert applied.json()["report"]["applied"]["created"] == 2

    # 3. Relecture par l'API.
    stations = (await client.get("/stations", headers=await auth_headers("dispatcher"))).json()["items"]
    assert [s["code"] for s in stations] == ["ST-AKWA", "ST-BONAB"]
    akwa, bonab = stations
    assert akwa["name"] == "OLA Akwa" and akwa["max_truck_size"] == "medium" and akwa["unload_time_min"] == 45
    assert (akwa["lat"], akwa["lon"]) == (4.0511, 9.7085)
    assert akwa["opening_hours"]["sat"] == [["06:00", "20:00"]] and akwa["opening_hours"]["sun"] == []
    assert {t["product_code"]: (t["capacity_l"], t["safety_stock_l"]) for t in akwa["tanks"]} == {
        "SUPER": (30000, 3000),
        "GASOIL": (40000, 4000),
    }
    assert bonab["opening_hours"]["sun"] == [["00:00", "24:00"]]
    assert bonab["max_truck_size"] == "large" and bonab["active"] is True and bonab["unload_time_min"] is None
    assert bonab["tanks"][0]["safety_stock_l"] == 0

    # 4. Un lot appliqué ne se réapplique pas.
    again = await apply(client, admin, batch)
    assert again.status_code == 409 and again.json()["code"] == "already_applied"
    assert (await client.get("/stations", headers=admin)).json()["total"] == 2


async def test_reimport_stations_mises_a_jour_annoncees(client, auth_headers, products):
    admin = await auth_headers("admin")
    first = (await preview(client, admin, "stations", xlsx(HEADERS, station_rows()))).json()
    assert (await apply(client, admin, first)).status_code == 200

    # Même fichier : tout est inchangé.
    same = (await preview(client, admin, "stations", xlsx(HEADERS, station_rows()))).json()
    assert same["report"]["summary"] == {
        "created": 0,
        "updated": 0,
        "unchanged": 2,
        "errors": 0,
        "warnings": 0,
    }
    assert all(i["changes"] == [] for i in same["report"]["items"])

    # Fichier CSV modifié : nom, position, cuve existante, nouvelle cuve, nouvelle station.
    rows = [
        [
            "ST-AKWA",
            "OLA Akwa Centre",
            "",
            "",
            "4,0600",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "SUPER",
            "35000",
            "",
        ],
        ["ST-AKWA", "", "", "", "", "", "", "", "", "", "", "", "", "PETROLE", "10000", "500"],
        [
            "ST-DEIDO",
            "OLA Deïdo",
            "Littoral",
            "Douala",
            "4.0650",
            "9.7100",
            "",
            "petit",
            "",
            "",
            "",
            "",
            "non",
            "",
            "",
            "",
        ],
    ]
    response = await preview(client, admin, "stations", csv_file(HEADERS, rows), "stations.csv")
    assert response.status_code == 201, response.text
    batch = response.json()
    assert batch["status"] == "previewed", batch["report"]["issues"]
    assert batch["report"]["summary"] == {
        "created": 1,
        "updated": 1,
        "unchanged": 0,
        "errors": 0,
        "warnings": 0,
    }
    update = batch["report"]["items"][0]
    assert update["action"] == "update" and update["key"] == "ST-AKWA"
    assert changes(update) == {
        "name": ("OLA Akwa", "OLA Akwa Centre"),
        "lat": (4.0511, 4.06),
        "tanks[SUPER].capacity_l": (30000, 35000),
        "tanks[PETROLE]": (None, "10000 L, stock de sécurité 500 L"),
    }
    assert {c["label"] for c in update["changes"]} >= {"Nom", "Latitude", "Cuve SUPER — Capacité cuve (L)"}

    # Rien n'est écrit tant que le lot n'est pas appliqué.
    before = (await client.get("/stations", params={"q": "ST-AKWA"}, headers=admin)).json()["items"][0]
    assert before["name"] == "OLA Akwa" and len(before["tanks"]) == 2

    assert (await apply(client, admin, batch)).status_code == 200
    stations = {s["code"]: s for s in (await client.get("/stations", headers=admin)).json()["items"]}
    assert set(stations) == {"ST-AKWA", "ST-BONAB", "ST-DEIDO"}
    akwa = stations["ST-AKWA"]
    assert akwa["name"] == "OLA Akwa Centre" and (akwa["lat"], akwa["lon"]) == (4.06, 9.7085)
    assert akwa["region"] == "Littoral" and akwa["max_truck_size"] == "medium"  # cellules vides : inchangé
    # La cuve GASOIL, absente du fichier, est conservée ; le stock de sécurité SUPER non fourni aussi.
    assert {t["product_code"]: (t["capacity_l"], t["safety_stock_l"]) for t in akwa["tanks"]} == {
        "SUPER": (35000, 3000),
        "GASOIL": (40000, 4000),
        "PETROLE": (10000, 500),
    }
    assert stations["ST-DEIDO"]["active"] is False and stations["ST-DEIDO"]["tanks"] == []


async def test_import_stations_previsualisation_perimee(client, auth_headers, products):
    admin = await auth_headers("admin")
    first = (await preview(client, admin, "stations", xlsx(HEADERS, station_rows()))).json()
    assert (await apply(client, admin, first)).status_code == 200

    rows = station_rows()
    rows[0][1] = "OLA Akwa Centre"
    batch = (await preview(client, admin, "stations", xlsx(HEADERS, rows))).json()
    assert batch["report"]["summary"]["updated"] == 1

    # Entre-temps, quelqu'un modifie la station à l'écran : l'annonce « avant → après » n'est plus exacte.
    station = (await client.get("/stations", params={"q": "ST-AKWA"}, headers=admin)).json()["items"][0]
    await client.put(f"/stations/{station['id']}", json={"name": "OLA Akwa Sud"}, headers=admin)

    stale = await apply(client, admin, batch)
    assert stale.status_code == 409 and stale.json()["code"] == "stale_preview"
    after = (await client.get(f"/stations/{station['id']}", headers=admin)).json()
    assert after["name"] == "OLA Akwa Sud"
    assert (await client.get(f"/imports/{batch['id']}", headers=admin)).json()["status"] == "previewed"


async def test_import_stations_lignes_contradictoires_et_doublons(client, auth_headers, products):
    admin = await auth_headers("admin")
    rows = station_rows()
    rows[1][1] = "Autre nom"  # contredit la ligne 2
    rows.append(
        [
            "ST-BONAB",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            "GASOIL",
            1000,
            None,
        ]
    )
    rows.append(
        [
            "ST-X",
            "Sans cuve",
            None,
            None,
            4.0,
            9.0,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            5000,
            None,
        ]
    )
    rows.append(
        [None, "Sans code", None, None, 4.0, 9.0, None, None, None, None, None, None, None, None, None, None]
    )
    batch = (await preview(client, admin, "stations", xlsx(HEADERS, rows))).json()
    assert batch["status"] == "rejected"
    assert set(issues(batch)) == {(3, "Nom"), (5, "Produit"), (6, "Produit"), (7, "Code station")}
    messages = " ".join(i["message"] for i in batch["report"]["issues"])
    assert "ligne 2" in messages and "Doublon" in messages and "obligatoire" in messages
    assert batch["report"]["items"] == []


async def test_import_stations_reactive_une_station_supprimee(client, auth_headers, products):
    admin = await auth_headers("admin")
    first = (await preview(client, admin, "stations", xlsx(HEADERS, station_rows()))).json()
    await apply(client, admin, first)
    station = (await client.get("/stations", params={"q": "ST-BONAB"}, headers=admin)).json()["items"][0]
    assert (await client.delete(f"/stations/{station['id']}", headers=admin)).status_code == 204

    batch = (await preview(client, admin, "stations", xlsx(HEADERS, station_rows()))).json()
    item = next(i for i in batch["report"]["items"] if i["key"] == "ST-BONAB")
    assert item["action"] == "update" and changes(item) == {"deleted_at": ("supprimé", "réactivé")}
    assert (await apply(client, admin, batch)).status_code == 200
    assert (await client.get(f"/stations/{station['id']}", headers=admin)).status_code == 200
