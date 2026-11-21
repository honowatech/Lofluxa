#!/usr/bin/env bash
# Fonctions communes aux scripts de sauvegarde et de restauration de Tournéo.
# Connexion PostgreSQL : variables standard PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE.

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_PREFIX="${BACKUP_PREFIX:-tourneo}"
BACKUP_SUFFIX=".dump.gpg"

log() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${LOG_TAG:-backup}" "$*"; }
die() { log "ERREUR : $*" >&2; exit 1; }

# Phrase secrète de chiffrement : BACKUP_PASSPHRASE_FILE (fichier, prioritaire) ou BACKUP_PASSPHRASE.
load_passphrase() {
  if [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then
    [ -r "$BACKUP_PASSPHRASE_FILE" ] || die "fichier de phrase secrète illisible : $BACKUP_PASSPHRASE_FILE"
    PASSPHRASE="$(head -n 1 "$BACKUP_PASSPHRASE_FILE")"
  else
    PASSPHRASE="${BACKUP_PASSPHRASE:-}"
  fi
  [ -n "$PASSPHRASE" ] || die "phrase secrète absente : définir BACKUP_PASSPHRASE (les sauvegardes sont toujours chiffrées)"
  [ "${#PASSPHRASE}" -ge 16 ] || die "phrase secrète trop courte (16 caractères au minimum)"
}

# Répertoire GnuPG jetable : aucun trousseau ni agent ne persiste entre deux exécutions.
setup_gnupg() {
  GNUPGHOME="$(mktemp -d)"
  export GNUPGHOME
  chmod 700 "$GNUPGHOME"
}

cleanup_gnupg() {
  if [ -n "${GNUPGHOME:-}" ] && [ -d "$GNUPGHOME" ]; then
    gpgconf --kill gpg-agent >/dev/null 2>&1 || true
    rm -rf "$GNUPGHOME"
  fi
}

# Chiffre l'entrée standard vers le fichier $1 (AES-256 symétrique ; le dump est déjà compressé).
encrypt_to() {
  gpg --batch --yes --quiet --no-tty --pinentry-mode loopback --passphrase-fd 3 \
    --symmetric --cipher-algo AES256 --compress-algo none --output "$1" 3<<<"$PASSPHRASE"
}

# Déchiffre le fichier $1 vers la sortie standard.
decrypt_from() {
  gpg --batch --quiet --no-tty --pinentry-mode loopback --passphrase-fd 3 --decrypt "$1" 3<<<"$PASSPHRASE"
}

# Vérifie un fichier chiffré et affiche le nombre d'objets de son sommaire. Le fichier est déchiffré
# en entier (contrôle d'intégrité de GnuPG) ; échoue si la phrase secrète est fausse ou le fichier altéré.
count_entries() {
  local toc status=0
  toc="$(mktemp)"
  decrypt_from "$1" 2>/dev/null | {
    pg_restore --list >"$toc" 2>/dev/null || true
    cat >/dev/null
  } || status=$?
  if [ "$status" -ne 0 ]; then
    rm -f "$toc"
    return 1
  fi
  grep -c '^[0-9]' "$toc" || true
  rm -f "$toc"
}

# Sauvegarde la plus récente du répertoire (chemin complet), ou rien.
latest_backup() {
  find "$BACKUP_DIR" -maxdepth 1 -type f -name "${BACKUP_PREFIX}_*${BACKUP_SUFFIX}" -printf '%f\n' 2>/dev/null \
    | sort | tail -n 1 | sed "s|^|$BACKUP_DIR/|"
}
