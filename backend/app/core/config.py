"""Configuration d'infrastructure (variables d'environnement TOURNEO_*).

Attention : les valeurs *métier* paramétrables (seuils, durées, tolérances) ne vivent PAS ici
mais dans la table `settings` (voir `app.core.settings_store`).
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Config(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="TOURNEO_", extra="ignore")

    env: str = "dev"  # dev | test | prod
    database_url: str = "postgresql+psycopg://tourneo:tourneo@localhost:5432/tourneo"
    redis_url: str = "redis://localhost:6379/0"
    osrm_url: str = "http://localhost:5000"

    jwt_secret: str = "change-me-in-production"
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = 15
    refresh_token_days: int = 7

    cors_origins: list[str] = ["http://localhost:5173"]

    # Durcissement de l'authentification (spec §8.5) — seuils au format slowapi « N/période ».
    rate_limit_enabled: bool = True  # toujours inactif en `env=test`, sauf activation explicite par un test
    rate_limit_login: str = "10/minute"  # tentatives de connexion par adresse IP
    rate_limit_auth: str = "60/minute"  # autres routes d'authentification (rafraîchissement, déconnexion…)
    password_min_length: int = 8
    redis_timeout_s: float = 0.5  # délai maximal d'un appel Redis de contrôle (révocation, santé)
    osrm_health_timeout_s: float = 3.0

    smtp_host: str = "localhost"
    smtp_port: int = 1025
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = "tourneo@example.com"
    smtp_tls: bool = False

    celery_always_eager: bool = False

    # Compte administrateur créé par `python -m app.cli seed`
    admin_email: str = "admin@honowa.tech"
    admin_password: str = "admin-dev-only"


@lru_cache
def get_config() -> Config:
    return Config()
