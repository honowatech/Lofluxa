"""Contrôles avant démarrage du conteneur de l'API : `python -m app.admin.preflight`.

1. Refuse une configuration de production dangereuse (secret JWT par défaut, etc.).
2. Attend que la base de données réponde (au plus `--timeout` secondes).
Code de retour non nul en cas d'échec : le conteneur ne démarre pas.
"""

import argparse
import sys
import time

from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError

from app.auth.hardening import production_config_errors
from app.core.config import get_config


def wait_for_database(url: str, timeout_s: float, interval_s: float = 2.0) -> bool:
    engine = create_engine(url, pool_pre_ping=True)
    deadline = time.monotonic() + timeout_s
    try:
        while True:
            try:
                with engine.connect() as connection:
                    connection.execute(text("SELECT 1"))
                return True
            except (SQLAlchemyError, OSError):
                if time.monotonic() >= deadline:
                    return False
                time.sleep(interval_s)
    finally:
        engine.dispose()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Contrôles avant démarrage de l'API Tournéo.")
    parser.add_argument("--timeout", type=float, default=60.0, help="attente maximale de la base (s)")
    args = parser.parse_args(argv)

    config = get_config()
    errors = production_config_errors(config)
    if errors:
        for error in errors:
            print(f"Configuration refusée : {error}", file=sys.stderr)
        return 2
    if not wait_for_database(config.database_url, args.timeout):
        print("Base de données injoignable.", file=sys.stderr)
        return 3
    print("Contrôles avant démarrage : OK.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
