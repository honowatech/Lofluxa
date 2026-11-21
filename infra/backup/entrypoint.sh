#!/usr/bin/env bash
# Point d'entrée du service `backup`.
#
#   (sans argument)        planificateur : une sauvegarde par jour à $BACKUP_TIME (02:00, fuseau $TZ)
#   backup [options]       sauvegarde immédiate (voir backup.sh)
#   restore <fichier> …    restauration (voir restore.sh)
#
# Au démarrage du planificateur, si aucune sauvegarde de moins de 24 h n'existe (premier lancement, serveur éteint
# à l'heure prévue), une sauvegarde est faite immédiatement.
set -euo pipefail

SCRIPT_DIR="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
LOG_TAG="planificateur"
# shellcheck source=infra/backup/common.sh
. "$SCRIPT_DIR/common.sh"

case "${1:-}" in
  backup) shift; exec "$SCRIPT_DIR/backup.sh" "$@" ;;
  restore) shift; exec "$SCRIPT_DIR/restore.sh" "$@" ;;
  "") ;;
  *) exec "$@" ;;
esac

BACKUP_TIME="${BACKUP_TIME:-02:00}"
case "$BACKUP_TIME" in
  [01][0-9]:[0-5][0-9] | 2[0-3]:[0-5][0-9]) ;;
  *) die "BACKUP_TIME doit être au format HH:MM (reçu : $BACKUP_TIME)" ;;
esac

load_passphrase # échoue tout de suite si la phrase secrète manque
mkdir -p "$BACKUP_DIR"

SLEEP_PID=""
stop() {
  log "arrêt demandé"
  if [ -n "$SLEEP_PID" ]; then kill "$SLEEP_PID" 2>/dev/null || true; fi
  exit 0
}
trap stop TERM INT

run_backup() {
  if "$SCRIPT_DIR/backup.sh"; then
    return 0
  fi
  log "ERREUR : la sauvegarde a échoué (nouvel essai à la prochaine échéance)" >&2
  return 0
}

seconds_until_next_run() {
  local now next
  now="$(date +%s)"
  next="$(date -d "today $BACKUP_TIME" +%s)"
  if [ "$next" -le "$now" ]; then
    next="$(date -d "tomorrow $BACKUP_TIME" +%s)"
  fi
  echo $((next - now))
}

if [ "${BACKUP_ON_START:-auto}" != "never" ]; then
  if [ -z "$(find "$BACKUP_DIR" -maxdepth 1 -type f -name "${BACKUP_PREFIX}_*${BACKUP_SUFFIX}" -mmin -1440 -print -quit)" ]; then
    log "aucune sauvegarde de moins de 24 h : sauvegarde immédiate"
    run_backup
  fi
fi

while true; do
  delay="$(seconds_until_next_run)"
  log "prochaine sauvegarde à $BACKUP_TIME ($(date +%Z)), dans ${delay} s"
  sleep "$delay" &
  SLEEP_PID=$!
  wait "$SLEEP_PID"
  SLEEP_PID=""
  run_backup
done
