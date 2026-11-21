"""Mots de passe (argon2) et jetons JWT (accès 15 min, rafraîchissement 7 jours)."""

import uuid
from datetime import timedelta
from typing import Any

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.core.config import get_config
from app.core.errors import UnauthorizedError
from app.core.time import utcnow

_pwd = CryptContext(schemes=["argon2"], deprecated="auto")

ACCESS = "access"
REFRESH = "refresh"


def hash_password(password: str) -> str:
    return _pwd.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _pwd.verify(password, password_hash)
    except ValueError:
        return False


def create_token(user_id: uuid.UUID, role: str, token_type: str) -> str:
    cfg = get_config()
    lifetime = (
        timedelta(minutes=cfg.access_token_minutes)
        if token_type == ACCESS
        else timedelta(days=cfg.refresh_token_days)
    )
    now = utcnow()
    payload = {
        "sub": str(user_id),
        "role": role,
        "type": token_type,
        "jti": uuid.uuid4().hex,
        "iat": int(now.timestamp()),
        "exp": int((now + lifetime).timestamp()),
    }
    return jwt.encode(payload, cfg.jwt_secret, algorithm=cfg.jwt_algorithm)


def decode_token(token: str, expected_type: str) -> dict[str, Any]:
    cfg = get_config()
    try:
        payload = jwt.decode(token, cfg.jwt_secret, algorithms=[cfg.jwt_algorithm])
    except JWTError as exc:
        raise UnauthorizedError("Jeton invalide ou expiré.", code="invalid_token") from exc
    if payload.get("type") != expected_type:
        raise UnauthorizedError("Type de jeton inattendu.", code="invalid_token")
    return payload
