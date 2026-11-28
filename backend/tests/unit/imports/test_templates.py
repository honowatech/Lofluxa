"""Fichiers modèles (spec §14) : contenu, feuille « Lisez-moi », fichiers versionnés à jour."""

import io
from pathlib import Path

import pytest
from openpyxl import load_workbook

from app.imports.columns import SPECS
from app.imports.registry import registered_kinds
from app.imports.templates import build_template

TEMPLATES = Path(__file__).resolve().parents[4] / "data" / "templates"
KINDS = ["stations", "trucks", "drivers", "depots", "orders"]


def cells(workbook) -> dict[str, list[tuple]]:
    return {
        sheet.title: [tuple(row) for row in sheet.iter_rows(values_only=True)]
        for sheet in workbook.worksheets
    }


@pytest.mark.parametrize("kind", KINDS)
def test_modele_structure(kind):
    spec = SPECS[kind]
    workbook = load_workbook(io.BytesIO(build_template(spec)))
    assert workbook.sheetnames == [spec.sheet, "Lisez-moi"]
    data = workbook[spec.sheet]
    assert [c.value for c in data[1]] == [column.header for column in spec.columns]
    assert data.max_row - 1 == len(spec.examples) >= 2  # lignes d'exemple
    readme = [row[0] for row in workbook["Lisez-moi"].iter_rows(values_only=True) if row[0]]
    for column in spec.columns:  # chaque colonne est expliquée
        assert column.header in readme and column.help
    assert any(str(line).startswith("• ") for line in readme)


@pytest.mark.parametrize("kind", KINDS)
def test_modele_versionne_a_jour(kind):
    """`data/templates/<kind>.xlsx` correspond à `scripts/gen_templates.py` (à relancer sinon)."""
    path = TEMPLATES / f"{kind}.xlsx"
    assert path.exists(), f"{path} manquant : lancer scripts/gen_templates.py"
    assert cells(load_workbook(path)) == cells(load_workbook(io.BytesIO(build_template(SPECS[kind]))))


def test_chaque_kind_du_lot_est_enregistre_avec_son_modele():
    kinds = registered_kinds()
    for kind in KINDS:
        handler = kinds[kind]
        assert handler.template is not None and handler.template()[:2] == b"PK"
    assert {r.value for r in kinds["orders"].roles} == {"dispatcher"}
    assert all({r.value for r in kinds[k].roles} == {"admin"} for k in KINDS if k != "orders")
