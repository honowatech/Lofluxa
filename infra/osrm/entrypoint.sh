#!/usr/bin/env bash
# Point d'entrée de l'image OSRM de Tournéo.
#
#   serve              (par défaut) prétraite les données si elles manquent, puis lance osrm-routed
#   prepare [--force]  prétraitement seul (rafraîchissement mensuel)
set -euo pipefail

DATA_DIR="${OSRM_DATA_DIR:-/data}"
ALGORITHM="${OSRM_ALGORITHM:-mld}"
PROFILE="${OSRM_PROFILE:-/opt/truck.lua}"
CURRENT="$DATA_DIR/current"

log() { printf '%s [osrm] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

command="${1:-serve}"
if [ "$#" -gt 0 ]; then shift; fi

case "$command" in
  prepare)
    exec /opt/tourneo/prepare.sh "$@"
    ;;
  serve)
    /opt/tourneo/prepare.sh
    ready_algorithm="$(sed -n 's/^algorithm=//p' "$CURRENT/READY")"
    if [ -n "$ready_algorithm" ] && [ "$ready_algorithm" != "$ALGORITHM" ]; then
      log "les données ont été préparées pour « $ready_algorithm » : algorithme utilisé à la place de « $ALGORITHM »"
      ALGORITHM="$ready_algorithm"
    fi
    if [ "$(sed -n 's/^profile_md5=//p' "$CURRENT/READY")" != "$(md5sum "$PROFILE" | cut -d ' ' -f 1)" ]; then
      log "ATTENTION : le profil camion a changé depuis le prétraitement ; lancer infra/osrm/refresh.sh"
    fi
    log "démarrage d'osrm-routed (algorithme $ALGORITHM)"
    exec osrm-routed --algorithm "$ALGORITHM" --ip 0.0.0.0 --port 5000 \
      --threads "${OSRM_THREADS:-$(nproc)}" \
      --max-table-size "${OSRM_MAX_TABLE_SIZE:-1000}" \
      "$CURRENT/map.osrm"
    ;;
  *)
    exec "$command" "$@"
    ;;
esac
