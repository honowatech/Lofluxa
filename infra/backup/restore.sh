#!/usr/bin/env bash
# Restauration de la base Tournéo à partir d'une sauvegarde chiffrée.
#
#   restore.sh <fichier.dump.gpg | latest> [--yes]
#
# La sauvegarde est d'abord restaurée dans une base temporaire ; la base en service n'est remplacée
# qu'une fois la restauration réussie (une sauvegarde corrompue ou une mauvaise phrase secrète ne
# détruit donc rien). Arrêter l'API et le worker avant de lancer ce script.
#
# Variables : PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE (base à remplacer), BACKUP_DIR,
# BACKUP_PASSPHRASE(_FILE). Le rôle PostgreSQL doit pouvoir créer et supprimer des bases.
set -euo pipefail

SCRIPT_DIR="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
LOG_TAG="restore"
# shellcheck source=infra/backup/common.sh
. "$SCRIPT_DIR/common.sh"

SOURCE=""
ASSUME_YES="no"
for arg in "$@"; do
  case "$arg" in
    --yes | -y) ASSUME_YES="yes" ;;
    -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
    -*) die "argument inconnu : $arg" ;;
    *) [ -z "$SOURCE" ] || die "un seul fichier de sauvegarde attendu"; SOURCE="$arg" ;;
  esac
done
[ -n "$SOURCE" ] || die "usage : restore.sh <fichier.dump.gpg | latest> [--yes]"

: "${PGDATABASE:?PGDATABASE doit être défini}"
case "$PGDATABASE" in *[!A-Za-z0-9_]*) die "nom de base inattendu : $PGDATABASE" ;; esac
TARGET="$PGDATABASE"
TEMP_DB="${TARGET}_restore_tmp"
MAINTENANCE_DB="${PGMAINTENANCE_DB:-postgres}"

if [ "$SOURCE" = "latest" ]; then
  SOURCE="$(latest_backup)"
  [ -n "$SOURCE" ] || die "aucune sauvegarde dans $BACKUP_DIR"
elif [ ! -f "$SOURCE" ] && [ -f "$BACKUP_DIR/$SOURCE" ]; then
  SOURCE="$BACKUP_DIR/$SOURCE"
fi
[ -f "$SOURCE" ] || die "fichier introuvable : $SOURCE"

load_passphrase
trap 'cleanup_gnupg' EXIT
setup_gnupg

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"
admin_sql() { psql --no-password -v ON_ERROR_STOP=1 -q -X -d "$MAINTENANCE_DB" "$@"; }

if [ -f "$SOURCE.sha256" ]; then
  (cd "$(dirname "$SOURCE")" && sha256sum --check --status "$(basename "$SOURCE").sha256") \
    || die "empreinte SHA-256 incorrecte : le fichier est altéré ou incomplet"
  log "empreinte SHA-256 vérifiée"
fi

log "vérification de la sauvegarde $(basename "$SOURCE")"
ENTRIES="$(count_entries "$SOURCE")" || die "sauvegarde illisible : mauvaise phrase secrète ou fichier corrompu"
[ "${ENTRIES:-0}" -gt 0 ] || die "sauvegarde vide : aucun objet à restaurer"

if [ "$ASSUME_YES" != "yes" ]; then
  printf 'La base « %s » sur %s va être REMPLACÉE par %s. Continuer ? [oui/non] ' \
    "$TARGET" "${PGHOST:-localhost}" "$(basename "$SOURCE")"
  read -r answer
  [ "$answer" = "oui" ] || die "restauration annulée"
fi

log "restauration dans la base temporaire « $TEMP_DB »"
admin_sql -c "DROP DATABASE IF EXISTS \"$TEMP_DB\" WITH (FORCE)"
admin_sql -c "CREATE DATABASE \"$TEMP_DB\""
if ! decrypt_from "$SOURCE" | pg_restore --no-password --no-owner --no-privileges --exit-on-error -d "$TEMP_DB"; then
  admin_sql -c "DROP DATABASE IF EXISTS \"$TEMP_DB\" WITH (FORCE)" || true
  die "échec de la restauration : la base « $TARGET » n'a pas été modifiée"
fi

log "bascule : « $TEMP_DB » devient « $TARGET »"
admin_sql >/dev/null <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE datname IN ('$TARGET', '$TEMP_DB') AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS "$TARGET" WITH (FORCE);
ALTER DATABASE "$TEMP_DB" RENAME TO "$TARGET";
SQL

psql --no-password -q -X -d "$TARGET" -c "ANALYZE" || log "ANALYZE a échoué (sans gravité)"
TABLES="$(psql --no-password -q -X -At -d "$TARGET" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
log "restauration terminée : base « $TARGET » ($TABLES tables, $ENTRIES objets restaurés)"
