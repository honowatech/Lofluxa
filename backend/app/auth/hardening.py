"""Durcissement de l'API (spec §8.5) : limitation de débit, contrôle de la configuration de production,
CORS strict et en-têtes de sécurité.

Usage dans un routeur (le paramètre `request` est obligatoire pour slowapi) :

    @router.post("/auth/login")
    @limiter.limit(login_limit)
    async def login(request: Request, ...): ...
"""

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.config import Config, get_config
from app.core.errors import envelope

DEFAULT_JWT_SECRET = Config.model_fields["jwt_secret"].default
DEFAULT_ADMIN_PASSWORD = Config.model_fields["admin_password"].default
MIN_JWT_SECRET_LENGTH = 32

CORS_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
CORS_HEADERS = ["Authorization", "Content-Type", "Accept"]
CORS_EXPOSED_HEADERS = ["Content-Disposition", "Retry-After"]


class InsecureConfigError(RuntimeError):
    """Configuration refusée en production."""


def production_config_errors(config: Config) -> list[str]:
    """Défauts de configuration bloquants en `env=prod` (liste vide si tout va bien)."""
    if config.env != "prod":
        return []
    errors = []
    if config.jwt_secret == DEFAULT_JWT_SECRET:
        errors.append("TOURNEO_JWT_SECRET a encore sa valeur par défaut.")
    elif len(config.jwt_secret) < MIN_JWT_SECRET_LENGTH:
        errors.append(f"TOURNEO_JWT_SECRET doit compter au moins {MIN_JWT_SECRET_LENGTH} caractères.")
    if config.admin_password == DEFAULT_ADMIN_PASSWORD:
        errors.append("TOURNEO_ADMIN_PASSWORD a encore sa valeur par défaut.")
    if not config.cors_origins or any("*" in origin for origin in config.cors_origins):
        errors.append("TOURNEO_CORS_ORIGINS doit lister des origines explicites (pas de « * »).")
    return errors


def assert_production_ready(config: Config | None = None) -> None:
    """Refuse de démarrer en production avec une configuration dangereuse."""
    errors = production_config_errors(config or get_config())
    if errors:
        raise InsecureConfigError("Configuration de production refusée : " + " ".join(errors))


def _build_limiter() -> Limiter:
    config = get_config()
    testing = config.env == "test"
    return Limiter(
        key_func=get_remote_address,
        enabled=config.rate_limit_enabled and not testing,
        # Compteurs partagés entre les processus de l'API ; en mémoire si Redis est indisponible.
        storage_uri="memory://" if testing else config.redis_url,
        storage_options=(
            {}
            if testing
            else {
                "socket_connect_timeout": config.redis_timeout_s,
                "socket_timeout": config.redis_timeout_s,
            }
        ),
        in_memory_fallback_enabled=True,
        swallow_errors=True,
        key_prefix=f"tourneo:{config.env}:ratelimit",
    )


limiter = _build_limiter()


def login_limit() -> str:
    return get_config().rate_limit_login


def auth_limit() -> str:
    return get_config().rate_limit_auth


async def _rate_limited(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    retry_after = exc.limit.limit.get_expiry() if exc.limit is not None else 60
    return JSONResponse(
        envelope("rate_limited", "Trop de tentatives. Réessayez dans quelques instants."),
        status_code=429,
        headers={"Retry-After": str(retry_after)},
    )


class SecurityHeadersMiddleware:
    """En-têtes de sécurité des réponses de l'API (middleware ASGI pur, sans mise en tampon)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path: str = scope.get("path", "")
        sensitive = "/auth/" in path or path.endswith("/me/password")

        async def _send(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers.setdefault("X-Content-Type-Options", "nosniff")
                if sensitive:
                    headers["Cache-Control"] = "no-store"  # réponses contenant des jetons
            await send(message)

        await self.app(scope, receive, _send)


def install_security(application: FastAPI, config: Config | None = None) -> None:
    """À appeler une fois à la création de l'application (`app/main.py`)."""
    config = config or get_config()
    assert_production_ready(config)

    application.state.limiter = limiter
    application.add_exception_handler(RateLimitExceeded, _rate_limited)

    application.add_middleware(SecurityHeadersMiddleware)

    # Ajouté en dernier : le CORS enveloppe toutes les réponses, erreurs comprises.
    application.add_middleware(
        CORSMiddleware,
        allow_origins=config.cors_origins,
        allow_credentials=True,
        allow_methods=CORS_METHODS,
        allow_headers=CORS_HEADERS,
        expose_headers=CORS_EXPOSED_HEADERS,
        max_age=600,
    )
