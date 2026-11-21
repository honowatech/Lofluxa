#!/usr/bin/env bash
# Contrôle de santé du service `backup` : la dernière sauvegarde a réussi et date de moins de 26 heures.
set -euo pipefail
STATUS_FILE="${BACKUP_DIR:-/backups}/.last_status"
[ -r "$STATUS_FILE" ] || exit 1
read -r status timestamp _ <"$STATUS_FILE"
[ "$status" = "ok" ] || exit 1
[ $(($(date +%s) - timestamp)) -lt $((26 * 3600)) ]
