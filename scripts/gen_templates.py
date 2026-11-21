#!/usr/bin/env python3
"""Génère les fichiers modèles d'import de `data/templates/` (spec §14).

    cd backend && uv run python ../scripts/gen_templates.py

Le contenu vient de `backend/app/imports/columns.py` (colonnes, aide, exemples) : modifier ce module puis
relancer ce script. Un test (`tests/unit/imports/test_templates.py`) vérifie que les fichiers versionnés
sont à jour. `reference_day.xlsx` appartient au lot L7 et n'est pas produit ici.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.imports.columns import SPECS  # noqa: E402
from app.imports.templates import build_template  # noqa: E402


def main() -> None:
    target = ROOT / "data" / "templates"
    target.mkdir(parents=True, exist_ok=True)
    for kind, spec in SPECS.items():
        path = target / f"{kind.value}.xlsx"
        path.write_bytes(build_template(spec))
        print(f"✔ {path.relative_to(ROOT)} ({len(spec.columns)} colonnes, {len(spec.examples)} exemples)")


if __name__ == "__main__":
    main()
