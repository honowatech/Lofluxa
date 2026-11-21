"""Durcissement de l'authentification (spec §8.5) : limitation de débit, révocation, rotation,
configuration de production, CORS."""

import uuid

import pytest
from fastapi import FastAPI
from jose import jwt

from app.auth import revocation
from app.auth.hardening import (
    InsecureConfigError,
    assert_production_ready,
    install_security,
    limiter,
    production_config_errors,
)
from app.core.config import Config, get_config
from app.core.security import ACCESS, REFRESH, create_token, decode_token
from app.core.time import utcnow

from .conftest import bearer

STRONG_SECRET = "s3cret-" + "x" * 40


def _token(user_id: uuid.UUID, token_type: str = ACCESS, *, age_s: int = 0, role: str = "dispatcher") -> str:
    """Jeton signé comme ceux de l'API, émis il y a `age_s` secondes."""
    config = get_config()
    issued = int(utcnow().timestamp()) - age_s
    payload = {
        "sub": str(user_id),
        "role": role,
        "type": token_type,
        "jti": uuid.uuid4().hex,
        "iat": issued,
        "exp": issued + 3600,
    }
    return jwt.encode(payload, config.jwt_secret, algorithm=config.jwt_algorithm)


# --- Limitation de débit ----------------------------------------------------------------------------


async def test_limitation_de_debit_sur_la_connexion(client, make_user, rate_limits):
    await make_user("dispatcher", email="cible@tourneo-test.cm")
    rate_limits(login="3/minute")
    credentials = {"email": "cible@tourneo-test.cm", "password": "mauvais"}
    for _ in range(3):
        assert (await client.post("/auth/login", json=credentials)).status_code == 401
    blocked = await client.post("/auth/login", json=credentials)
    assert blocked.status_code == 429
    assert blocked.json() == {
        "code": "rate_limited",
        "message": "Trop de tentatives. Réessayez dans quelques instants.",
        "details": [],
    }
    assert blocked.headers["Retry-After"] == "60"
    # Même le bon mot de passe est refusé tant que la fenêtre n'est pas écoulée.
    good = await client.post("/auth/login", json={"email": "cible@tourneo-test.cm", "password": "secret-123"})
    assert good.status_code == 429


async def test_limitation_de_debit_sur_les_autres_routes_d_authentification(client, login, rate_limits):
    _user, tokens = await login("fleet")
    rate_limits(auth="2/minute")
    for _ in range(2):
        assert (await client.post("/auth/refresh", json={"refresh_token": "illisible"})).status_code == 401
    assert (await client.post("/auth/refresh", json={"refresh_token": "illisible"})).status_code == 429
    # Chaque route a son propre compteur.
    assert (await client.post("/auth/logout", headers=bearer(tokens["access_token"]))).status_code == 204
    # Les routes hors authentification ne sont pas limitées.
    for _ in range(5):
        assert (await client.get("/health")).status_code == 200


async def test_limitation_inactive_par_defaut_en_test(client, make_user):
    assert get_config().env == "test" and limiter.enabled is False
    await make_user("dispatcher", email="libre@tourneo-test.cm")
    for _ in range(15):
        response = await client.post(
            "/auth/login", json={"email": "libre@tourneo-test.cm", "password": "faux"}
        )
        assert response.status_code == 401


# --- Révocation à la déconnexion --------------------------------------------------------------------


async def test_deconnexion_revoque_le_jeton_d_acces(client, login, fake_redis):
    _user, tokens = await login("dispatcher")
    headers = bearer(tokens["access_token"])
    assert (await client.get("/me", headers=headers)).status_code == 200

    assert (await client.post("/auth/logout", headers=headers)).status_code == 204
    refused = await client.get("/me", headers=headers)
    assert refused.status_code == 401
    assert refused.json()["code"] == "token_revoked"

    jti = decode_token(tokens["access_token"], ACCESS)["jti"]
    key = f"tourneo:test:auth:jti:{jti}"
    assert fake_redis.store[key] == "1"
    assert 0 < fake_redis.ttl[key] <= get_config().access_token_minutes * 60  # oublié à l'expiration du jeton


async def test_deconnexion_revoque_aussi_le_jeton_de_rafraichissement_fourni(client, login):
    _user, tokens = await login("dispatcher")
    response = await client.post(
        "/auth/logout",
        json={"refresh_token": tokens["refresh_token"]},
        headers=bearer(tokens["access_token"]),
    )
    assert response.status_code == 204
    refused = await client.post("/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert refused.status_code == 401
    assert refused.json()["code"] == "token_revoked"


async def test_deconnexion_ne_revoque_pas_le_jeton_d_un_autre_utilisateur(client, login):
    _alice, alice_tokens = await login("dispatcher", email="alice-l8@tourneo-test.cm")
    _bob, bob_tokens = await login("fleet", email="bob-l8@tourneo-test.cm")
    response = await client.post(
        "/auth/logout",
        json={"refresh_token": bob_tokens["refresh_token"]},
        headers=bearer(alice_tokens["access_token"]),
    )
    assert response.status_code == 204
    still_valid = await client.post("/auth/refresh", json={"refresh_token": bob_tokens["refresh_token"]})
    assert still_valid.status_code == 200


async def test_deconnexion_sans_jeton_401_et_jeton_de_rafraichissement_illisible_ignore(client, login):
    assert (await client.post("/auth/logout")).status_code == 401
    _user, tokens = await login("dispatcher")
    response = await client.post(
        "/auth/logout", json={"refresh_token": "pas-un-jeton"}, headers=bearer(tokens["access_token"])
    )
    assert response.status_code == 204


# --- Rotation du jeton de rafraîchissement ----------------------------------------------------------


async def test_rotation_du_jeton_de_rafraichissement(client, login):
    _user, tokens = await login("supply")
    first = await client.post("/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert first.status_code == 200
    renewed = first.json()
    assert renewed["refresh_token"] != tokens["refresh_token"]
    assert renewed["access_token"] != tokens["access_token"]

    # L'ancien jeton de rafraîchissement ne sert qu'une fois.
    replay = await client.post("/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert replay.status_code == 401 and replay.json()["code"] == "token_revoked"

    # Le nouveau fonctionne, ainsi que le nouveau jeton d'accès.
    assert (await client.get("/me", headers=bearer(renewed["access_token"]))).status_code == 200
    second = await client.post("/auth/refresh", json={"refresh_token": renewed["refresh_token"]})
    assert second.status_code == 200


async def test_jeton_d_acces_refuse_comme_jeton_de_rafraichissement(client, login):
    _user, tokens = await login("supply")
    response = await client.post("/auth/refresh", json={"refresh_token": tokens["access_token"]})
    assert response.status_code == 401 and response.json()["code"] == "invalid_token"


# --- Coupure des sessions d'un utilisateur ----------------------------------------------------------


async def test_reinitialisation_par_l_admin_ferme_les_sessions_ouvertes(client, auth_headers, make_user):
    user = await make_user("dispatcher", email="victime@tourneo-test.cm")
    user_id = user.id
    old_access = _token(user_id, ACCESS, age_s=120)
    old_refresh = _token(user_id, REFRESH, age_s=120)
    assert (await client.get("/me", headers=bearer(old_access))).status_code == 200

    reset = await client.post(
        f"/users/{user_id}/reset-password",
        json={"password": "nouveau-secret-42"},
        headers=await auth_headers("admin"),
    )
    assert reset.status_code == 204
    assert (await client.get("/me", headers=bearer(old_access))).status_code == 401
    assert (await client.post("/auth/refresh", json={"refresh_token": old_refresh})).status_code == 401

    fresh = await client.post(
        "/auth/login", json={"email": "victime@tourneo-test.cm", "password": "nouveau-secret-42"}
    )
    assert fresh.status_code == 200
    assert (await client.get("/me", headers=bearer(fresh.json()["access_token"]))).status_code == 200


async def test_coupure_n_affecte_pas_les_autres_utilisateurs(client, make_user):
    alice = await make_user("dispatcher", email="alice-c@tourneo-test.cm")
    bob = await make_user("fleet", email="bob-c@tourneo-test.cm")
    alice_token, bob_token = _token(alice.id, age_s=60), _token(bob.id, age_s=60, role="fleet")
    assert await revocation.revoke_user_tokens(alice.id) is True
    assert (await client.get("/me", headers=bearer(bob_token))).status_code == 200
    assert (await client.get("/me", headers=bearer(alice_token))).status_code == 401


# --- Changement de son propre mot de passe ----------------------------------------------------------


async def test_changement_de_son_propre_mot_de_passe_pour_tout_role(client, login):
    for role in ("dispatcher", "fleet", "supply", "manager", "admin"):
        user, tokens = await login(role)
        email = user.email
        response = await client.put(
            "/me/password",
            json={"current_password": "secret-123", "new_password": f"nouveau-{role}-42"},
            headers=bearer(tokens["access_token"]),
        )
        assert response.status_code == 200, response.text
        renewed = response.json()
        # La session en cours continue avec la nouvelle paire ; l'ancien jeton d'accès est révoqué.
        assert (await client.get("/me", headers=bearer(renewed["access_token"]))).status_code == 200
        assert (await client.get("/me", headers=bearer(tokens["access_token"]))).status_code == 401
        old = await client.post("/auth/login", json={"email": email, "password": "secret-123"})
        assert old.status_code == 401
        new = await client.post("/auth/login", json={"email": email, "password": f"nouveau-{role}-42"})
        assert new.status_code == 200


async def test_changement_de_mot_de_passe_ferme_les_autres_sessions(client, login):
    user, tokens = await login("dispatcher")
    other_device = _token(user.id, REFRESH, age_s=300)
    response = await client.put(
        "/me/password",
        json={"current_password": "secret-123", "new_password": "nouveau-secret-42"},
        headers=bearer(tokens["access_token"]),
    )
    assert response.status_code == 200
    assert (await client.post("/auth/refresh", json={"refresh_token": other_device})).status_code == 401


async def test_changement_de_mot_de_passe_refuse(client, login):
    _user, tokens = await login("dispatcher")
    headers = bearer(tokens["access_token"])
    wrong = await client.put(
        "/me/password",
        json={"current_password": "faux", "new_password": "nouveau-secret-42"},
        headers=headers,
    )
    assert wrong.status_code == 400 and wrong.json()["code"] == "invalid_current_password"
    short = await client.put(
        "/me/password", json={"current_password": "secret-123", "new_password": "court"}, headers=headers
    )
    assert short.status_code == 422 and short.json()["details"][0]["field"] == "new_password"
    same = await client.put(
        "/me/password", json={"current_password": "secret-123", "new_password": "secret-123"}, headers=headers
    )
    assert same.status_code == 422
    assert (
        await client.put("/me/password", json={"current_password": "a", "new_password": "b"})
    ).status_code == 401
    # Rien n'a changé : le jeton et le mot de passe restent valables.
    assert (await client.get("/me", headers=headers)).status_code == 200


# --- Dégradation si Redis est indisponible ----------------------------------------------------------


async def test_redis_indisponible_l_authentification_continue(client, login, fake_redis):
    _user, tokens = await login("dispatcher")
    headers = bearer(tokens["access_token"])
    fake_redis.down = True

    assert (await client.get("/me", headers=headers)).status_code == 200
    # La déconnexion répond normalement même si la révocation n'a pas pu être enregistrée.
    assert (await client.post("/auth/logout", headers=headers)).status_code == 204
    refreshed = await client.post("/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert refreshed.status_code == 200
    health = await client.get("/health")
    assert health.status_code == 200
    assert health.json() == {"status": "degrade", "checks": {"database": "ok", "redis": "indisponible"}}


async def test_redis_indisponible_mise_en_veille_puis_reprise(fake_redis, monkeypatch):
    claims = {"jti": "abc", "sub": str(uuid.uuid4()), "iat": 0, "exp": int(utcnow().timestamp()) + 600}
    calls = {"n": 0}
    original = fake_redis.mget

    async def counting_mget(*keys):
        calls["n"] += 1
        return await original(*keys)

    monkeypatch.setattr(fake_redis, "mget", counting_mget)
    fake_redis.down = True
    assert await revocation.is_token_revoked(claims) is False
    assert await revocation.is_token_revoked(claims) is False  # Redis n'est plus sollicité
    assert await revocation.revoke_token(claims) is False
    assert calls["n"] == 1

    fake_redis.down = False
    monkeypatch.setattr(revocation, "_down_until", 0.0)  # délai de mise en veille écoulé
    assert await revocation.revoke_token(claims) is True
    assert await revocation.is_token_revoked(claims) is True
    assert calls["n"] == 2


async def test_revocation_d_un_jeton_deja_expire_sans_ecriture(fake_redis):
    claims = {"jti": "vieux", "sub": "x", "exp": int(utcnow().timestamp()) - 10}
    assert await revocation.revoke_token(claims) is True
    assert fake_redis.store == {}


async def test_revocation_avec_le_vrai_redis(monkeypatch):
    """Passe par le vrai Redis local quand il répond (ignoré sinon)."""
    monkeypatch.undo()  # retire le Redis simulé
    revocation.reset_state()
    try:
        if not await revocation.ping():
            pytest.skip("Redis local indisponible")
        user_id = uuid.uuid4()
        token = create_token(user_id, "dispatcher", ACCESS)
        claims = decode_token(token, ACCESS)
        assert await revocation.is_token_revoked(claims) is False
        assert await revocation.revoke_token(claims) is True
        assert await revocation.is_token_revoked(claims) is True
        ttl = await revocation.get_redis().ttl(f"tourneo:test:auth:jti:{claims['jti']}")
        assert 0 < ttl <= get_config().access_token_minutes * 60

        other = decode_token(create_token(user_id, "dispatcher", REFRESH), REFRESH)
        assert await revocation.is_token_revoked(other) is False
        old = {**other, "jti": uuid.uuid4().hex, "iat": other["iat"] - 100}
        assert await revocation.revoke_user_tokens(user_id) is True
        assert await revocation.is_token_revoked(old) is True
    finally:
        await revocation.get_redis().aclose()
        revocation.reset_state()


async def test_redis_injoignable_degradation_reelle(monkeypatch):
    """Vrai client Redis pointé vers un port fermé : pas d'exception, contrôle ignoré."""
    monkeypatch.undo()
    revocation.reset_state()
    monkeypatch.setattr(get_config(), "redis_url", "redis://127.0.0.1:1/0")
    try:
        claims = {"jti": "x", "sub": "y", "iat": 0, "exp": int(utcnow().timestamp()) + 60}
        assert await revocation.is_token_revoked(claims) is False
        assert await revocation.revoke_token(claims) is False
        assert await revocation.ping() is False
    finally:
        await revocation.get_redis().aclose()
        monkeypatch.undo()
        revocation.reset_state()


# --- Configuration de production --------------------------------------------------------------------


def _prod(**overrides) -> Config:
    values = {
        "env": "prod",
        "jwt_secret": STRONG_SECRET,
        "admin_password": "un-vrai-mot-de-passe",
        "cors_origins": ["https://tourneo.example.cm"],
    }
    return Config(**{**values, **overrides})


def test_refus_de_demarrer_en_prod_avec_le_secret_jwt_par_defaut():
    config = _prod(jwt_secret="change-me-in-production")
    with pytest.raises(InsecureConfigError, match="TOURNEO_JWT_SECRET"):
        assert_production_ready(config)
    with pytest.raises(InsecureConfigError):
        install_security(FastAPI(), config)  # l'application ne se construit pas


def test_refus_en_prod_secret_court_mot_de_passe_admin_par_defaut_cors_ouvert():
    assert "32 caractères" in production_config_errors(_prod(jwt_secret="trop-court"))[0]
    assert "TOURNEO_ADMIN_PASSWORD" in production_config_errors(_prod(admin_password="admin-dev-only"))[0]
    assert "TOURNEO_CORS_ORIGINS" in production_config_errors(_prod(cors_origins=["*"]))[0]
    assert "TOURNEO_CORS_ORIGINS" in production_config_errors(_prod(cors_origins=[]))[0]


def test_configuration_de_production_correcte_acceptee_et_dev_tolerant():
    assert production_config_errors(_prod()) == []
    install_security(FastAPI(), _prod())
    # Hors production, la configuration par défaut reste utilisable (développement, tests).
    assert production_config_errors(Config(env="dev", jwt_secret="change-me-in-production")) == []


def test_controle_avant_demarrage_refuse_une_configuration_dangereuse(monkeypatch, capsys):
    from app.admin import preflight

    monkeypatch.setattr(preflight, "get_config", lambda: _prod(jwt_secret="change-me-in-production"))
    assert preflight.main([]) == 2
    assert "TOURNEO_JWT_SECRET" in capsys.readouterr().err

    monkeypatch.setattr(preflight, "get_config", lambda: _prod(database_url=get_config().database_url))
    assert preflight.main(["--timeout", "5"]) == 0

    unreachable = "postgresql+psycopg://tourneo:tourneo@127.0.0.1:1/tourneo?connect_timeout=1"
    monkeypatch.setattr(preflight, "get_config", lambda: _prod(database_url=unreachable))
    assert preflight.main(["--timeout", "0"]) == 3


# --- CORS strict et en-têtes ------------------------------------------------------------------------


async def test_cors_origine_autorisee_seulement(client):
    allowed = get_config().cors_origins[0]
    preflight = await client.options(
        "/auth/login",
        headers={
            "Origin": allowed,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == allowed
    assert "DELETE" in preflight.headers["access-control-allow-methods"]
    assert "*" not in preflight.headers["access-control-allow-methods"]

    foreign = await client.options(
        "/auth/login",
        headers={"Origin": "https://pirate.example", "Access-Control-Request-Method": "POST"},
    )
    assert foreign.status_code == 400
    assert "access-control-allow-origin" not in foreign.headers

    simple = await client.get("/health", headers={"Origin": "https://pirate.example"})
    assert "access-control-allow-origin" not in simple.headers


async def test_cors_en_tete_non_autorise_refuse(client):
    response = await client.options(
        "/me",
        headers={
            "Origin": get_config().cors_origins[0],
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "x-inconnu",
        },
    )
    assert response.status_code == 400


async def test_cors_present_aussi_sur_les_reponses_d_erreur(client):
    allowed = get_config().cors_origins[0]
    response = await client.get("/me", headers={"Origin": allowed})
    assert response.status_code == 401
    assert response.headers["access-control-allow-origin"] == allowed


async def test_en_tetes_de_securite_de_l_api(client, login):
    _user, tokens = await login("dispatcher")
    health = await client.get("/health")
    assert health.headers["x-content-type-options"] == "nosniff"
    assert "cache-control" not in health.headers
    refreshed = await client.post("/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert refreshed.headers["cache-control"] == "no-store"  # réponse contenant des jetons
