#!/usr/bin/env bash
# Prétraitement OSRM de l'extrait du Cameroun avec le profil camion.
#
#   prepare.sh [--force]
#
# Construit les données dans un dossier temporaire puis remplace /data/current d'un seul coup : un
# serveur osrm-routed en cours d'exécution n'est pas perturbé (il garde ses données en mémoire) et un
# prétraitement interrompu ne laisse jamais de données à moitié écrites en service.
# Sans --force, ne fait rien si des données prêtes existent déjà.
#
# Variables : OSRM_DATA_DIR (/data), OSRM_ALGORITHM (mld | ch), OSRM_THREADS (tous les cœurs),
# OSRM_PROFILE (/opt/truck.lua) et les réglages TRUCK_* du profil.
set -euo pipefail

DATA_DIR="${OSRM_DATA_DIR:-/data}"
ALGORITHM="${OSRM_ALGORITHM:-mld}"
PROFILE="${OSRM_PROFILE:-/opt/truck.lua}"
THREADS="${OSRM_THREADS:-$(nproc)}"
PBF_FILE="$DATA_DIR/pbf/extract.osm.pbf"
CURRENT="$DATA_DIR/current"
BUILD="$DATA_DIR/build.tmp"
PREVIOUS="$DATA_DIR/previous"
FORCE="no"

for arg in "$@"; do
  case "$arg" in
    --force) FORCE="yes" ;;
    *) echo "argument inconnu : $arg" >&2; exit 2 ;;
  esac
done

log() { printf '%s [osrm-prepare] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERREUR : $*" >&2; exit 1; }

case "$ALGORITHM" in mld | ch) ;; *) die "OSRM_ALGORITHM doit valoir mld ou ch (reçu : $ALGORITHM)" ;; esac
[ -r "$PROFILE" ] || die "profil introuvable : $PROFILE"

if [ "$FORCE" = "no" ] && [ -f "$CURRENT/READY" ]; then
  log "données déjà prêtes ($(head -n 1 "$CURRENT/READY")) : rien à faire"
  exit 0
fi
[ -s "$PBF_FILE" ] || die "extrait OSM absent ($PBF_FILE) : lancer d'abord le service osrm-download"

profile_hash="$(md5sum "$PROFILE" | cut -d ' ' -f 1)"
started="$(date +%s)"
rm -rf "$BUILD"
mkdir -p "$BUILD"
ln -s "$PBF_FILE" "$BUILD/map.osm.pbf"

log "osrm-extract (profil $(basename "$PROFILE"), $THREADS fils)"
osrm-extract --profile "$PROFILE" --threads "$THREADS" "$BUILD/map.osm.pbf"
rm -f "$BUILD/map.osm.pbf"

if [ "$ALGORITHM" = "mld" ]; then
  log "osrm-partition"
  osrm-partition --threads "$THREADS" "$BUILD/map.osrm"
  log "osrm-customize"
  osrm-customize --threads "$THREADS" "$BUILD/map.osrm"
else
  log "osrm-contract"
  osrm-contract --threads "$THREADS" "$BUILD/map.osrm"
fi

ls "$BUILD"/map.osrm* >/dev/null 2>&1 || die "aucun fichier map.osrm* produit"
{
  printf 'préparé le %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'algorithm=%s\n' "$ALGORITHM"
  printf 'profile_md5=%s\n' "$profile_hash"
  if [ -f "$DATA_DIR/pbf/SOURCE" ]; then printf 'source=%s\n' "$(tr '\n' ' ' <"$DATA_DIR/pbf/SOURCE")"; fi
} >"$BUILD/READY"

# Bascule : l'ancien jeu de données est conservé dans previous/ jusqu'au prochain prétraitement.
rm -rf "$PREVIOUS"
if [ -d "$CURRENT" ]; then mv "$CURRENT" "$PREVIOUS"; fi
mv "$BUILD" "$CURRENT"
log "données prêtes dans $CURRENT ($(du -sh "$CURRENT" | cut -f1), $(($(date +%s) - started)) s)"
