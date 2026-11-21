"""Accès base de données : moteur async (API) et moteur sync (workers Celery, scripts)."""

import uuid
from collections.abc import AsyncIterator
from datetime import datetime

from sqlalchemy import DateTime, Uuid, create_engine, func
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker
from uuid6 import uuid7

from app.core.config import get_config


class Base(DeclarativeBase):
    """Base déclarative commune à tous les modèles."""


def new_id() -> uuid.UUID:
    """UUID v7 (ordonné dans le temps), généré côté application."""
    return uuid.UUID(bytes=uuid7().bytes)


class IdMixin:
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=new_id)


class TimestampMixin:
    """Colonnes de traçabilité présentes partout. Les heures sont stockées en UTC (RM-20)."""

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    # Renseigné automatiquement depuis l'utilisateur courant (voir app.audit.listener).
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)


class SoftDeleteMixin:
    """Suppression logique des référentiels : filtrer `deleted_at IS NULL` dans les lectures."""

    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


_config = get_config()

async_engine = create_async_engine(_config.database_url, pool_pre_ping=True)
async_session_factory = async_sessionmaker(async_engine, expire_on_commit=False)

# Moteur synchrone : même URL (psycopg 3 gère les deux modes). Pour Celery et les scripts.
sync_engine = create_engine(_config.database_url, pool_pre_ping=True)
sync_session_factory = sessionmaker(sync_engine, expire_on_commit=False)


async def get_session() -> AsyncIterator[AsyncSession]:
    """Dépendance FastAPI : une session par requête, commit à la fin si tout s'est bien passé."""
    async with async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
