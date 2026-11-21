"""Critère d'acceptation 7 : aucun fichier Excel / CSV n'est lu ailleurs que dans `app/imports/`."""

import ast
from pathlib import Path

APP = Path(__file__).resolve().parents[3] / "app"
IMPORTS = APP / "imports"

# Bibliothèques de lecture de fichiers tabulaires, interdites hors de `app/imports/`.
FORBIDDEN_MODULES = {"openpyxl", "pandas", "csv", "xlrd", "pyxlsb", "xlsxwriter"}
# Appels de lecture repérés même si la bibliothèque est importée sous un alias.
FORBIDDEN_CALLS = {"read_excel", "read_csv", "load_workbook", "ExcelFile"}


def violations(path: Path) -> list[str]:
    found = []
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"), filename=str(path))):
        if isinstance(node, ast.Import):
            names = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            names = [node.module or ""]
        elif isinstance(node, ast.Attribute) and node.attr in FORBIDDEN_CALLS:
            found.append(f"{path.relative_to(APP)}:{node.lineno} appelle {node.attr}")
            continue
        elif isinstance(node, ast.Name) and node.id in FORBIDDEN_CALLS:
            found.append(f"{path.relative_to(APP)}:{node.lineno} utilise {node.id}")
            continue
        else:
            continue
        for name in names:
            if name.split(".")[0] in FORBIDDEN_MODULES:
                found.append(f"{path.relative_to(APP)}:{node.lineno} importe {name}")
    return found


def test_aucune_lecture_excel_ou_csv_hors_de_app_imports():
    outside = [p for p in sorted(APP.rglob("*.py")) if IMPORTS not in p.parents]
    assert len(outside) > 20  # garde-fou : le parcours couvre bien toute l'application
    found = [v for path in outside for v in violations(path)]
    assert found == [], "Lecture de fichier tabulaire hors de app/imports/ :\n" + "\n".join(found)


def test_le_controle_detecte_bien_une_lecture_interdite(tmp_path, monkeypatch):
    bad = tmp_path / "bad.py"
    bad.write_text(
        "import pandas as pd\nfrom openpyxl import Workbook\nimport csv\nx = pd.read_excel('f.xlsx')\n"
    )
    monkeypatch.setattr("tests.unit.imports.test_isolation.APP", tmp_path)
    assert len(violations(bad)) == 4


def test_la_lecture_des_fichiers_est_bien_dans_app_imports():
    """Contre-épreuve : le même contrôle, appliqué à `app/imports/`, y trouve le lecteur de fichiers."""
    readers = {p.name for p in IMPORTS.glob("*.py") if violations(p)}
    assert "tabular.py" in readers
