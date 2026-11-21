"""Outillage des tests du lot L8 : Redis simulé en mémoire (tests déterministes, sans dépendance externe)."""

import fnmatch
from collections.abc import Callable

import pytest
from redis.exceptions import ConnectionError as RedisConnectionError

from app.auth import revocation
from app.auth.hardening import limiter
from app.core.config import get_config


class FakeRedis:
    """Sous-ensemble de l'API asynchrone de Redis utilisé par la révocation."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.ttl: dict[str, int] = {}
        self.down = False

    def _check(self) -> None:
        if self.down:
            raise RedisConnectionError("Redis indisponible (simulé)")

    async def set(self, key: str, value: str, ex: int | None = None) -> bool:
        self._check()
        self.store[key] = value
        if ex is not None:
            self.ttl[key] = ex
        return True

    async def mget(self, *keys: str) -> list[str | None]:
        self._check()
        return [self.store.get(key) for key in keys]

    async def ping(self) -> bool:
        self._check()
        return True

    def keys(self, pattern: str) -> list[str]:
        return [key for key in self.store if fnmatch.fnmatch(key, pattern)]


@pytest.fixture(autouse=True)
def fake_redis(monkeypatch: pytest.MonkeyPatch) -> FakeRedis:
    fake = FakeRedis()
    revocation.reset_state()
    monkeypatch.setattr(revocation, "get_redis", lambda: fake)
    yield fake
    revocation.reset_state()


@pytest.fixture
def rate_limits(monkeypatch: pytest.MonkeyPatch) -> Callable[..., None]:
    """Active la limitation de débit (inactive en test) avec les seuils voulus."""

    def _enable(*, login: str | None = None, auth: str | None = None) -> None:
        config = get_config()
        if login:
            monkeypatch.setattr(config, "rate_limit_login", login)
        if auth:
            monkeypatch.setattr(config, "rate_limit_auth", auth)
        limiter.reset()
        limiter.enabled = True

    yield _enable
    limiter.enabled = False
    limiter.reset()


@pytest.fixture
async def make_user(make_user, db) -> Callable:
    """Comme la fixture commune, mais valide aussitôt le compte dans la transaction du test : le client de
    test annule (`rollback`) tout ce qui n'a pas été validé dès qu'une requête se termine en erreur."""

    async def _make(*args, **kwargs):
        user = await make_user(*args, **kwargs)
        await db.commit()
        return user

    return _make


@pytest.fixture
async def login(client, make_user) -> Callable:
    """Crée un compte et le connecte : `user, tokens = await login("fleet")`."""

    async def _login(role: str = "dispatcher", email: str | None = None, password: str = "secret-123"):
        user = await make_user(role, email=email or f"{role}-l8@tourneo-test.cm", password=password)
        response = await client.post("/auth/login", json={"email": user.email, "password": password})
        assert response.status_code == 200, response.text
        return user, response.json()

    return _login


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}
