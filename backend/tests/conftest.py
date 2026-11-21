"""Outillage de test commun.

- Base dédiée `tourneo_test` (PostgreSQL + PostGIS réels, créée par scripts/dev_setup.sh).
- Chaque test s'exécute dans une transaction annulée à la fin : aucune donnée ne persiste.
- `client` : client HTTP branché sur l'application, partageant la session `db` du test.
- `auth_headers("dispatcher")` : en-têtes d'un utilisateur du rôle voulu.

Attention : une tâche Celery ouvre sa propre connexion et ne voit pas la transaction du test.
Tester la fonction métier appelée par la tâche, en lui passant la session `db`.
Les tests unitaires purs (règles, moteur, conversion) n'ont besoin d'aucune de ces fixtures.
"""

import os

os.environ["TOURNEO_ENV"] = "test"
os.environ["TOURNEO_DATABASE_URL"] = os.environ.get(
    "TOURNEO_TEST_DATABASE_URL", "postgresql+psycopg://tourneo:tourneo@localhost:5432/tourneo_test"
)
os.environ["TOURNEO_CELERY_ALWAYS_EAGER"] = "true"

from collections.abc import AsyncIterator, Callable  # noqa: E402
from decimal import Decimal  # noqa: E402

import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: E402

import app.models  # noqa: E402, F401
from app.core.db import Base, async_engine, get_session, sync_engine  # noqa: E402
from app.core.enums import Role  # noqa: E402
from app.core.security import ACCESS, create_token, hash_password  # noqa: E402
from app.main import app_instance  # noqa: E402
from app.referentials.models import Product  # noqa: E402
from app.users.models import User  # noqa: E402


@pytest.fixture(scope="session")
def _schema() -> None:
    """Recrée le schéma de la base de test une fois par session de tests."""
    with sync_engine.begin() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
    Base.metadata.drop_all(sync_engine)
    Base.metadata.create_all(sync_engine)
    yield
    sync_engine.dispose()


@pytest_asyncio.fixture
async def db(_schema: None) -> AsyncIterator[AsyncSession]:
    """Session de test : tout est annulé à la fin du test."""
    async with async_engine.connect() as connection:
        transaction = await connection.begin()
        session = AsyncSession(
            bind=connection, expire_on_commit=False, join_transaction_mode="create_savepoint"
        )
        try:
            yield session
        finally:
            await session.close()
            await transaction.rollback()


@pytest_asyncio.fixture
async def client(db: AsyncSession) -> AsyncIterator[AsyncClient]:
    async def _session_override() -> AsyncIterator[AsyncSession]:
        # Chaque requête s'exécute dans son propre point de sauvegarde : une requête en erreur
        # n'annule que ses propres écritures, pas le jeu de données préparé par le test.
        savepoint = await db.begin_nested()
        try:
            yield db
            await db.flush()
            if savepoint.is_active:
                await savepoint.commit()
        except Exception:
            if savepoint.is_active:
                await savepoint.rollback()
            raise

    app_instance.dependency_overrides[get_session] = _session_override
    transport = ASGITransport(app=app_instance)
    async with AsyncClient(transport=transport, base_url="http://test/api/v1") as http:
        yield http
    app_instance.dependency_overrides.clear()


@pytest_asyncio.fixture
async def make_user(db: AsyncSession) -> Callable:
    async def _make(
        role: Role | str = Role.DISPATCHER, email: str | None = None, password: str = "secret-123"
    ) -> User:
        role = Role(role)
        user = User(
            email=email or f"{role.value}@tourneo-test.cm",
            password_hash=hash_password(password),
            full_name=f"Test {role.value}",
            role=role,
        )
        db.add(user)
        await db.flush()
        return user

    return _make


@pytest_asyncio.fixture
async def auth_headers(make_user: Callable) -> Callable:
    """`await auth_headers("fleet")` → {"Authorization": "Bearer …"} pour un utilisateur de ce rôle."""
    cache: dict[str, dict[str, str]] = {}

    async def _headers(role: Role | str = Role.DISPATCHER) -> dict[str, str]:
        role = Role(role)
        if role.value not in cache:
            user = await make_user(role)
            cache[role.value] = {"Authorization": f"Bearer {create_token(user.id, role.value, ACCESS)}"}
        return cache[role.value]

    return _headers


@pytest_asyncio.fixture
async def products(db: AsyncSession) -> dict[str, Product]:
    """Les trois produits du MVP, indexés par code."""
    rows = {
        "SUPER": Product(
            code="SUPER", label="Super", ref_density_15=Decimal("0.7450"), thermal_coeff=Decimal("0.001200")
        ),
        "GASOIL": Product(
            code="GASOIL", label="Gasoil", ref_density_15=Decimal("0.8450"), thermal_coeff=Decimal("0.000850")
        ),
        "PETROLE": Product(
            code="PETROLE",
            label="Pétrole lampant",
            ref_density_15=Decimal("0.8000"),
            thermal_coeff=Decimal("0.000950"),
        ),
    }
    db.add_all(rows.values())
    await db.flush()
    return rows
