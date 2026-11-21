"""Génère le fichier modèle `data/templates/reference_day.xlsx` (journée de référence, F8.1, spec §14).

Usage : cd backend && uv run python ../scripts/gen_reference_day_template.py

Le contenu (feuilles, colonnes, mode d'emploi, exemple) est défini dans
`backend/app/imports/reference_day.py`, à côté du lecteur, pour qu'ils ne divergent jamais.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from app.imports.reference_day import build_template  # noqa: E402

if __name__ == "__main__":
    target = ROOT / "data" / "templates" / "reference_day.xlsx"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(build_template())
    print(f"Modèle écrit : {target.relative_to(ROOT)}")
