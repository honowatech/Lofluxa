#!/bin/sh
# Télécharge l'extrait OpenStreetMap du Cameroun (Geofabrik) dans le volume de données d'OSRM.
#
#   download.sh [--force]
#
# Sans --force, ne fait rien si l'extrait est déjà présent. Le fichier est vérifié par son empreinte
# MD5 publiée par Geofabrik, puis mis en place de façon atomique.
# Variables : OSRM_PBF_URL (extrait à télécharger), OSRM_DATA_DIR (/data).
set -eu

PBF_URL="${OSRM_PBF_URL:-https://download.geofabrik.de/africa/cameroon-latest.osm.pbf}"
DATA_DIR="${OSRM_DATA_DIR:-/data}"
PBF_DIR="$DATA_DIR/pbf"
PBF_FILE="$PBF_DIR/extract.osm.pbf"
FORCE="no"

for arg in "$@"; do
  case "$arg" in
    --force) FORCE="yes" ;;
    *) echo "argument inconnu : $arg" >&2; exit 2 ;;
  esac
done

log() { printf '%s [osrm-download] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

mkdir -p "$PBF_DIR"
if [ "$FORCE" = "no" ] && [ -s "$PBF_FILE" ]; then
  log "extrait déjà présent ($(du -h "$PBF_FILE" | cut -f1)) : rien à télécharger"
  exit 0
fi

TMP_FILE="$PBF_FILE.partial"
if [ "$FORCE" = "yes" ]; then
  rm -f "$TMP_FILE" # un reste d'un ancien téléchargement ne doit pas être prolongé par un extrait plus récent
fi
log "téléchargement de $PBF_URL"
curl --fail --location --silent --show-error --retry 5 --retry-delay 10 --connect-timeout 30 \
  --continue-at - --output "$TMP_FILE" "$PBF_URL"

if curl --fail --location --silent --show-error --retry 3 --connect-timeout 30 --output "$TMP_FILE.md5" "$PBF_URL.md5"; then
  expected="$(cut -d ' ' -f 1 "$TMP_FILE.md5")"
  actual="$(md5sum "$TMP_FILE" | cut -d ' ' -f 1)"
  rm -f "$TMP_FILE.md5"
  if [ "$expected" != "$actual" ]; then
    rm -f "$TMP_FILE"
    log "ERREUR : empreinte MD5 incorrecte (attendue $expected, obtenue $actual) ; fichier supprimé" >&2
    exit 1
  fi
  log "empreinte MD5 vérifiée"
else
  rm -f "$TMP_FILE.md5"
  log "empreinte MD5 indisponible : vérification ignorée"
fi

[ -s "$TMP_FILE" ] || { log "ERREUR : fichier téléchargé vide" >&2; rm -f "$TMP_FILE"; exit 1; }
mv "$TMP_FILE" "$PBF_FILE"
printf '%s\n%s\n' "$PBF_URL" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$PBF_DIR/SOURCE"
log "extrait en place : $PBF_FILE ($(du -h "$PBF_FILE" | cut -f1))"
