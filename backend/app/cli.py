"""Commandes d'administration : `python -m app.cli seed`."""

import sys
from decimal import Decimal

from sqlalchemy import select

import app.audit.listener  # noqa: F401
import app.models  # noqa: F401
from app.admin.models import Setting
from app.core.config import get_config
from app.core.db import sync_session_factory
from app.core.enums import Role
from app.core.security import hash_password
from app.core.settings_store import DEFAULTS
from app.referentials.models import Product
from app.users.models import User

# Produits et coefficients de dilatation par défaut (RM-12).
DEFAULT_PRODUCTS = [
    ("SUPER", "Super", Decimal("0.7450"), Decimal("0.001200"), "#e11d48"),
    ("GASOIL", "Gasoil", Decimal("0.8450"), Decimal("0.000850"), "#ca8a04"),
    ("PETROLE", "Pétrole lampant", Decimal("0.8000"), Decimal("0.000950"), "#2563eb"),
]


def seed() -> None:
    """Insère les paramètres par défaut, les trois produits et le compte administrateur (idempotent)."""
    config = get_config()
    with sync_session_factory() as session:
        for key, (value, description) in DEFAULTS.items():
            if session.get(Setting, key) is None:
                session.add(Setting(key=key, value=value, description=description))
        for code, label, density, coeff, color in DEFAULT_PRODUCTS:
            if session.execute(select(Product).where(Product.code == code)).scalar_one_or_none() is None:
                session.add(
                    Product(code=code, label=label, ref_density_15=density, thermal_coeff=coeff, color=color)
                )
        email = config.admin_email.lower()
        if session.execute(select(User).where(User.email == email)).scalar_one_or_none() is None:
            session.add(
                User(
                    email=email,
                    password_hash=hash_password(config.admin_password),
                    full_name="Administrateur Honowa",
                    role=Role.ADMIN,
                )
            )
        session.commit()
    print("Données initiales en place.")


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "seed":
        seed()
    else:
        print("Usage : python -m app.cli seed")
        sys.exit(1)
