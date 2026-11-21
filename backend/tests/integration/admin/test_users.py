"""Gestion des utilisateurs (F9.1)."""

import uuid

from sqlalchemy import select

from app.audit.models import AuditLog
from app.core.config import get_config
from app.core.security import verify_password
from app.users.models import User

NEW_USER = {
    "email": "Nadine.Fleet@OLA-test.cm",
    "full_name": "  Nadine Fleet ",
    "role": "fleet",
    "password": "mot-de-passe-initial",
}


async def test_creation_avec_mot_de_passe_initial_puis_connexion(client, auth_headers, db):
    response = await client.post("/users", json=NEW_USER, headers=await auth_headers("admin"))
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["email"] == "nadine.fleet@ola-test.cm"  # e-mail normalisé en minuscules
    assert body["full_name"] == "Nadine Fleet"
    assert body["role"] == "fleet" and body["active"] is True
    assert "password" not in body and "password_hash" not in body

    stored = await db.get(User, uuid.UUID(body["id"]))
    assert verify_password("mot-de-passe-initial", stored.password_hash)

    login = await client.post(
        "/auth/login", json={"email": "nadine.fleet@ola-test.cm", "password": "mot-de-passe-initial"}
    )
    assert login.status_code == 200


async def test_jamais_de_hachage_dans_les_reponses(client, auth_headers):
    headers = await auth_headers("admin")
    created = (await client.post("/users", json=NEW_USER, headers=headers)).json()
    listing = await client.get("/users", headers=headers)
    detail = await client.get(f"/users/{created['id']}", headers=headers)
    updated = await client.put(f"/users/{created['id']}", json={"full_name": "N. Fleet"}, headers=headers)
    for response in (listing, detail, updated):
        assert response.status_code == 200
        assert "password_hash" not in response.text and "argon2" not in response.text


async def test_email_unique_409(client, auth_headers):
    headers = await auth_headers("admin")
    assert (await client.post("/users", json=NEW_USER, headers=headers)).status_code == 201
    duplicate = await client.post(
        "/users", json={**NEW_USER, "email": "NADINE.fleet@ola-test.cm"}, headers=headers
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["code"] == "email_taken"

    other = (
        await client.post("/users", json={**NEW_USER, "email": "autre@ola-test.cm"}, headers=headers)
    ).json()
    renamed = await client.put(
        f"/users/{other['id']}", json={"email": "nadine.fleet@ola-test.cm"}, headers=headers
    )
    assert renamed.status_code == 409


async def test_mot_de_passe_initial_trop_court_422(client, auth_headers):
    minimum = get_config().password_min_length
    response = await client.post(
        "/users", json={**NEW_USER, "password": "x" * (minimum - 1)}, headers=await auth_headers("admin")
    )
    assert response.status_code == 422
    assert response.json()["details"][0]["field"] == "password"


async def test_role_inconnu_ou_email_invalide_422(client, auth_headers):
    headers = await auth_headers("admin")
    assert (
        await client.post("/users", json={**NEW_USER, "role": "pilote"}, headers=headers)
    ).status_code == 422
    assert (
        await client.post("/users", json={**NEW_USER, "email": "pas-un-email"}, headers=headers)
    ).status_code == 422


async def test_reserve_au_role_admin(client, auth_headers):
    for role in ("dispatcher", "fleet", "supply", "manager"):
        headers = await auth_headers(role)
        assert (await client.get("/users", headers=headers)).status_code == 403
        assert (await client.post("/users", json=NEW_USER, headers=headers)).status_code == 403
        some_id = uuid.uuid4()
        assert (await client.get(f"/users/{some_id}", headers=headers)).status_code == 403
        assert (
            await client.put(f"/users/{some_id}", json={"active": False}, headers=headers)
        ).status_code == 403
        assert (await client.delete(f"/users/{some_id}", headers=headers)).status_code == 403
        reset = await client.post(
            f"/users/{some_id}/reset-password", json={"password": "nouveau-secret"}, headers=headers
        )
        assert reset.status_code == 403
    assert (await client.get("/users")).status_code == 401


async def test_liste_paginee_et_filtres(client, auth_headers, make_user):
    headers = await auth_headers("admin")
    await make_user("fleet", email="awa@tourneo-test.cm")
    await make_user("fleet", email="bob@tourneo-test.cm")
    inactive = await make_user("supply", email="carl@tourneo-test.cm")
    inactive.active = False

    page = (await client.get("/users", params={"limit": 2}, headers=headers)).json()
    assert page["total"] == 4 and len(page["items"]) == 2 and page["limit"] == 2 and page["offset"] == 0

    fleet = (await client.get("/users", params={"role": "fleet"}, headers=headers)).json()
    assert {item["email"] for item in fleet["items"]} == {"awa@tourneo-test.cm", "bob@tourneo-test.cm"}

    disabled = (await client.get("/users", params={"active": "false"}, headers=headers)).json()
    assert [item["email"] for item in disabled["items"]] == ["carl@tourneo-test.cm"]

    found = (await client.get("/users", params={"q": "AWA"}, headers=headers)).json()
    assert [item["email"] for item in found["items"]] == ["awa@tourneo-test.cm"]


async def test_utilisateur_inconnu_404(client, auth_headers):
    headers = await auth_headers("admin")
    missing = uuid.uuid4()
    assert (await client.get(f"/users/{missing}", headers=headers)).status_code == 404
    assert (await client.put(f"/users/{missing}", json={"role": "fleet"}, headers=headers)).status_code == 404
    assert (await client.delete(f"/users/{missing}", headers=headers)).status_code == 404


async def test_changement_de_role(client, auth_headers, make_user):
    headers = await auth_headers("admin")
    user = await make_user("fleet", email="promu@tourneo-test.cm")
    for method in (client.put, client.patch):
        role = "dispatcher" if method is client.put else "supply"
        response = await method(f"/users/{user.id}", json={"role": role}, headers=headers)
        assert response.status_code == 200, response.text
        assert response.json()["role"] == role

    login = await client.post("/auth/login", json={"email": user.email, "password": "secret-123"})
    me = await client.get("/me", headers={"Authorization": f"Bearer {login.json()['access_token']}"})
    assert me.json()["role"] == "supply"


async def test_desactivation_puis_reactivation(client, auth_headers, login):
    headers = await auth_headers("admin")
    user, tokens = await login("fleet")
    user_id, email = user.id, user.email  # une réponse en erreur expire les objets de la session de test
    user_headers = {"Authorization": f"Bearer {tokens['access_token']}"}
    assert (await client.get("/me", headers=user_headers)).status_code == 200

    off = await client.put(f"/users/{user_id}", json={"active": False}, headers=headers)
    assert off.status_code == 200 and off.json()["active"] is False
    # Le compte désactivé perd immédiatement tout accès : jeton en cours, rafraîchissement, connexion.
    assert (await client.get("/me", headers=user_headers)).status_code == 401
    refused = await client.post("/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert refused.status_code == 401
    relogin = await client.post("/auth/login", json={"email": email, "password": "secret-123"})
    assert relogin.status_code == 401

    on = await client.post(f"/users/{user_id}/activate", headers=headers)
    assert on.status_code == 200 and on.json()["active"] is True
    relogin = await client.post("/auth/login", json={"email": email, "password": "secret-123"})
    assert relogin.status_code == 200


async def test_on_ne_supprime_pas_un_compte_on_le_desactive(client, auth_headers, make_user, db):
    headers = await auth_headers("admin")
    user = await make_user("supply", email="partant@tourneo-test.cm")
    response = await client.delete(f"/users/{user.id}", headers=headers)
    assert response.status_code == 204

    still_there = (await db.execute(select(User).where(User.id == user.id))).scalar_one()
    assert still_there.active is False
    detail = await client.get(f"/users/{user.id}", headers=headers)
    assert detail.status_code == 200 and detail.json()["active"] is False

    again = await client.post(f"/users/{user.id}/deactivate", headers=headers)
    assert again.status_code == 200 and again.json()["active"] is False


async def test_un_admin_ne_peut_pas_se_desactiver_lui_meme(client, login):
    admin, tokens = await login("admin")
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}
    for response in (
        await client.put(f"/users/{admin.id}", json={"active": False}, headers=headers),
        await client.delete(f"/users/{admin.id}", headers=headers),
        await client.post(f"/users/{admin.id}/deactivate", headers=headers),
    ):
        assert response.status_code == 409
        assert response.json()["code"] == "self_deactivation"
    assert (await client.get("/me", headers=headers)).status_code == 200


async def test_un_admin_ne_peut_pas_changer_son_propre_role(client, login):
    admin, tokens = await login("admin")
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}
    response = await client.put(f"/users/{admin.id}", json={"role": "manager"}, headers=headers)
    assert response.status_code == 409 and response.json()["code"] == "self_role_change"
    # Modifier son propre nom reste permis.
    renamed = await client.put(f"/users/{admin.id}", json={"full_name": "Admin Renommé"}, headers=headers)
    assert renamed.status_code == 200 and renamed.json()["full_name"] == "Admin Renommé"


async def test_reinitialisation_du_mot_de_passe(client, auth_headers, login):
    headers = await auth_headers("admin")
    user, _tokens = await login("dispatcher")
    user_id, email = user.id, user.email

    too_short = await client.post(
        f"/users/{user_id}/reset-password", json={"password": "abc"}, headers=headers
    )
    assert too_short.status_code == 422

    response = await client.post(
        f"/users/{user_id}/reset-password", json={"password": "nouveau-secret-42"}, headers=headers
    )
    assert response.status_code == 204
    old = await client.post("/auth/login", json={"email": email, "password": "secret-123"})
    assert old.status_code == 401
    new = await client.post("/auth/login", json={"email": email, "password": "nouveau-secret-42"})
    assert new.status_code == 200


async def test_reinitialisation_de_son_propre_compte_refusee(client, login):
    admin, tokens = await login("admin")
    response = await client.post(
        f"/users/{admin.id}/reset-password",
        json={"password": "nouveau-secret-42"},
        headers={"Authorization": f"Bearer {tokens['access_token']}"},
    )
    assert response.status_code == 409 and response.json()["code"] == "self_password_reset"


async def test_operations_tracees_dans_le_journal_sans_mot_de_passe(client, login, db):
    admin, tokens = await login("admin")
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}
    created = (await client.post("/users", json=NEW_USER, headers=headers)).json()
    await client.put(f"/users/{created['id']}", json={"role": "supply"}, headers=headers)
    await client.post(
        f"/users/{created['id']}/reset-password", json={"password": "nouveau-secret-42"}, headers=headers
    )

    entries = (
        (
            await db.execute(
                select(AuditLog)
                .where(AuditLog.table_name == "users", AuditLog.row_id == created["id"])
                .order_by(AuditLog.id)
            )
        )
        .scalars()
        .all()
    )
    assert [entry.action for entry in entries] == ["insert", "update", "update"]
    assert all(entry.actor_id == admin.id for entry in entries)
    assert entries[1].before == {"role": "fleet"} and entries[1].after == {"role": "supply"}
    dumped = " ".join(str(entry.before) + str(entry.after) for entry in entries)
    assert (
        "argon2" not in dumped and "mot-de-passe-initial" not in dumped and "nouveau-secret-42" not in dumped
    )
