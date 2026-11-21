"""Application FastAPI — préfixe `/api/v1`.

Les routeurs sont découverts automatiquement : tout module `app/<module>/router.py` exposant
`router` (APIRouter) est monté sous `/api/v1`. Un lot n'a donc jamais à modifier ce fichier.
"""

import importlib
import pkgutil

import structlog
from fastapi import APIRouter, FastAPI

import app
import app.audit.listener  # noqa: F401  (active le journal d'audit)
import app.models  # noqa: F401  (enregistre tous les modèles)
from app.auth.hardening import install_security
from app.core.config import get_config
from app.core.errors import register_error_handlers

log = structlog.get_logger()

API_PREFIX = "/api/v1"


def discover_routers() -> list[tuple[str, APIRouter]]:
    found = []
    for module in sorted(pkgutil.iter_modules(app.__path__), key=lambda m: m.name):
        if not module.ispkg:
            continue
        name = f"app.{module.name}.router"
        try:
            mod = importlib.import_module(name)
        except ModuleNotFoundError as exc:
            if exc.name == name:
                continue  # le module n'a pas (encore) de routeur
            raise
        router = getattr(mod, "router", None)
        if isinstance(router, APIRouter):
            found.append((module.name, router))
    return found


def create_app() -> FastAPI:
    config = get_config()
    structlog.configure(
        processors=[structlog.processors.TimeStamper(fmt="iso"), structlog.processors.JSONRenderer()]
    )

    application = FastAPI(
        title="Tournéo — API",
        version="0.1.0",
        openapi_url=f"{API_PREFIX}/openapi.json",
        docs_url=f"{API_PREFIX}/docs",
        redoc_url=None,
    )
    register_error_handlers(application)
    # Limitation de débit, CORS strict, en-têtes, refus d'une configuration de production dangereuse (lot L8).
    install_security(application, config)

    for _name, router in discover_routers():
        application.include_router(router, prefix=API_PREFIX)
    return application


app_instance = create_app()
