#!/usr/bin/env bash
# Contrôle de santé d'osrm-routed sans curl (absent de l'image) : requête HTTP par /dev/tcp.
set -euo pipefail
exec 3<>/dev/tcp/127.0.0.1/5000
printf 'GET /nearest/v1/driving/9.7043,4.0483?number=1 HTTP/1.0\r\nHost: localhost\r\n\r\n' >&3
IFS= read -r -t 5 status_line <&3
case "$status_line" in
  *" 200 "*) exit 0 ;;
  *) exit 1 ;;
esac
