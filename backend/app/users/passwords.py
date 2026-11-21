"""Règles de forme des mots de passe (longueur minimale configurable : `TOURNEO_PASSWORD_MIN_LENGTH`)."""

from app.core.config import get_config
from app.core.errors import ValidationAppError

PASSWORD_MAX_LENGTH = 128  # borne technique : évite de hacher des entrées démesurées


def validate_password(password: str, *, field: str = "password") -> None:
    minimum = get_config().password_min_length
    if len(password) < minimum:
        message = f"Le mot de passe doit compter au moins {minimum} caractères."
    elif len(password) > PASSWORD_MAX_LENGTH:
        message = f"Le mot de passe ne peut pas dépasser {PASSWORD_MAX_LENGTH} caractères."
    elif not password.strip():
        message = "Le mot de passe ne peut pas être composé uniquement d'espaces."
    else:
        return
    raise ValidationAppError(message, details=[{"field": field, "message": message}])
