#!/usr/bin/env bash
# Prépare un poste de développement SANS Docker (conteneur cloud, CI) :
# PostgreSQL 16 + PostGIS, Redis, bases `tourneo` et `tourneo_test`, dépendances Python, migrations, seed.
# Idempotent. En production et pour les démos, utiliser `docker compose up` (voir docs/EXPLOITATION.md).
set -euo pipefail
cd "$(dirname "$0")/.."

if ! ls /usr/share/postgresql/16/extension/postgis.control >/dev/null 2>&1; then
  echo "→ Installation de PostGIS"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-16-postgis-3 >/dev/null
fi

echo "→ Démarrage de PostgreSQL et Redis"
service postgresql start >/dev/null 2>&1 || true
(redis-cli ping >/dev/null 2>&1) || (redis-server --daemonize yes >/dev/null)
for _ in $(seq 1 20); do pg_isready -q && break; sleep 0.5; done

su postgres -c "psql -v ON_ERROR_STOP=1 -q" <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tourneo') THEN
    CREATE ROLE tourneo LOGIN SUPERUSER PASSWORD 'tourneo';
  END IF;
END $$;
SELECT 'CREATE DATABASE tourneo OWNER tourneo' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'tourneo')\gexec
SELECT 'CREATE DATABASE tourneo_test OWNER tourneo' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'tourneo_test')\gexec
\c tourneo
CREATE EXTENSION IF NOT EXISTS postgis;
\c tourneo_test
CREATE EXTENSION IF NOT EXISTS postgis;
SQL

echo "→ Dépendances Python"
cd backend
uv sync -q

echo "→ Migrations et données initiales"
uv run alembic upgrade head
uv run python -m app.cli seed

echo "✔ Prêt. Tests : cd backend && uv run pytest — API : uv run uvicorn app.main:app_instance --reload"
