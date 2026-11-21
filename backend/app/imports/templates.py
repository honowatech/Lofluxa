"""Génération des fichiers modèles d'import (spec §14) à partir de `app/imports/columns.py`.

Chaque classeur contient la feuille de données (en-têtes en français, lignes d'exemple, listes déroulantes)
et une feuille « Lisez-moi » (mode d'emploi + description de chaque colonne). Les fichiers versionnés de
`data/templates/` sont produits par `scripts/gen_templates.py` ; l'API (`GET /imports/templates/{kind}`)
génère le même contenu à la demande.
"""

import csv
import io
from datetime import date, datetime, time

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

from app.imports.columns import FileSpec
from app.imports.tabular import README_SHEET

_REQUIRED_FILL = PatternFill("solid", fgColor="F59E0B")
_OPTIONAL_FILL = PatternFill("solid", fgColor="E5E7EB")
_SUB_FILL = PatternFill("solid", fgColor="BFDBFE")
_HEADER_FONT = Font(bold=True)
# Date fixe : deux générations successives donnent le même classeur.
_STAMP = datetime(2026, 11, 21, 8, 0, 0)
_VALIDATED_ROWS = 2000


def _example_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, date):
        return value.strftime("%d/%m/%Y")
    if isinstance(value, time):
        return value.strftime("%H:%M")
    return str(value)


def build_template(spec: FileSpec) -> bytes:
    """Classeur modèle (.xlsx) d'un kind."""
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = spec.sheet
    for index, column in enumerate(spec.columns, start=1):
        cell = sheet.cell(row=1, column=index, value=column.header)
        cell.font = _HEADER_FONT
        cell.fill = _REQUIRED_FILL if column.required else (_SUB_FILL if column.sub else _OPTIONAL_FILL)
        cell.alignment = Alignment(wrap_text=True, vertical="center")
        letter = get_column_letter(index)
        sheet.column_dimensions[letter].width = max(column.width, len(column.header) + 2)
        if column.choices:
            validation = DataValidation(
                type="list",
                formula1='"' + ",".join(column.choices) + '"',
                allow_blank=True,
                showErrorMessage=True,
            )
            validation.errorTitle = "Valeur inconnue"
            validation.error = "Valeurs acceptées : " + ", ".join(column.choices)
            sheet.add_data_validation(validation)
            validation.add(f"{letter}2:{letter}{_VALIDATED_ROWS}")
    for row_index, example in enumerate(spec.examples, start=2):
        for index, value in enumerate(example, start=1):
            cell = sheet.cell(row=row_index, column=index, value=value)
            if isinstance(value, date):
                cell.number_format = "DD/MM/YYYY"
            elif isinstance(value, time):
                cell.number_format = "HH:MM"
    sheet.freeze_panes = "B2"
    sheet.row_dimensions[1].height = 32

    readme = workbook.create_sheet(README_SHEET)
    readme.column_dimensions["A"].width = 34
    readme.column_dimensions["B"].width = 14
    readme.column_dimensions["C"].width = 100
    readme.column_dimensions["D"].width = 36
    readme.cell(row=1, column=1, value=spec.title).font = Font(bold=True, size=14)
    line = 3
    readme.cell(row=line, column=1, value="Mode d'emploi").font = _HEADER_FONT
    for note in spec.notes:
        line += 1
        cell = readme.cell(row=line, column=1, value=f"• {note}")
        cell.alignment = Alignment(wrap_text=True, vertical="top")
        readme.merge_cells(start_row=line, start_column=1, end_row=line, end_column=4)
        readme.row_dimensions[line].height = 15 * (1 + len(note) // 150)
    line += 2
    for index, title in enumerate(("Colonne", "Obligatoire", "Description", "Exemple"), start=1):
        cell = readme.cell(row=line, column=index, value=title)
        cell.font = _HEADER_FONT
        cell.fill = _OPTIONAL_FILL
    for index, column in enumerate(spec.columns):
        line += 1
        readme.cell(row=line, column=1, value=column.header).font = _HEADER_FONT
        readme.cell(row=line, column=2, value="oui" if column.required else "non")
        description = readme.cell(row=line, column=3, value=column.help)
        description.alignment = Alignment(wrap_text=True, vertical="top")
        example = next((row[index] for row in spec.examples if row[index] is not None), None)
        readme.cell(row=line, column=4, value=_example_text(example))
        readme.row_dimensions[line].height = 15 * (1 + len(column.help) // 95)

    workbook.properties.creator = "Tournéo"
    workbook.properties.created = _STAMP
    workbook.properties.modified = _STAMP
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def build_csv_template(spec: FileSpec) -> bytes:
    """Variante CSV du modèle (point-virgule, UTF-8 avec BOM pour Excel) : en-têtes et lignes d'exemple."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, delimiter=";", lineterminator="\r\n")
    writer.writerow([column.header for column in spec.columns])
    for example in spec.examples:
        writer.writerow([_example_text(value) for value in example])
    return buffer.getvalue().encode("utf-8-sig")
