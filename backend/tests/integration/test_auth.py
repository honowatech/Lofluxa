"""Authentification et contrôle de rôle."""

from fastapi import APIRouter, Depends

from app.core.deps import require_roles
from app.core.enums import Role


async def test_login_puis_me(client, make_user):
    await make_user(Role.DISPATCHER, email="disp@tourneo-test.cm", password="secret-123")
    response = await client.post(
        "/auth/login", json={"email": "disp@tourneo-test.cm", "password": "secret-123"}
    )
    assert response.status_code == 200, response.text
    tokens = response.json()

    me = await client.get("/me", headers={"Authorization": f"Bearer {tokens['access_token']}"})
    assert me.status_code == 200
    assert me.json()["role"] == "dispatcher"

    refreshed = await client.post("/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert refreshed.status_code == 200
    assert refreshed.json()["access_token"]


async def test_mauvais_mot_de_passe_renvoie_l_enveloppe_d_erreur(client, make_user):
    await make_user(Role.FLEET, email="fleet@tourneo-test.cm")
    response = await client.post("/auth/login", json={"email": "fleet@tourneo-test.cm", "password": "faux"})
    assert response.status_code == 401
    assert response.json() == {
        "code": "invalid_credentials",
        "message": "E-mail ou mot de passe incorrect.",
        "details": [],
    }


async def test_sans_jeton_401(client):
    response = await client.get("/me")
    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"


async def test_jeton_de_rafraichissement_refuse_comme_jeton_d_acces(client, make_user):
    await make_user(Role.SUPPLY, email="supply@tourneo-test.cm")
    tokens = (
        await client.post("/auth/login", json={"email": "supply@tourneo-test.cm", "password": "secret-123"})
    ).json()
    response = await client.get("/me", headers={"Authorization": f"Bearer {tokens['refresh_token']}"})
    assert response.status_code == 401


async def test_require_roles_admin_passe_partout(client, auth_headers):
    from app.main import app_instance

    router = APIRouter()

    @router.get("/_test/fleet-only", dependencies=[Depends(require_roles(Role.FLEET))])
    async def _fleet_only() -> dict[str, bool]:
        return {"ok": True}

    app_instance.include_router(router, prefix="/api/v1")
    assert (await client.get("/_test/fleet-only", headers=await auth_headers("fleet"))).status_code == 200
    assert (await client.get("/_test/fleet-only", headers=await auth_headers("admin"))).status_code == 200
    refused = await client.get("/_test/fleet-only", headers=await auth_headers("manager"))
    assert refused.status_code == 403
    assert refused.json()["code"] == "forbidden"


async def test_health(client):
    assert (await client.get("/health")).json() == {"status": "ok"}
