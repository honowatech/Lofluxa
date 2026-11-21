#!/bin/sh
# Démarrage du conteneur `api` : contrôles, migrations, données initiales, puis serveur HTTP.
set -eu

# 1. Refuse une configuration de production dangereuse et attend la base de données.
python -m app.admin.preflight --timeout "${DB_WAIT_TIMEOUT:-120}"

# 2. Migrations (« heads » : fonctionne aussi si plusieurs branches de migration coexistent).
alembic upgrade heads

# 3. Données initiales (idempotent) : paramètres par défaut, produits, compte administrateur.
python -m app.cli seed

# 4. Serveur. Les en-têtes X-Forwarded-* de Caddy sont acceptés : l'API n'est joignable que par lui.
exec uvicorn app.main:app_instance --host 0.0.0.0 --port 8000 \
  --workers "${API_WORKERS:-2}" --proxy-headers --forwarded-allow-ips '*'
