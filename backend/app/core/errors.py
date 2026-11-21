"""Erreurs applicatives et enveloppe JSON commune : `{code, message, details[]}`.

Les violations de règles métier renvoient `rule_code` (RM-xx) dans `details`.
"""

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


class AppError(Exception):
    """Erreur métier ou technique à remonter au client."""

    status_code = 400
    code = "bad_request"

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        status_code: int | None = None,
        details: list[dict[str, Any]] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        if status_code:
            self.status_code = status_code
        self.details = details or []


class NotFoundError(AppError):
    status_code = 404
    code = "not_found"


class ConflictError(AppError):
    status_code = 409
    code = "conflict"


class ForbiddenError(AppError):
    status_code = 403
    code = "forbidden"


class UnauthorizedError(AppError):
    status_code = 401
    code = "unauthorized"


class ValidationAppError(AppError):
    status_code = 422
    code = "validation_error"


class RuleViolationError(AppError):
    """Une ou plusieurs règles RM-xx bloquantes empêchent l'opération (ex. publication → 409)."""

    status_code = 409
    code = "rule_violation"

    def __init__(self, message: str, violations: list[dict[str, Any]]) -> None:
        # Chaque entrée de `violations` doit contenir au moins `rule_code` et `message`.
        super().__init__(message, details=violations)


def envelope(code: str, message: str, details: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {"code": code, "message": message, "details": details or []}


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(exc_status(exc), status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        details = [
            {"field": ".".join(str(p) for p in e["loc"]), "message": e["msg"], "type": e["type"]}
            for e in exc.errors()
        ]
        return JSONResponse(envelope("validation_error", "Requête invalide.", details), status_code=422)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse(
            envelope(f"http_{exc.status_code}", str(exc.detail)),
            status_code=exc.status_code,
            headers=getattr(exc, "headers", None),
        )


def exc_status(exc: AppError) -> dict[str, Any]:
    return envelope(exc.code, exc.message, exc.details)
