#!/usr/bin/env bash
# Rafraîchissement mensuel des données OSRM (à lancer sur le serveur, depuis n'importe où) :
#
#   infra/osrm/refresh.sh [--keep-cache]
#
# 1. télécharge le dernier extrait du Cameroun ; 2. le prétraite avec le profil camion pendant que
# l'ancien serveur continue de répondre ; 3. redémarre OSRM sur les nouvelles données ;
# 4. vide le cache de distances de l'application (sauf --keep-cache).
#
# Planification conseillée (crontab de l'utilisateur qui exploite Tournéo), le 1er du mois à 03:30 :
#   30 3 1 * * /opt/tourneo/infra/osrm/refresh.sh >> /var/log/tourneo-osrm-refresh.log 2>&1
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
cd "$ROOT"

KEEP_CACHE="no"
for arg in "$@"; do
  case "$arg" in
    --keep-cache) KEEP_CACHE="yes" ;;
    -h | --help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "argument inconnu : $arg" >&2; exit 2 ;;
  esac
done

log() { printf '%s [osrm-refresh] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

log "téléchargement du dernier extrait"
docker compose run --rm osrm-download --force

log "prétraitement (l'ancien serveur reste en service)"
docker compose run --rm --no-deps osrm prepare --force

log "redémarrage d'OSRM sur les nouvelles données"
docker compose up -d --no-deps --force-recreate osrm

if [ "$KEEP_CACHE" = "no" ]; then
  log "purge du cache de distances de l'application"
  # Le script d'initialisation de l'image n'étant pas rejoué, on passe par un shell du conteneur.
  docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "TRUNCATE distance_cache"'
fi

log "terminé — vérifier l'état : GET /api/v1/health/osrm"
