"""Lecture des fichiers tabulaires (xlsx, csv) et interprétation des cellules.

**Seul endroit du code qui ouvre un fichier Excel ou CSV** (critère d'acceptation 7, vérifié par
`tests/unit/imports/test_isolation.py`). Tout lecteur de fichier — y compris celui d'un autre lot, par
exemple la journée de référence — passe par `read_table` et vit dans `app/imports/`.

- `read_table(content, filename, sheet=None)` → `RawTable` : en-têtes normalisés (`norm_header`) et lignes
  brutes avec leur numéro de ligne dans le fichier (celui que l'utilisateur voit dans Excel).
- `parse_*` : conversion d'une cellule ; lève `CellError` avec un message en français destiné au rapport.
"""

import csv
import io
import re
import unicodedata
import zipfile
from dataclasses import dataclass, field
from datetime import date, datetime, time
from typing import Any

from openpyxl import load_workbook

from app.core.time import WEEKDAY_KEYS
from app.referentials.schemas import normalize_opening_hours

README_SHEET = "Lisez-moi"


class FileError(Exception):
    """Fichier illisible dans son ensemble (format, encodage, feuille vide…)."""


class CellError(ValueError):
    """Valeur de cellule invalide ; le message est repris tel quel dans le rapport d'import."""


@dataclass
class RawRow:
    line: int
    cells: dict[str, Any]  # en-tête normalisé → valeur brute (None si vide)


@dataclass
class RawTable:
    sheet: str | None
    header_line: int
    headers: dict[str, str] = field(default_factory=dict)  # en-tête normalisé → en-tête d'origine
    rows: list[RawRow] = field(default_factory=list)


def norm_header(text: Any) -> str:
    """« Capacité cuve (L) * » → `capacite_cuve_l`."""
    value = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "_", value).strip("_")


def is_blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and value.strip() == "")


def _clean(value: Any) -> Any:
    if isinstance(value, str):
        value = value.replace(" ", " ").strip()
        return value or None
    return value


def _build(sheet: str | None, lines: list[tuple[int, list[Any]]]) -> RawTable:
    lines = [(n, [_clean(v) for v in values]) for n, values in lines]
    lines = [(n, values) for n, values in lines if any(v is not None for v in values)]
    if not lines:
        raise FileError("Le fichier ne contient aucune ligne.")
    header_line, header_values = lines[0]
    table = RawTable(sheet=sheet, header_line=header_line)
    keys: list[str | None] = []
    for value in header_values:
        key = norm_header(value) if value is not None else None
        if key and key in table.headers:
            raise FileError(f"La colonne « {value} » apparaît deux fois dans la ligne d'en-tête.")
        if key:
            table.headers[key] = str(value)
        keys.append(key or None)
    if not table.headers:
        raise FileError("La première ligne doit contenir les en-têtes de colonnes.")
    for line, values in lines[1:]:
        cells = {key: (values[i] if i < len(values) else None) for i, key in enumerate(keys) if key}
        if any(v is not None for v in cells.values()):
            table.rows.append(RawRow(line=line, cells=cells))
    return table


def _read_xlsx(content: bytes, sheet: str | None) -> RawTable:
    try:
        workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    except (zipfile.BadZipFile, KeyError, ValueError, OSError) as exc:
        raise FileError("Fichier Excel illisible : enregistrez-le au format .xlsx et réessayez.") from exc
    try:
        candidates = [ws for ws in workbook.worksheets if norm_header(ws.title) != norm_header(README_SHEET)]
        if not candidates:
            raise FileError("Le classeur ne contient aucune feuille de données.")
        chosen = next(
            (ws for ws in candidates if sheet and norm_header(ws.title) == norm_header(sheet)), None
        )
        chosen = chosen or candidates[0]
        lines = [(index, list(row)) for index, row in enumerate(chosen.iter_rows(values_only=True), start=1)]
        return _build(chosen.title, lines)
    finally:
        workbook.close()


def _read_csv(content: bytes) -> RawTable:
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = content.decode("cp1252", errors="replace")
    first_line = next((line for line in text.splitlines() if line.strip()), "")
    delimiter = max((";", ",", "\t"), key=first_line.count)
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter)
    lines: list[tuple[int, list[Any]]] = []
    try:
        for values in reader:
            lines.append((reader.line_num, list(values)))
    except csv.Error as exc:
        raise FileError(f"Fichier CSV illisible : {exc}.") from exc
    return _build(None, lines)


def read_table(content: bytes, filename: str, sheet: str | None = None) -> RawTable:
    """Lit un fichier xlsx ou csv. `sheet` : feuille attendue (sinon la première hors « Lisez-moi »)."""
    if not content:
        raise FileError("Le fichier est vide.")
    extension = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if extension in ("xlsx", "xlsm") or (extension not in ("csv", "txt") and content[:2] == b"PK"):
        return _read_xlsx(content, sheet)
    if extension in ("csv", "txt"):
        return _read_csv(content)
    if extension == "xls":
        raise FileError("L'ancien format .xls n'est pas pris en charge : enregistrez le fichier en .xlsx.")
    raise FileError("Format de fichier non pris en charge : fournissez un fichier .xlsx ou .csv.")


# --- Interprétation des cellules --------------------------------------------------------------------


def parse_text(value: Any) -> str:
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, datetime | date | time):
        return value.isoformat()
    return re.sub(r"\s+", " ", str(value)).strip()


def parse_code(value: Any) -> str:
    """Code d'un référentiel : majuscules, sans espace."""
    text = parse_text(value).upper()
    if not re.match(r"^[A-Z0-9_.\-]{1,32}$", text):
        raise CellError(
            "Code invalide : lettres, chiffres, tiret, point ou tiret bas, 32 caractères au plus."
        )
    return text


def parse_plate(value: Any) -> str:
    text = parse_text(value).upper()
    if len(text) > 32:
        raise CellError("Immatriculation trop longue (32 caractères au plus).")
    return text


def _to_float(value: Any, *, quantity: bool) -> float:
    if isinstance(value, bool):
        raise CellError("Nombre attendu.")
    if isinstance(value, int | float):
        return float(value)
    text = str(value).replace(" ", "").replace(" ", "")
    # « 30,000 » ou « 30.000 » : 30 ou 30 000 ? On refuse plutôt que de deviner une quantité.
    if quantity and re.match(r"^-?\d{1,3}([.,]\d{3})+$", text):
        raise CellError("Nombre ambigu : écrivez-le sans séparateur de milliers (ex. 30000).")
    if not re.match(r"^-?\d+([.,]\d+)?$", text):
        raise CellError("Nombre attendu (ex. 30000 ou 30000,5).")
    return float(text.replace(",", "."))


def parse_decimal(value: Any) -> float:
    """Nombre décimal quelconque (coordonnée…)."""
    return _to_float(value, quantity=False)


def parse_positive(value: Any) -> float:
    """Quantité strictement positive (litres, km/h…)."""
    number = _to_float(value, quantity=True)
    if number <= 0:
        raise CellError("La valeur doit être strictement positive.")
    return round(number, 2)


def parse_non_negative(value: Any) -> float:
    number = _to_float(value, quantity=True)
    if number < 0:
        raise CellError("La valeur ne peut pas être négative.")
    return round(number, 2)


def parse_int(value: Any, *, minimum: int = 0, maximum: int | None = None) -> int:
    number = _to_float(value, quantity=True)
    if not number.is_integer():
        raise CellError("Nombre entier attendu.")
    if number < minimum or (maximum is not None and number > maximum):
        bounds = f"entre {minimum} et {maximum}" if maximum is not None else f"supérieur ou égal à {minimum}"
        raise CellError(f"Nombre entier {bounds} attendu.")
    return int(number)


def parse_lat(value: Any) -> float:
    number = parse_decimal(value)
    if not -90 <= number <= 90:
        raise CellError("Latitude invalide : valeur entre -90 et 90 attendue (degrés décimaux, ex. 4.0511).")
    return round(number, 7)


def parse_lon(value: Any) -> float:
    number = parse_decimal(value)
    if not -180 <= number <= 180:
        raise CellError(
            "Longitude invalide : valeur entre -180 et 180 attendue (degrés décimaux, ex. 9.7085)."
        )
    return round(number, 7)


_TRUE = {"oui", "o", "vrai", "true", "yes", "y", "1", "x"}
_FALSE = {"non", "n", "faux", "false", "no", "0"}


def parse_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    text = norm_header(parse_text(value))
    if text in _TRUE:
        return True
    if text in _FALSE:
        return False
    raise CellError("Valeur attendue : oui ou non.")


def parse_date(value: Any) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    for pattern in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y"):
        try:
            return datetime.strptime(text, pattern).date()
        except ValueError:
            continue
    raise CellError("Date invalide : formats acceptés JJ/MM/AAAA ou AAAA-MM-JJ.")


def parse_time(value: Any) -> time:
    """Heure locale : cellule heure d'Excel, « 08:30 », « 8h30 », « 8h »."""
    if isinstance(value, datetime):
        return value.time().replace(second=0, microsecond=0)
    if isinstance(value, time):
        return value.replace(second=0, microsecond=0)
    if isinstance(value, float) and 0 <= value < 1:  # fraction de jour d'Excel
        minutes = round(value * 24 * 60)
        return time(minutes // 60 % 24, minutes % 60)
    match = re.match(r"^(\d{1,2})\s*(?:[:hH]\s*(\d{2})?)?(?::\d{2})?$", str(value).strip())
    if not match or int(match.group(1)) > 23 or int(match.group(2) or 0) > 59:
        raise CellError("Heure invalide : format HH:MM attendu (ex. 08:30).")
    return time(int(match.group(1)), int(match.group(2) or 0))


def choice_parser(mapping: dict[str, Any], expected: str):
    """Fabrique un analyseur de liste de choix : `mapping` associe les libellés acceptés aux valeurs."""
    normalized = {norm_header(key): val for key, val in mapping.items()}

    def _parse(value: Any) -> Any:
        key = norm_header(parse_text(value))
        if key not in normalized:
            raise CellError(f"Valeur inconnue. Valeurs acceptées : {expected}.")
        return normalized[key]

    return _parse


ALL_PRODUCTS = "all"


def parse_code_list(value: Any) -> list[str] | str:
    """« SUPER, GASOIL » → ["SUPER", "GASOIL"] ; « tous » → `ALL_PRODUCTS`."""
    text = parse_text(value)
    if norm_header(text) in ("tous", "tout", "toutes", "all"):
        return ALL_PRODUCTS
    codes = [parse_code(part) for part in re.split(r"[,;/+]", text) if part.strip()]
    if not codes:
        raise CellError("Liste de codes produit attendue (ex. SUPER, GASOIL) ou « tous ».")
    return list(dict.fromkeys(codes))


_DAYS = {
    "lun": "mon", "lundi": "mon", "mar": "tue", "mardi": "tue", "mer": "wed", "mercredi": "wed",
    "jeu": "thu", "jeudi": "thu", "ven": "fri", "vendredi": "fri", "sam": "sat", "samedi": "sat",
    "dim": "sun", "dimanche": "sun",
    **{key: key for key in WEEKDAY_KEYS},
}  # fmt: skip
_ALWAYS = {"24h_24", "24_24", "24h", "7j_7", "24h_24_7j_7", "toujours", "continu", "en_continu"}
_HOURS_HELP = "Exemple : « lun-ven 06:00-18:00 ; sam 06:00-12:00 » (jours non cités = fermé) ou « 24h/24 »."


def _hm(text: str) -> str:
    text = text.strip()
    if re.match(r"^24\s*(?:[:hH]\s*(?:00)?)?$", text):
        return "24:00"
    try:
        return parse_time(text).strftime("%H:%M")
    except CellError as exc:
        raise CellError(f"Horaires : heure invalide « {text} ». {_HOURS_HELP}") from exc


def _fold(text: str) -> str:
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower().strip()


def _days(text: str) -> list[str]:
    text = re.sub(r"\s+", " ", _fold(text))
    if text in ("", "tous", "tous les jours", "tlj", "chaque jour", "7j/7"):
        return list(WEEKDAY_KEYS)
    text = text.replace(" au ", "-").replace(" a ", "-")
    result: list[str] = []
    for part in re.split(r"\s*(?:,| et )\s*", text):
        bounds = [b.strip() for b in part.split("-")]
        if len(bounds) > 2 or any(b not in _DAYS for b in bounds):
            raise CellError(f"Horaires : jour inconnu « {part.strip()} ». {_HOURS_HELP}")
        if len(bounds) == 1:
            result.append(_DAYS[bounds[0]])
        else:
            start, end = WEEKDAY_KEYS.index(_DAYS[bounds[0]]), WEEKDAY_KEYS.index(_DAYS[bounds[1]])
            if start > end:
                raise CellError(f"Horaires : plage de jours invalide « {part.strip()} ». {_HOURS_HELP}")
            result.extend(WEEKDAY_KEYS[start : end + 1])
    return result


def parse_opening_hours(value: Any) -> dict[str, list[list[str]]]:
    """Texte d'horaires → format de `app.core.time.opening_windows`.

    « lun-ven 06:00-18:00 ; sam 06:00-12:00, 14:00-17:00 ; dim fermé » ; « 24h/24 » = toujours ouvert.
    Les jours non cités sont fermés.
    """
    text = parse_text(value).lower().replace("–", "-").replace("—", "-")
    if norm_header(text) in _ALWAYS:
        return {key: [["00:00", "24:00"]] for key in WEEKDAY_KEYS}
    hours: dict[str, list[list[str]]] = {}
    for segment in (s.strip() for s in re.split(r"[;\n]", text)):
        if not segment:
            continue
        match = re.search(r"\d|ferm", segment)
        if not match:
            raise CellError(f"Horaires illisibles : « {segment} ». {_HOURS_HELP}")
        days = _days(segment[: match.start()].strip().rstrip(":"))
        rest = segment[match.start() :].strip()
        windows: list[list[str]] = []
        if not rest.startswith("ferm"):
            for window in re.split(r"\s*(?:,|/|\+| et )\s*", rest):
                bounds = re.split(r"\s*(?:-| à | a )\s*", window.strip())
                if len(bounds) != 2:
                    raise CellError(f"Horaires : plage invalide « {window.strip()} ». {_HOURS_HELP}")
                windows.append([_hm(bounds[0]), _hm(bounds[1])])
        for day in days:
            if day in hours:
                raise CellError(f"Horaires : le même jour est cité deux fois. {_HOURS_HELP}")
            hours[day] = windows
    if not hours:
        raise CellError(f"Horaires illisibles. {_HOURS_HELP}")
    try:
        return normalize_opening_hours(hours)
    except ValueError as exc:
        raise CellError(f"{exc} {_HOURS_HELP}") from exc
