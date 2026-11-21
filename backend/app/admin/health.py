"""Contrôles de santé : base de données, Redis, serveur OSRM.

Volontairement indépendant du moteur de tournées : un simple appel HTTP au serveur OSRM configuré.
"""

import httpx
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import revocation
from app.core.config import get_config

OK = "ok"
DOWN = "indisponible"
DEGRADED = "degrade"

# Point de référence pour interroger OSRM : centre de Douala (longitude, latitude).
OSRM_PROBE_LON_LAT = (9.7043, 4.0483)


async def check_database(session: AsyncSession) -> bool:
    try:
        await session.execute(text("SELECT 1"))
    except (SQLAlchemyError, OSError):
        return False
    return True


async def check_redis() -> bool:
    return await revocation.ping()


def osrm_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=get_config().osrm_health_timeout_s)


async def check_osrm() -> tuple[bool, str | None]:
    """(disponible, détail en cas d'échec). Interroge le service `nearest` d'OSRM."""
    lon, lat = OSRM_PROBE_LON_LAT
    url = f"{get_config().osrm_url.rstrip('/')}/nearest/v1/driving/{lon},{lat}"
    try:
        async with osrm_client() as client:
            response = await client.get(url, params={"number": 1})
    except httpx.TimeoutException:
        return False, "Le serveur OSRM ne répond pas dans le délai imparti."
    except httpx.HTTPError:
        return False, "Le serveur OSRM est injoignable."
    if response.status_code != 200:
        return False, f"Le serveur OSRM a répondu avec le code HTTP {response.status_code}."
    try:
        code = response.json().get("code")
    except ValueError:
        return False, "Réponse illisible du serveur OSRM."
    if code != "Ok":
        return False, f"Le serveur OSRM a répondu « {code} »."
    return True, None
