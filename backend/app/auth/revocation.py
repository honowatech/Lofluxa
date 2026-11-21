"""Révocation des jetons JWT (spec §8.5) : liste de `jti` révoqués conservée dans Redis.

- Un jeton révoqué (déconnexion, rotation du jeton de rafraîchissement) est mémorisé jusqu'à son expiration.
- Une « coupure » par utilisateur invalide tous les jetons émis avant un instant donné
  (changement ou réinitialisation du mot de passe, désactivation du compte).

Dégradation propre : si Redis est indisponible, le contrôle est ignoré (les jetons restent valables
jusqu'à leur expiration naturelle, 15 minutes pour un jeton d'accès) et un avertissement est journalisé.
Après un échec, Redis n'est plus sollicité pendant `RETRY_AFTER_S` secondes pour ne pas ralentir l'API.
"""

import time
import uuid
from typing import Any

import structlog
from redis import asyncio as aioredis
from redis.exceptions import RedisError

from app.core.config import get_config
from app.core.time import utcnow

log = structlog.get_logger()

RETRY_AFTER_S = 5.0

_client: aioredis.Redis | None = None
_down_until = 0.0


def get_redis() -> aioredis.Redis:
    """Client Redis partagé (délais courts : ce contrôle ne doit jamais bloquer une requête)."""
    global _client
    if _client is None:
        config = get_config()
        _client = aioredis.Redis.from_url(
            config.redis_url,
            socket_connect_timeout=config.redis_timeout_s,
            socket_timeout=config.redis_timeout_s,
            decode_responses=True,
        )
    return _client


def reset_state() -> None:
    """Oublie le client et l'état de panne (tests, changement de configuration)."""
    global _client, _down_until
    _client = None
    _down_until = 0.0


def _key(kind: str, value: str) -> str:
    return f"tourneo:{get_config().env}:auth:{kind}:{value}"


def _mark_down(operation: str, exc: Exception) -> None:
    global _down_until
    _down_until = time.monotonic() + RETRY_AFTER_S
    log.warning("redis_indisponible", operation=operation, error=str(exc))


def _is_down() -> bool:
    return time.monotonic() < _down_until


async def revoke_token(claims: dict[str, Any]) -> bool:
    """Révoque un jeton jusqu'à son expiration. Renvoie False si Redis n'a pas pu l'enregistrer."""
    jti = claims.get("jti")
    if not jti:
        return False
    ttl = int(claims.get("exp", 0)) - int(utcnow().timestamp())
    if ttl <= 0:
        return True  # déjà expiré : rien à mémoriser
    if _is_down():
        return False
    try:
        await get_redis().set(_key("jti", str(jti)), "1", ex=ttl)
    except (RedisError, OSError) as exc:
        _mark_down("revoke_token", exc)
        return False
    return True


async def revoke_user_tokens(user_id: uuid.UUID) -> bool:
    """Invalide tous les jetons de l'utilisateur émis avant maintenant."""
    if _is_down():
        return False
    ttl = get_config().refresh_token_days * 24 * 3600
    try:
        await get_redis().set(_key("cutoff", str(user_id)), str(int(utcnow().timestamp())), ex=ttl)
    except (RedisError, OSError) as exc:
        _mark_down("revoke_user_tokens", exc)
        return False
    return True


async def is_token_revoked(claims: dict[str, Any]) -> bool:
    """Vrai si le jeton a été révoqué ou émis avant la coupure de son utilisateur."""
    if _is_down():
        return False
    try:
        revoked, cutoff = await get_redis().mget(
            _key("jti", str(claims.get("jti"))), _key("cutoff", str(claims.get("sub")))
        )
    except (RedisError, OSError) as exc:
        _mark_down("is_token_revoked", exc)
        return False
    if revoked is not None:
        return True
    return cutoff is not None and int(claims.get("iat", 0)) < int(cutoff)


async def ping() -> bool:
    """État de Redis pour `/health` (ne tient pas compte de la mise en veille après panne)."""
    try:
        return bool(await get_redis().ping())
    except (RedisError, OSError):
        return False
