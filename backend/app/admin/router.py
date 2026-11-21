"""Administration : paramètres métier (F9.2) et état de santé de la plateforme."""

from typing import Any

from fastapi import APIRouter, Depends, Response
from sqlalchemy import select

from app.admin import health as health_checks
from app.admin.models import Setting
from app.admin.schemas import HealthOut, OsrmHealthOut, SettingOut, SettingsUpdate
from app.admin.settings_spec import SettingError, normalize, spec_for
from app.core.deps import CurrentUser, Page, SessionDep, require_roles
from app.core.enums import Role
from app.core.errors import ValidationAppError
from app.core.settings_store import DEFAULTS
from app.users.models import User

router = APIRouter()


# --- Paramètres -------------------------------------------------------------------------------------


async def _settings_page(session: SessionDep) -> Page[SettingOut]:
    rows = {row.key: row for row in (await session.execute(select(Setting))).scalars().all()}
    author_ids = {row.updated_by for row in rows.values() if row.updated_by is not None}
    names: dict[Any, str] = {}
    if author_ids:
        result = await session.execute(select(User.id, User.full_name).where(User.id.in_(author_ids)))
        names = {user_id: full_name for user_id, full_name in result.all()}

    items = []
    for key, (default, description) in DEFAULTS.items():
        row = rows.get(key)
        spec = spec_for(key)
        value = row.value if row is not None else default
        items.append(
            SettingOut(
                key=key,
                value=value,
                default=default,
                description=description,
                type=spec.type,
                min=spec.min,
                max=spec.max,
                nullable=spec.nullable,
                is_default=value == default,
                updated_by=row.updated_by if row is not None else None,
                updated_by_name=names.get(row.updated_by) if row is not None else None,
                updated_at=row.updated_at if row is not None else None,
            )
        )
    return Page[SettingOut](items=items, total=len(items), limit=len(items), offset=0)


@router.get("/settings", response_model=Page[SettingOut], tags=["paramètres"])
async def list_settings(session: SessionDep, _: CurrentUser) -> Page[SettingOut]:
    """Tous les paramètres connus, avec valeur courante, valeur par défaut, description et bornes."""
    return await _settings_page(session)


@router.put(
    "/settings",
    response_model=Page[SettingOut],
    tags=["paramètres"],
    dependencies=[Depends(require_roles(Role.ADMIN))],
)
async def update_settings(
    payload: SettingsUpdate, session: SessionDep, user: CurrentUser
) -> Page[SettingOut]:
    """Met à jour une ou plusieurs clés. Tout ou rien : une seule valeur refusée annule l'ensemble."""
    normalized: dict[str, Any] = {}
    errors: list[dict[str, Any]] = []
    for key, raw in payload.values.items():
        if key not in DEFAULTS:
            errors.append({"field": key, "message": "Paramètre inconnu."})
            continue
        try:
            normalized[key] = normalize(key, raw)
        except SettingError as exc:
            errors.append({"field": key, "message": str(exc)})
    if errors:
        raise ValidationAppError("Paramètres refusés : aucune valeur n'a été enregistrée.", details=errors)

    # Écriture par l'ORM, objet par objet : chaque changement est tracé dans le journal d'audit.
    changed: list[Setting] = []
    for key, value in normalized.items():
        row = await session.get(Setting, key)
        if row is None:
            row = Setting(key=key, value=value, description=DEFAULTS[key][1], updated_by=user.id)
            session.add(row)
            changed.append(row)
        elif row.value != value or type(row.value) is not type(value):
            row.value = value
            row.updated_by = user.id
            changed.append(row)
    await session.flush()
    for row in changed:
        await session.refresh(row)  # relit `updated_at`, calculé par la base
    return await _settings_page(session)


# --- Santé ------------------------------------------------------------------------------------------


@router.get("/health", response_model=HealthOut, tags=["santé"])
async def health(session: SessionDep, response: Response) -> HealthOut:
    """État de l'API et de ses dépendances. HTTP 503 si la base de données est injoignable ;
    Redis indisponible laisse l'API utilisable en mode dégradé (HTTP 200, `status = degrade`)."""
    database_ok = await health_checks.check_database(session)
    redis_ok = await health_checks.check_redis()
    if not database_ok:
        status = health_checks.DOWN
        response.status_code = 503
    elif not redis_ok:
        status = health_checks.DEGRADED
    else:
        status = health_checks.OK
    return HealthOut(
        status=status,
        checks={
            "database": health_checks.OK if database_ok else health_checks.DOWN,
            "redis": health_checks.OK if redis_ok else health_checks.DOWN,
        },
    )


@router.get("/health/osrm", response_model=OsrmHealthOut, tags=["santé"])
async def health_osrm() -> OsrmHealthOut:
    """État du serveur de calcul d'itinéraires. S'il est indisponible, les distances sont estimées
    à vol d'oiseau (coefficient `haversine_factor`)."""
    available, detail = await health_checks.check_osrm()
    return OsrmHealthOut(status=health_checks.OK if available else health_checks.DOWN, detail=detail)
