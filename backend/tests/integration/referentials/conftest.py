"""Fixtures locales aux tests des référentiels et des imports.

Le client de test annule la session dès qu'une requête se termine en erreur (4xx levée par l'application),
ce qui efface aussi les données posées par les fixtures (utilisateurs, produits) et non encore validées.
Ces surcharges valident donc les données de fixture (dans la transaction du test, toujours annulée à la
fin) pour qu'un test puisse enchaîner plusieurs requêtes après une réponse d'erreur.
"""

from collections.abc import Callable

import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession


@pytest_asyncio.fixture
async def auth_headers(auth_headers: Callable, db: AsyncSession) -> Callable:
    async def _headers(role: str = "dispatcher") -> dict[str, str]:
        headers = await auth_headers(role)
        await db.commit()
        return headers

    return _headers


@pytest_asyncio.fixture
async def products(products: dict, db: AsyncSession) -> dict:
    await db.commit()
    for product in products.values():
        db.expunge(product)  # détachés : leurs attributs restent lisibles après une annulation
    return products
