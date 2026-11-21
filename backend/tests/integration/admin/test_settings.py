"""Paramètres métier (F9.2)."""

import pytest
from sqlalchemy import select

from app.admin.models import Setting
from app.admin.settings_spec import SPECS, SettingError, normalize, spec_for
from app.audit.models import AuditLog
from app.core import settings_store
from app.core.settings_store import DEFAULTS, get_setting


async def test_lecture_de_toutes_les_cles_avec_defaut_et_description(client, auth_headers, db):
    db.add(Setting(key="max_service_hours", value=10.0, description="x"))
    await db.flush()
    response = await client.get("/settings", headers=await auth_headers("fleet"))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == len(DEFAULTS) and body["offset"] == 0
    by_key = {item["key"]: item for item in body["items"]}
    assert set(by_key) == set(DEFAULTS)

    service = by_key["max_service_hours"]
    assert service["value"] == 10.0 and service["default"] == 11.0 and service["is_default"] is False
    assert service["description"] == DEFAULTS["max_service_hours"][1]
    assert service["type"] == "float" and service["min"] == 1 and service["max"] == 24

    untouched = by_key["window_tolerance_min"]  # absente de la table : valeur par défaut
    assert untouched["value"] == 30 and untouched["is_default"] is True and untouched["updated_at"] is None


async def test_lecture_ouverte_a_tous_les_roles_authentifies(client, auth_headers):
    for role in ("dispatcher", "fleet", "supply", "manager", "admin"):
        assert (await client.get("/settings", headers=await auth_headers(role))).status_code == 200
    assert (await client.get("/settings")).status_code == 401


async def test_ecriture_reservee_au_role_admin(client, auth_headers, db):
    for role in ("dispatcher", "fleet", "supply", "manager"):
        response = await client.put(
            "/settings", json={"values": {"max_service_hours": 9}}, headers=await auth_headers(role)
        )
        assert response.status_code == 403
    assert (await client.put("/settings", json={"values": {"max_service_hours": 9}})).status_code == 401
    assert await get_setting(db, "max_service_hours") == 11.0


async def test_mise_a_jour_de_plusieurs_cles_avec_auteur(client, login, db):
    admin, tokens = await login("admin")
    response = await client.put(
        "/settings",
        json={"values": {"max_service_hours": 10, "day_start_time": "05:30", "pdf_logo_url": " "}},
        headers={"Authorization": f"Bearer {tokens['access_token']}"},
    )
    assert response.status_code == 200, response.text
    by_key = {item["key"]: item for item in response.json()["items"]}
    assert by_key["max_service_hours"]["value"] == 10.0
    assert by_key["max_service_hours"]["updated_by"] == str(admin.id)
    assert by_key["max_service_hours"]["updated_by_name"] == admin.full_name
    assert by_key["max_service_hours"]["updated_at"] is not None
    assert by_key["day_start_time"]["value"] == "05:30"
    assert by_key["pdf_logo_url"]["value"] is None

    assert await get_setting(db, "max_service_hours") == 10.0
    params = await settings_store.load_params(db)
    assert params.max_service_s == 10 * 3600


async def test_ecriture_journalisee_dans_l_audit(client, login, db):
    admin, tokens = await login("admin")
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}
    db.add(Setting(key="window_tolerance_min", value=30))
    await db.flush()
    await client.put("/settings", json={"values": {"window_tolerance_min": 45}}, headers=headers)
    # Une valeur inchangée ne produit ni écriture ni ligne d'audit.
    await client.put("/settings", json={"values": {"window_tolerance_min": 45}}, headers=headers)

    entries = (
        (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.table_name == "settings",
                    AuditLog.row_id == "window_tolerance_min",
                    AuditLog.action == "update",
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(entries) == 1
    assert entries[0].actor_id == admin.id
    assert entries[0].before["value"] == 30 and entries[0].after["value"] == 45
    assert entries[0].after["updated_by"] == str(admin.id)


async def test_cle_inconnue_refusee_et_rien_n_est_enregistre(client, auth_headers, db):
    response = await client.put(
        "/settings",
        json={"values": {"max_service_hours": 9, "cle_inventee": 1}},
        headers=await auth_headers("admin"),
    )
    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "validation_error"
    assert body["details"] == [{"field": "cle_inventee", "message": "Paramètre inconnu."}]
    assert await get_setting(db, "max_service_hours") == 11.0  # tout ou rien


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("max_service_hours", "onze"),  # type
        ("max_service_hours", True),
        ("max_service_hours", 0.5),  # borne basse
        ("max_service_hours", 25),  # borne haute
        ("max_service_hours", None),
        ("default_depot_wait_min", 12.5),  # entier attendu
        ("default_depot_wait_min", -1),
        ("default_max_loadings_per_truck_day", 0),
        ("compartment_safety_margin_pct", 51),
        ("partial_delivery_min_pct", 101),
        ("haversine_factor", 0.9),
        ("day_start_time", "25:00"),
        ("day_start_time", "6h"),
        ("day_start_time", 6),
        ("timezone", "Afrique/Douala"),
        ("company_name", ""),
        ("company_name", "x" * 121),
        ("pdf_logo_url", 12),
        ("solver_time_limit_s", 0),
    ],
)
async def test_validation_de_type_et_de_bornes_par_cle(client, auth_headers, db, key, value):
    response = await client.put(
        "/settings", json={"values": {key: value}}, headers=await auth_headers("admin")
    )
    assert response.status_code == 422, response.text
    details = response.json()["details"]
    assert [detail["field"] for detail in details] == [key]
    assert details[0]["message"]
    assert await get_setting(db, key) == DEFAULTS[key][0]


async def test_corps_vide_ou_mal_forme_422(client, auth_headers):
    headers = await auth_headers("admin")
    assert (await client.put("/settings", json={"values": {}}, headers=headers)).status_code == 422
    assert (await client.put("/settings", json={"max_service_hours": 9}, headers=headers)).status_code == 422


def test_chaque_cle_decrite_existe_et_son_defaut_est_valide():
    assert set(SPECS) <= set(DEFAULTS)
    for key, (default, _description) in DEFAULTS.items():
        assert normalize(key, default) == default, key


def test_normalisation_des_valeurs():
    assert normalize("default_depot_wait_min", 60.0) == 60 and isinstance(
        normalize("default_depot_wait_min", 60.0), int
    )
    assert isinstance(normalize("max_service_hours", 10), float)
    assert normalize("company_name", "  OLA  ") == "OLA"
    assert normalize("timezone", "Africa/Lagos") == "Africa/Lagos"
    assert normalize("pdf_logo_url", None) is None


def test_cle_future_sans_description_validee_par_le_type_du_defaut(monkeypatch):
    monkeypatch.setitem(DEFAULTS, "cle_future_entiere", (5, "Paramètre ajouté par un autre lot"))
    monkeypatch.setitem(DEFAULTS, "cle_future_booleenne", (False, "Drapeau"))
    assert spec_for("cle_future_entiere").type == "int"
    assert normalize("cle_future_entiere", 7) == 7
    with pytest.raises(SettingError):
        normalize("cle_future_entiere", "sept")
    assert normalize("cle_future_booleenne", True) is True
    with pytest.raises(SettingError):
        normalize("cle_future_booleenne", 1)
