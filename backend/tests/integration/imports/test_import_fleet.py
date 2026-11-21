"""Import des camions (avec compartiments), des chauffeurs et des dépôts (F1.6)."""

from .helpers import apply, changes, csv_file, issues, preview, xlsx

TRUCK_HEADERS = [
    "Immatriculation",
    "Transporteur",
    "Type de transporteur",
    "Gabarit",
    "Capacité totale (L)",
    "Vitesse moyenne (km/h)",
    "Statut",
    "Coût au km (FCFA)",
    "Notes",
    "Compartiment",
    "Capacité compartiment (L)",
    "Produits autorisés",
]
DRIVER_HEADERS = [
    "Numéro de permis",
    "Nom complet",
    "Téléphone",
    "Expiration du permis",
    "Habilitation matières dangereuses",
    "Expiration de l'habilitation",
    "Transporteur",
    "Statut",
    "Camion habituel",
]
DEPOT_HEADERS = [
    "Code dépôt",
    "Nom",
    "Exploitant",
    "Latitude",
    "Longitude",
    "Adresse",
    "Horaires d'ouverture",
    "Attente moyenne (min)",
    "Chargements max par camion et par jour",
    "Actif",
]


def truck_rows():
    return [
        ["LT 123 AB", "Transcam", "tiers", "grand", 33000, 45, "disponible", 650, None, 1, 11000, "tous"],
        ["LT 123 AB", None, None, None, None, None, None, None, None, 2, 11000, "SUPER, GASOIL"],
        ["LT 123 AB", None, None, None, None, None, None, None, None, 3, 11000, None],
        [
            "lt 456 cd",
            "OLA Flotte",
            "propre",
            "petit",
            None,
            None,
            "maintenance",
            None,
            "Révision",
            1,
            12000,
            "GASOIL",
        ],
    ]


async def import_trucks(client, admin):
    batch = (await preview(client, admin, "trucks", xlsx(TRUCK_HEADERS, truck_rows()))).json()
    assert batch["status"] == "previewed", batch["report"]["issues"]
    assert (await apply(client, admin, batch)).status_code == 200
    return batch


async def test_import_camions_cycle_complet(client, auth_headers, products):
    admin = await auth_headers("admin")

    bad = truck_rows()
    bad[0][4] = 30000  # somme des compartiments (33 000) > capacité totale
    bad[1][11] = "SUPER, KEROSENE"  # produit inconnu
    bad[3][3] = None  # gabarit obligatoire à la création
    bad.append(
        ["LT 456 CD", None, None, None, None, None, None, None, None, 1, 500, None]
    )  # compartiment en double
    bad.append(["LT 789 EF", None, None, "moyen", None, None, "volé", None, None, None, None, None])
    response = await preview(client, admin, "trucks", xlsx(TRUCK_HEADERS, bad))
    assert response.status_code == 201, response.text
    batch = response.json()
    assert batch["status"] == "rejected"
    assert set(issues(batch)) == {
        (2, "Capacité totale (L)"),
        (3, "Produits autorisés"),
        # Le camion LT 456 CD est illisible (compartiment en double) : ses contrôles en base, dont le
        # gabarit manquant, n'apparaîtront qu'une fois le fichier lisible.
        (6, "Compartiment"),
        (7, "Statut"),
    }
    assert (await apply(client, admin, batch)).status_code == 409
    assert (await client.get("/trucks", headers=admin)).json()["total"] == 0
    assert (await client.get("/carriers", headers=admin)).json()["total"] == 0

    response = await preview(client, admin, "trucks", xlsx(TRUCK_HEADERS, truck_rows()))
    batch = response.json()
    assert batch["status"] == "previewed", batch["report"]["issues"]
    assert batch["report"]["summary"] == {
        "created": 2,
        "updated": 0,
        "unchanged": 0,
        "errors": 0,
        "warnings": 2,
    }
    warnings = [i["message"] for i in batch["report"]["issues"]]
    assert any("« Transcam » sera créé (type tiers)" in m for m in warnings)
    assert any("« OLA Flotte » sera créé (type propre)" in m for m in warnings)
    assert (await apply(client, admin, batch)).status_code == 200

    trucks = {t["plate"]: t for t in (await client.get("/trucks", headers=admin)).json()["items"]}
    assert set(trucks) == {"LT 123 AB", "LT 456 CD"}
    big, small = trucks["LT 123 AB"], trucks["LT 456 CD"]
    assert big["carrier_name"] == "Transcam" and big["carrier_type"] == "third_party"
    assert big["size"] == "large" and big["total_capacity_l"] == 33000 and big["avg_speed_kmh"] == 45
    assert big["cost_per_km"] == 650 and big["status"] == "available"
    assert [(c["position"], c["capacity_l"], c["allowed_product_codes"]) for c in big["compartments"]] == [
        (1, 11000, None),
        (2, 11000, ["SUPER", "GASOIL"]),
        (3, 11000, None),
    ]
    assert (
        small["carrier_type"] == "own" and small["status"] == "maintenance" and small["notes"] == "Révision"
    )
    assert small["total_capacity_l"] == 12000  # déduite des compartiments
    assert small["compartments"][0]["allowed_product_codes"] == ["GASOIL"]
    carriers = (await client.get("/carriers", headers=admin)).json()
    assert carriers["total"] == 2


async def test_reimport_camions_csv_mises_a_jour_annoncees(client, auth_headers, products):
    admin = await auth_headers("admin")
    await import_trucks(client, admin)

    same = (await preview(client, admin, "trucks", xlsx(TRUCK_HEADERS, truck_rows()))).json()
    assert same["report"]["summary"] == {
        "created": 0,
        "updated": 0,
        "unchanged": 2,
        "errors": 0,
        "warnings": 0,
    }

    rows = [
        ["LT 123 AB", "OLA Flotte", "", "", "", "", "en panne", "", "", "2", "11000", "tous"],
        ["LT 123 AB", "", "", "", "", "", "", "", "", "3", "10000", "PETROLE"],
        ["LT 456 CD", "", "", "", "20000", "", "", "", "", "2", "8000", ""],
    ]
    batch = (await preview(client, admin, "trucks", csv_file(TRUCK_HEADERS, rows, ","), "camions.csv")).json()
    assert batch["status"] == "previewed", batch["report"]["issues"]
    assert batch["report"]["summary"]["updated"] == 2
    first, second = batch["report"]["items"]
    assert changes(first) == {
        "status": ("available", "broken"),
        "carrier_id": ("Transcam", "OLA Flotte"),
        "compartments[2].allowed_product_ids": ("GASOIL, SUPER", "tous"),
        "compartments[3].capacity_l": (11000, 10000),
        "compartments[3].allowed_product_ids": ("tous", "PETROLE"),
    }
    assert changes(second) == {
        "total_capacity_l": (12000, 20000),
        "compartments[2]": (None, "8000 L, produits : tous"),
    }
    assert (await apply(client, admin, batch)).status_code == 200

    trucks = {t["plate"]: t for t in (await client.get("/trucks", headers=admin)).json()["items"]}
    big = trucks["LT 123 AB"]
    assert big["status"] == "broken" and big["carrier_name"] == "OLA Flotte" and big["size"] == "large"
    assert [(c["position"], c["capacity_l"], c["allowed_product_codes"]) for c in big["compartments"]] == [
        (1, 11000, None),  # absent du fichier : conservé
        (2, 11000, None),
        (3, 10000, ["PETROLE"]),
    ]
    assert [c["position"] for c in trucks["LT 456 CD"]["compartments"]] == [1, 2]

    # Capacité incohérente avec les compartiments déjà en base : refusée à la prévisualisation.
    too_small = (
        await preview(
            client,
            admin,
            "trucks",
            csv_file(TRUCK_HEADERS[:5], [["LT 456 CD", "", "", "", "15000"]]),
            "c.csv",
        )
    ).json()
    assert too_small["status"] == "rejected" and issues(too_small) == [(2, "Capacité totale (L)")]
    assert "dépasse" in too_small["report"]["issues"][0]["message"]


async def test_import_chauffeurs_cycle_complet(client, auth_headers, products):
    admin = await auth_headers("admin")
    await import_trucks(client, admin)
    rows = [
        [
            "CM-2020-0001",
            "Jean Mbarga",
            "+237 677 00 00 01",
            "30/06/2028",
            "oui",
            "2027-12-31",
            "Transcam",
            "disponible",
            "LT 123 AB",
        ],
        ["CM-2019-0457", "Paul Atangana", None, None, "non", None, "Nouveau Transport", "congé", None],
    ]

    bad = [list(r) for r in rows]
    bad[0][3] = "31/02/2028"  # date impossible
    bad[0][8] = "XX 000 XX"  # camion inconnu (ligne déjà en erreur : la date)
    bad[1][1] = None  # nom obligatoire à la création
    bad.append(["cm-2019-0457", "Homonyme", None, None, None, None, None, None, None])  # doublon de permis
    bad.append(["CM-3", "Luc Essomba", None, None, "peut-être", None, None, None, "ZZ 999 ZZ"])
    bad.append(["CM-4", "Marc Biya", None, None, None, None, None, None, "ZZ 999 ZZ"])
    batch = (await preview(client, admin, "drivers", xlsx(DRIVER_HEADERS, bad))).json()
    assert batch["status"] == "rejected"
    assert set(issues(batch)) == {
        (2, "Expiration du permis"),
        (3, "Nom complet"),
        (4, "Numéro de permis"),
        (5, "Habilitation matières dangereuses"),
        (6, "Camion habituel"),
    }
    assert (await apply(client, admin, batch)).status_code == 409
    assert (await client.get("/drivers", headers=admin)).json()["total"] == 0

    batch = (await preview(client, admin, "drivers", xlsx(DRIVER_HEADERS, rows))).json()
    assert batch["status"] == "previewed", batch["report"]["issues"]
    assert batch["report"]["summary"] == {
        "created": 2,
        "updated": 0,
        "unchanged": 0,
        "errors": 0,
        "warnings": 1,
    }
    assert (await apply(client, admin, batch)).status_code == 200

    drivers = {d["license_no"]: d for d in (await client.get("/drivers", headers=admin)).json()["items"]}
    jean, paul = drivers["CM-2020-0001"], drivers["CM-2019-0457"]
    assert jean["full_name"] == "Jean Mbarga" and jean["license_expiry"] == "2028-06-30"
    assert jean["hazmat_cert"] is True and jean["hazmat_expiry"] == "2027-12-31"
    assert jean["carrier_name"] == "Transcam" and jean["default_truck_plate"] == "LT 123 AB"
    assert (
        paul["status"] == "leave"
        and paul["carrier_name"] == "Nouveau Transport"
        and paul["hazmat_cert"] is False
    )

    # Ré-import en CSV : changement de statut, de camion habituel et d'habilitation, annoncés.
    update = [
        ["CM-2020-0001", "", "", "", "", "", "", "malade", "LT 456 CD"],
        ["CM-2019-0457", "", "+237 699 11 22 33", "15/03/2029", "oui", "", "", "", ""],
        ["CM-2021-0900", "Luc Essomba", "", "", "oui", "", "Transcam", "", ""],
    ]
    batch = (
        await preview(client, admin, "drivers", csv_file(DRIVER_HEADERS, update), "chauffeurs.csv")
    ).json()
    assert batch["status"] == "previewed", batch["report"]["issues"]
    assert batch["report"]["summary"] == {
        "created": 1,
        "updated": 2,
        "unchanged": 0,
        "errors": 0,
        "warnings": 0,
    }
    assert changes(batch["report"]["items"][0]) == {
        "status": ("available", "sick"),
        "default_truck_id": ("LT 123 AB", "LT 456 CD"),
    }
    assert changes(batch["report"]["items"][1]) == {
        "phone": (None, "+237 699 11 22 33"),
        "license_expiry": (None, "2029-03-15"),
        "hazmat_cert": (False, True),
    }
    assert (await apply(client, admin, batch)).status_code == 200
    drivers = {d["license_no"]: d for d in (await client.get("/drivers", headers=admin)).json()["items"]}
    assert len(drivers) == 3
    assert drivers["CM-2020-0001"]["status"] == "sick"
    assert drivers["CM-2020-0001"]["default_truck_plate"] == "LT 456 CD"
    assert drivers["CM-2020-0001"]["full_name"] == "Jean Mbarga"
    assert drivers["CM-2019-0457"]["hazmat_cert"] is True and drivers["CM-2019-0457"]["status"] == "leave"


async def test_import_depots_cycle_complet(client, auth_headers):
    admin = await auth_headers("admin")
    rows = [
        [
            "SCDP-DLA",
            "SCDP Douala",
            "SCDP",
            4.0435,
            9.7043,
            "Zone portuaire",
            "lun-sam 06:00-18:00",
            90,
            2,
            "oui",
        ],
        ["int-yde", "Dépôt Yaoundé", "interne", 3.8312, 11.5321, None, None, None, None, None],
    ]

    bad = [list(r) for r in rows]
    bad[0][6] = "du lundi matin au soir"
    bad[0][8] = 0
    bad[1][3] = 95
    bad[1][2] = "privé"
    bad.append(["D3", None, None, None, None, None, None, None, None, None])
    batch = (await preview(client, admin, "depots", xlsx(DEPOT_HEADERS, bad))).json()
    assert batch["status"] == "rejected"
    assert set(issues(batch)) == {
        (2, "Horaires d'ouverture"),
        (2, "Chargements max par camion et par jour"),
        (3, "Latitude"),
        (3, "Exploitant"),
        (4, "Nom"),
        (4, "Latitude"),
        (4, "Longitude"),
    }
    assert (await apply(client, admin, batch)).status_code == 409

    batch = (await preview(client, admin, "depots", xlsx(DEPOT_HEADERS, rows))).json()
    assert batch["report"]["summary"] == {
        "created": 2,
        "updated": 0,
        "unchanged": 0,
        "errors": 0,
        "warnings": 0,
    }
    assert (await apply(client, admin, batch)).status_code == 200
    depots = {d["code"]: d for d in (await client.get("/depots", headers=admin)).json()["items"]}
    assert set(depots) == {"SCDP-DLA", "INT-YDE"}
    assert depots["SCDP-DLA"]["opening_hours"]["mon"] == [["06:00", "18:00"]]
    assert depots["SCDP-DLA"]["avg_wait_min"] == 90 and depots["SCDP-DLA"]["max_loadings_per_truck_day"] == 2
    assert depots["INT-YDE"]["operator"] == "internal" and depots["INT-YDE"]["opening_hours"] == {}
    assert (depots["INT-YDE"]["lat"], depots["INT-YDE"]["lon"]) == (3.8312, 11.5321)

    # Ré-import CSV (en-têtes abrégés, encodage Windows) : une mise à jour annoncée, un inchangé.
    update = [
        ["SCDP-DLA", "SCDP Douala", "120", "lun-ven 06:00-18:00 ; sam 06:00-12:00"],
        ["INT-YDE", "Dépôt Yaoundé", "", ""],
    ]
    content = csv_file(["Code dépôt", "Nom", "Attente moyenne (min)", "Horaires"], update, encoding="cp1252")
    batch = (await preview(client, admin, "depots", content, "depots.csv")).json()
    assert batch["status"] == "previewed", batch["report"]["issues"]
    assert batch["report"]["summary"] == {
        "created": 0,
        "updated": 1,
        "unchanged": 1,
        "errors": 0,
        "warnings": 0,
    }
    item = batch["report"]["items"][0]
    assert changes(item)["avg_wait_min"] == (90, 120)
    assert changes(item)["opening_hours"][1]["sat"] == [["06:00", "12:00"]]
    assert (await apply(client, admin, batch)).status_code == 200
    depot = (await client.get("/depots", params={"q": "SCDP-DLA"}, headers=admin)).json()["items"][0]
    assert depot["avg_wait_min"] == 120 and depot["opening_hours"]["sat"] == [["06:00", "12:00"]]
    assert depot["address"] == "Zone portuaire"
