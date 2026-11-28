"""API des imports : rôles, fichiers illisibles, modèles, historique, registre de kinds."""

import io

from openpyxl import load_workbook

from app.admin.models import Setting
from app.core.enums import ImportKind, Role
from app.imports import registry
from app.imports.registry import KindHandler, PreviewResult
from app.imports.schemas import ImportItem

from .helpers import apply, csv_file, issues, preview, xlsx

DEPOT_HEADERS = ["Code dépôt", "Nom", "Latitude", "Longitude"]
DEPOT_ROW = ["D1", "Dépôt 1", 4.0, 9.7]
ORDER_HEADERS = ["Date", "Code station", "Produit", "Volume (L)"]


async def test_roles_des_imports(client, auth_headers, products):
    depots = xlsx(DEPOT_HEADERS, [DEPOT_ROW])
    orders = xlsx(ORDER_HEADERS, [["12/01/2027", "ST-X", "SUPER", 1000]])
    admin = await auth_headers("admin")

    # Référentiels : admin uniquement.
    for role in ("dispatcher", "fleet", "supply", "manager"):
        refused = await preview(client, await auth_headers(role), "depots", depots)
        assert refused.status_code == 403, role
        assert refused.json()["code"] == "forbidden"
    batch = (await preview(client, admin, "depots", depots)).json()
    assert batch["status"] == "previewed"
    assert (await apply(client, await auth_headers("dispatcher"), batch)).status_code == 403
    assert (await apply(client, admin, batch)).status_code == 200

    # Commandes : dispatcher (et admin).
    for role in ("fleet", "supply", "manager"):
        assert (await preview(client, await auth_headers(role), "orders", orders)).status_code == 403, role
    assert (await preview(client, await auth_headers("dispatcher"), "orders", orders)).status_code == 201
    assert (await preview(client, admin, "orders", orders)).status_code == 201

    # Sans jeton.
    assert (
        await client.post("/imports/depots/preview", files={"file": ("d.xlsx", depots)})
    ).status_code == 401
    assert (await client.get("/imports/templates/depots")).status_code == 401


async def test_fichiers_illisibles_ou_mal_structures(client, auth_headers):
    admin = await auth_headers("admin")

    async def first_issue(content, filename):
        response = await preview(client, admin, "depots", content, filename)
        assert response.status_code == 201, response.text
        batch = response.json()
        assert batch["status"] == "rejected" and batch["row_count"] == 0
        return batch["report"]["issues"][0]["message"]

    assert "vide" in await first_issue(b"", "depots.xlsx")
    assert "illisible" in await first_issue(b"PK ceci n'est pas un classeur", "depots.xlsx")
    assert ".xls" in await first_issue(b"\xd0\xcf\x11\xe0", "depots.xls")
    assert "non pris en charge" in await first_issue(b"%PDF-1.4", "depots.pdf")
    assert "aucune ligne" in await first_issue(b"\n\n", "depots.csv")

    # Colonne obligatoire absente, colonne inconnue signalée en avertissement.
    batch = (await preview(client, admin, "depots", xlsx(["Nom", "Couleur"], [["Dépôt 1", "bleu"]]))).json()
    assert batch["status"] == "rejected"
    assert issues(batch) == [(1, "Code dépôt")]
    assert issues(batch, "warning") == [(1, "Couleur")]

    # Kind inconnu ou champ `file` manquant : erreur de requête.
    assert (await preview(client, admin, "inconnu", b"x")).status_code == 422
    assert (await client.post("/imports/depots/preview", headers=admin)).status_code == 422
    assert (
        await client.post("/imports/00000000-0000-7000-8000-000000000000/apply", headers=admin)
    ).status_code == 404


async def test_taille_maximale_parametrable(client, auth_headers, db):
    admin = await auth_headers("admin")
    db.add(Setting(key="import_max_file_mb", value=0.001, description="test"))
    await db.commit()
    rows = [[f"D{i}", f"Dépôt {i}", 4.0, 9.7] for i in range(200)]
    response = await preview(client, admin, "depots", csv_file(DEPOT_HEADERS, rows), "depots.csv")
    assert response.status_code == 413
    assert response.json()["code"] == "file_too_large"


async def test_feuille_lisez_moi_ignoree_et_separateurs_csv(client, auth_headers):
    admin = await auth_headers("admin")
    # Classeur dont la première feuille est « Lisez-moi » : la feuille de données est trouvée.
    workbook = load_workbook(io.BytesIO(xlsx(DEPOT_HEADERS, [DEPOT_ROW], sheet="Dépôts")))
    readme = workbook.create_sheet("Lisez-moi", 0)
    readme.append(["Mode d'emploi"])
    buffer = io.BytesIO()
    workbook.save(buffer)
    batch = (await preview(client, admin, "depots", buffer.getvalue())).json()
    assert batch["status"] == "previewed" and batch["report"]["summary"]["created"] == 1

    for delimiter in (";", ",", "\t"):
        content = csv_file(DEPOT_HEADERS, [["D1", "Dépôt 1", "4.0", "9.7"]], delimiter)
        batch = (await preview(client, admin, "depots", content, "depots.csv")).json()
        assert batch["status"] == "previewed", (delimiter, batch["report"]["issues"])


async def test_modeles_telechargeables_et_importables(client, auth_headers, products):
    """Les modèles fournis, importés tels quels dans l'ordre, s'appliquent sans erreur."""
    admin = await auth_headers("admin")
    reader = await auth_headers("manager")
    for kind in ("depots", "stations", "trucks", "drivers", "orders"):
        # Les commandes du modèle n'ont pas de date : elles prennent la journée choisie à l'import.
        params = {"day": "2027-03-04"} if kind == "orders" else {}
        response = await client.get(f"/imports/templates/{kind}", headers=reader)
        assert response.status_code == 200, kind
        assert response.headers["content-type"].startswith("application/vnd.openxmlformats")
        assert f'filename="{kind}.xlsx"' in response.headers["content-disposition"]
        assert "Lisez-moi" in load_workbook(io.BytesIO(response.content)).sheetnames

        batch = (await preview(client, admin, kind, response.content, f"{kind}.xlsx", **params)).json()
        assert batch["status"] == "previewed", (kind, batch["report"]["issues"])
        assert batch["report"]["summary"]["created"] == len(batch["report"]["items"]) > 0
        assert (await apply(client, admin, batch)).status_code == 200, kind

        as_csv = await client.get(f"/imports/templates/{kind}", params={"format": "csv"}, headers=reader)
        assert as_csv.status_code == 200 and as_csv.headers["content-type"].startswith("text/csv")
        again = (await preview(client, admin, kind, as_csv.content, f"{kind}.csv", **params)).json()
        assert again["status"] == "previewed", (kind, again["report"]["issues"])
        assert again["report"]["summary"]["unchanged"] == len(again["report"]["items"]), kind

    assert (await client.get("/stations", headers=reader)).json()["total"] == 6
    assert (await client.get("/trucks", headers=reader)).json()["total"] == 4
    assert (await client.get("/drivers", headers=reader)).json()["total"] == 5
    assert (await client.get("/depots", headers=reader)).json()["total"] == 2
    assert (
        await client.get("/imports/templates/depots", params={"format": "pdf"}, headers=reader)
    ).status_code == 422


async def test_historique_des_lots(client, auth_headers):
    admin = await auth_headers("admin")
    ok = (await preview(client, admin, "depots", xlsx(DEPOT_HEADERS, [DEPOT_ROW]), "bon.xlsx")).json()
    ko = (
        await preview(client, admin, "depots", xlsx(DEPOT_HEADERS, [["D2", "Dépôt 2", 95, 9.7]]), "faux.xlsx")
    ).json()
    await apply(client, admin, ok)

    reader = await auth_headers("supply")
    listing = (await client.get("/imports", params={"kind": "depots"}, headers=reader)).json()
    assert listing["total"] == 2 and set(listing) == {"items", "total", "limit", "offset"}
    by_file = {b["filename"]: b for b in listing["items"]}
    assert by_file["bon.xlsx"]["status"] == "applied" and by_file["bon.xlsx"]["summary"]["created"] == 1
    assert by_file["faux.xlsx"]["status"] == "rejected" and by_file["faux.xlsx"]["error_count"] == 1
    assert (await client.get("/imports", params={"status": "rejected"}, headers=reader)).json()["total"] == 1
    assert (await client.get("/imports", params={"kind": "orders"}, headers=reader)).json()["total"] == 0

    detail = (
        await client.get(f"/imports/{ko['id']}", params={"include_data": "true"}, headers=reader)
    ).json()
    assert detail["report"]["issues"][0]["row"] == 2 and detail["report"]["data"] == []
    assert detail["created_by"] is not None
    assert (await client.get(f"/imports/{ok['id']}", headers=reader)).json()["report"]["applied"][
        "created"
    ] == 1


async def test_registre_un_autre_lot_branche_son_kind(client, auth_headers, monkeypatch):
    """Le lot L7 enregistre `reference_day` sans toucher au routeur : même cycle prévisualiser / appliquer."""
    calls = []

    async def fake_preview(session, file, options):
        calls.append(("preview", file.filename, options))
        item = ImportItem(row=2, key="T1", label="Tournée 1", action="create")
        return PreviewResult(
            row_count=1, items=[item], data=[{"trip": "T1"}], options={"day": options.get("day")}
        )

    async def fake_apply(session, batch):
        calls.append(("apply", batch.report["data"]))
        return {"plan_id": "p-1"}

    admin = await auth_headers("admin")
    registry.load_kinds()
    if ImportKind.REFERENCE_DAY not in registry.registered_kinds():
        missing = await preview(client, admin, "reference_day", b"x")
        assert missing.status_code == 404 and missing.json()["code"] == "unknown_import_kind"

    handler = KindHandler(
        kind=ImportKind.REFERENCE_DAY,
        label="Journée de référence",
        roles=(Role.DISPATCHER,),
        preview=fake_preview,
        apply=fake_apply,
        template=lambda: b"modele",
    )
    monkeypatch.setitem(registry._KINDS, ImportKind.REFERENCE_DAY, handler)

    dispatcher = await auth_headers("dispatcher")
    assert (await preview(client, await auth_headers("fleet"), "reference_day", b"x")).status_code == 403
    response = await preview(
        client, dispatcher, "reference_day", b"contenu", "journee_a.xlsx", day="2027-01-12"
    )
    assert response.status_code == 201, response.text
    batch = response.json()
    assert batch["kind"] == "reference_day" and batch["status"] == "previewed"
    assert batch["report"]["summary"]["created"] == 1 and batch["report"]["options"] == {"day": "2027-01-12"}
    applied = await apply(client, dispatcher, batch)
    assert applied.status_code == 200 and applied.json()["report"]["applied"]["plan_id"] == "p-1"
    assert calls == [("preview", "journee_a.xlsx", {"day": "2027-01-12"}), ("apply", [{"trip": "T1"}])]
    template = await client.get("/imports/templates/reference_day", headers=dispatcher)
    assert template.status_code == 200 and template.content == b"modele"
