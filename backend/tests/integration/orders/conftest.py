"""Outillage propre aux tests du lot L4."""

from collections.abc import Callable

import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession


@pytest_asyncio.fixture
async def auth_headers(auth_headers: Callable, db: AsyncSession) -> Callable:
    """Comme la fixture commune, mais l'utilisateur est validé : une requête en erreur annule la
    session du test et ferait sinon disparaître le compte (401 aux requêtes suivantes)."""

    async def _headers(role: str = "dispatcher") -> dict[str, str]:
        headers = await auth_headers(role)
        await db.commit()
        return headers

    return _headers
