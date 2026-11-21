"""Lecture des fichiers tabulaires et interprétation des cellules (sans base de données)."""

import io
from datetime import date, datetime, time

import pytest
from openpyxl import Workbook

from app.imports import tabular as tab


def workbook_bytes(sheets: dict[str, list[list]]) -> bytes:
    workbook = Workbook()
    workbook.remove(workbook.active)
    for name, rows in sheets.items():
        sheet = workbook.create_sheet(name)
        for row in rows:
            sheet.append(row)
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def test_norm_header():
    assert tab.norm_header("Capacité cuve (L) *") == "capacite_cuve_l"
    assert tab.norm_header("  E-mail ") == "e_mail"
    assert tab.norm_header("Horaires d'ouverture") == "horaires_d_ouverture"


def test_read_table_xlsx_numeros_de_ligne_et_feuille():
    content = workbook_bytes(
        {
            "Lisez-moi": [["Mode d'emploi"]],
            "Autre": [["x"], [1]],
            "Stations": [["Code station", "Nom"], ["ST1", " Akwa "], [None, None], ["ST2", None]],
        }
    )
    table = tab.read_table(content, "stations.xlsx", sheet="Stations")
    assert table.sheet == "Stations" and table.header_line == 1
    assert table.headers == {"code_station": "Code station", "nom": "Nom"}
    # La ligne vide est ignorée mais les numéros restent ceux du fichier.
    assert [(r.line, r.cells) for r in table.rows] == [
        (2, {"code_station": "ST1", "nom": "Akwa"}),
        (4, {"code_station": "ST2", "nom": None}),
    ]
    # Feuille attendue absente : première feuille hors « Lisez-moi ».
    assert tab.read_table(content, "stations.xlsx", sheet="Inconnue").sheet == "Autre"


def test_read_table_csv_separateur_et_encodage():
    semicolon = "Code dépôt;Nom\r\nD1;Dépôt « un »\r\n\r\nD2;\r\n".encode("utf-8-sig")
    table = tab.read_table(semicolon, "depots.csv")
    assert table.headers == {"code_depot": "Code dépôt", "nom": "Nom"}
    assert [(r.line, r.cells["code_depot"], r.cells["nom"]) for r in table.rows] == [
        (2, "D1", "Dépôt « un »"),
        (4, "D2", None),
    ]
    windows = "Code dépôt,Nom\nD1,Dépôt\n".encode("cp1252")
    assert tab.read_table(windows, "depots.csv").rows[0].cells == {"code_depot": "D1", "nom": "Dépôt"}
    quoted = b'Code,Adresse\nD1,"Zone portuaire, Douala"\n'
    assert tab.read_table(quoted, "d.csv").rows[0].cells["adresse"] == "Zone portuaire, Douala"


@pytest.mark.parametrize(
    ("content", "filename", "expected"),
    [
        (b"", "f.xlsx", "vide"),
        (b"PK\x03\x04 faux", "f.xlsx", "illisible"),
        (b"abc", "f.xls", ".xls"),
        (b"abc", "f.pdf", "non pris en charge"),
        (b"Code;Code\nA;B\n", "f.csv", "deux fois"),
        (b"\n \n", "f.csv", "aucune ligne"),
    ],
)
def test_read_table_fichiers_refuses(content, filename, expected):
    with pytest.raises(tab.FileError, match=expected):
        tab.read_table(content, filename)


def test_nombres():
    assert tab.parse_positive("30000") == 30000
    assert tab.parse_positive("15000,5") == 15000.5
    assert tab.parse_positive("30 000") == 30000
    assert tab.parse_positive(12000.0) == 12000
    assert tab.parse_non_negative(0) == 0
    assert tab.parse_int("45") == 45 and tab.parse_int(45.0) == 45
    assert tab.parse_lat("4,0511") == 4.0511 and tab.parse_lon("9.708") == 9.708
    for ambiguous in ("30,000", "30.000", "1.250.000"):
        with pytest.raises(tab.CellError, match="ambigu"):
            tab.parse_positive(ambiguous)
    for invalid, parser in (
        ("abc", tab.parse_positive), (0, tab.parse_positive), (-5, tab.parse_non_negative),
        (4.5, tab.parse_int), (True, tab.parse_positive), (91, tab.parse_lat), (-181, tab.parse_lon),
    ):  # fmt: skip
        with pytest.raises(tab.CellError):
            parser(invalid)


def test_dates_heures_booleens_codes():
    assert tab.parse_date("30/06/2028") == tab.parse_date("2028-06-30") == date(2028, 6, 30)
    assert tab.parse_date(datetime(2028, 6, 30, 10, 0)) == date(2028, 6, 30)
    with pytest.raises(tab.CellError):
        tab.parse_date("31/02/2028")
    assert tab.parse_time("8h30") == tab.parse_time("08:30") == tab.parse_time(time(8, 30, 12)) == time(8, 30)
    assert tab.parse_time("8h") == time(8, 0) and tab.parse_time(0.5) == time(12, 0)
    with pytest.raises(tab.CellError):
        tab.parse_time("25:00")
    assert tab.parse_bool("Oui") is True and tab.parse_bool("NON") is False and tab.parse_bool(True) is True
    with pytest.raises(tab.CellError):
        tab.parse_bool("peut-être")
    assert tab.parse_code(" st-akwa ") == "ST-AKWA" and tab.parse_code(1204.0) == "1204"
    with pytest.raises(tab.CellError):
        tab.parse_code("ST AKWA")
    assert tab.parse_plate("lt  123 ab") == "LT 123 AB"
    assert tab.parse_code_list("super, Gasoil ; SUPER") == ["SUPER", "GASOIL"]
    assert tab.parse_code_list("Tous") == tab.ALL_PRODUCTS


def test_horaires_format_de_core_time():
    closed = []
    hours = tab.parse_opening_hours("lun-ven 06:00-18:00 ; sam 6h-12h, 14h-17h30 ; dim fermé")
    assert hours == {
        "mon": [["06:00", "18:00"]], "tue": [["06:00", "18:00"]], "wed": [["06:00", "18:00"]],
        "thu": [["06:00", "18:00"]], "fri": [["06:00", "18:00"]],
        "sat": [["06:00", "12:00"], ["14:00", "17:30"]], "sun": closed,
    }  # fmt: skip
    assert tab.parse_opening_hours("24h/24")["sun"] == [["00:00", "24:00"]]
    assert tab.parse_opening_hours("06:00-22:00") == {day: [["06:00", "22:00"]] for day in tab.WEEKDAY_KEYS}
    listed = tab.parse_opening_hours("Lundi, mercredi et vendredi : 08:00 à 16:00")
    assert listed["mon"] == listed["wed"] == listed["fri"] == [["08:00", "16:00"]]
    assert listed["tue"] == [] and listed["sun"] == []
    for invalid in ("matin", "lun-ven", "lun 18:00-06:00", "lun 06:00-12:00, 11:00-18:00", "xyz 06:00-18:00",
                    "lun 06:00-18:00 ; lun 07:00-09:00", "ven-lun 06:00-18:00"):  # fmt: skip
        with pytest.raises(tab.CellError):
            tab.parse_opening_hours(invalid)
