#!/usr/bin/env bash
# Sauvegarde chiffrée de la base Tournéo.
#
#   backup.sh [--offsite] [--no-offsite]
#
# 1. pg_dump (format « custom », compressé) chiffré à la volée (GnuPG, AES-256) vers $BACKUP_DIR ;
# 2. vérification : le fichier est déchiffré et son sommaire relu par pg_restore ;
# 3. rétention locale : suppression des sauvegardes de plus de $BACKUP_RETENTION_DAYS jours (14) ;
# 4. copie hors serveur par rclone si $RCLONE_REMOTE est défini, le jour $BACKUP_OFFSITE_WEEKDAY
#    (1 = lundi … 7 = dimanche, 7 par défaut) ou si --offsite est passé.
#
# Variables : PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, BACKUP_DIR, BACKUP_PASSPHRASE(_FILE),
# BACKUP_RETENTION_DAYS, RCLONE_REMOTE, BACKUP_OFFSITE_WEEKDAY, BACKUP_OFFSITE_RETENTION_DAYS (0 = illimité).
set -euo pipefail

SCRIPT_DIR="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
# shellcheck source=infra/backup/common.sh
. "$SCRIPT_DIR/common.sh"

OFFSITE="auto"
for arg in "$@"; do
  case "$arg" in
    --offsite) OFFSITE="yes" ;;
    --no-offsite) OFFSITE="no" ;;
    -h | --help) sed -n '2,14p' "$0"; exit 0 ;;
    *) die "argument inconnu : $arg" ;;
  esac
done

RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
OFFSITE_WEEKDAY="${BACKUP_OFFSITE_WEEKDAY:-7}"
OFFSITE_RETENTION_DAYS="${BACKUP_OFFSITE_RETENTION_DAYS:-0}"
STATUS_FILE="$BACKUP_DIR/.last_status"

case "$RETENTION_DAYS" in '' | *[!0-9]*) die "BACKUP_RETENTION_DAYS doit être un entier positif" ;; esac
[ "$RETENTION_DAYS" -ge 1 ] || die "BACKUP_RETENTION_DAYS doit valoir au moins 1"
case "$OFFSITE_RETENTION_DAYS" in '' | *[!0-9]*) die "BACKUP_OFFSITE_RETENTION_DAYS doit être un entier" ;; esac

: "${PGDATABASE:?PGDATABASE doit être défini}"
load_passphrase
mkdir -p "$BACKUP_DIR"
umask 077

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL="$BACKUP_DIR/${BACKUP_PREFIX}_${STAMP}${BACKUP_SUFFIX}"
PARTIAL="$FINAL.partial"

fail() {
  rm -f "$PARTIAL"
  printf 'error %s\n' "$(date +%s)" >"$STATUS_FILE" 2>/dev/null || true
  cleanup_gnupg
}
trap 'fail' ERR
trap 'cleanup_gnupg; rm -f "$PARTIAL"' EXIT
setup_gnupg

log "sauvegarde de la base « $PGDATABASE » vers $FINAL"
pg_dump --format=custom --compress=6 --no-password "$PGDATABASE" | encrypt_to "$PARTIAL"

log "vérification du fichier chiffré"
ENTRIES="$(count_entries "$PARTIAL")" || { fail; die "le fichier chiffré ne se relit pas"; }
[ "${ENTRIES:-0}" -gt 0 ] || { fail; die "sauvegarde vide (aucun objet dans le sommaire)"; }

mv "$PARTIAL" "$FINAL"
(cd "$BACKUP_DIR" && sha256sum "$(basename "$FINAL")" >"$(basename "$FINAL").sha256")
SIZE="$(du -h "$FINAL" | cut -f1)"
log "sauvegarde terminée : $(basename "$FINAL") ($SIZE, $ENTRIES objets)"

# Rétention locale (uniquement après une sauvegarde réussie : il reste toujours une sauvegarde récente).
find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name "${BACKUP_PREFIX}_*${BACKUP_SUFFIX}" -o -name "${BACKUP_PREFIX}_*${BACKUP_SUFFIX}.sha256" \
  -o -name "${BACKUP_PREFIX}_*.partial" \) \
  -mmin "+$((RETENTION_DAYS * 1440))" -print -delete | while read -r removed; do
  log "rétention ($RETENTION_DAYS j) : $(basename "$removed") supprimé"
done

# Copie hors serveur.
if [ "$OFFSITE" = "auto" ]; then
  if [ -n "${RCLONE_REMOTE:-}" ] && [ "$(date +%u)" = "$OFFSITE_WEEKDAY" ]; then OFFSITE="yes"; else OFFSITE="no"; fi
fi
if [ "$OFFSITE" = "yes" ]; then
  [ -n "${RCLONE_REMOTE:-}" ] || { fail; die "copie hors serveur demandée mais RCLONE_REMOTE n'est pas défini"; }
  log "copie hors serveur vers $RCLONE_REMOTE"
  rclone copy --no-traverse "$FINAL" "$RCLONE_REMOTE"
  rclone copy --no-traverse "$FINAL.sha256" "$RCLONE_REMOTE"
  if [ "$OFFSITE_RETENTION_DAYS" -gt 0 ]; then
    rclone delete --min-age "${OFFSITE_RETENTION_DAYS}d" --include "${BACKUP_PREFIX}_*${BACKUP_SUFFIX}*" "$RCLONE_REMOTE"
  fi
  log "copie hors serveur terminée"
fi

printf 'ok %s %s\n' "$(date +%s)" "$(basename "$FINAL")" >"$STATUS_FILE"
