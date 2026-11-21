#!/usr/bin/env bash
# Régénère les types TypeScript de l'API à partir de l'OpenAPI réelle du back-end.
# À relancer après toute évolution des schémas de l'API. Ne pas modifier le fichier généré à la main.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=frontend/src/lib/types/api.gen.ts
TMP=$(mktemp --suffix=.json)
(cd backend && TOURNEO_ENV=test uv run -q python -c "
import json
from app.main import app_instance
print(json.dumps(app_instance.openapi()))
" > "$TMP")
(cd frontend && pnpm dlx openapi-typescript@7 "$TMP" -o "src/lib/types/api.gen.ts" && pnpm exec prettier --write "src/lib/types/api.gen.ts" >/dev/null)
rm -f "$TMP"
echo "✔ $OUT régénéré"
