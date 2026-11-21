"""Lecteur du fichier « journée de référence » (F8.1, spec §14, question Q6) — LOT L7.

Fonction pure : octets du classeur Excel → structure normalisée + rapport ligne par ligne.
Aucun accès à la base ici : la résolution des codes (camion, station, dépôt…) et la création du
plan `manual_reference` sont faites par `app.comparison.reference_day`.

Structure du classeur (modèle : `data/templates/reference_day.xlsx`, produit par `build_template`) :

- « Lisez-moi » : mode d'emploi (ignorée à la lecture).
- « Journée » : colonne A = rubrique, colonne B = valeur.
    Date (obligatoire), Temps de préparation (min) (facultatif), Libellé (facultatif).
- « Commandes » : une ligne par commande demandée ce jour-là (servie ou non).
    Code station*, Produit*, Volume demandé (L)*, Priorité, Fenêtre début, Fenêtre fin, Commentaire.
    Une seule ligne par couple (station, produit). Feuille vide ou absente : les commandes sont
    déduites des tournées (demandé = livré).
- « Tournées » : une ligne par livraison (tournée × arrêt × produit).
    Tournée*, Camion*, Chauffeur, Dépôt*, Ordre*, Code station*, Produit*, Volume livré (L)*,
    Km réels, Heure départ dépôt, Heure retour dépôt, Heure arrivée station, Heure départ station.
    Camion, chauffeur, dépôt, km réels et heures du dépôt décrivent la tournée : ils peuvent n'être
    saisis que sur sa première ligne. Tout ce qui est « réel » (km, heures) est facultatif (Q6).

Les en-têtes sont reconnus sans tenir compte de la casse, des accents ni de la ponctuation.
"""

from __future__ import annotations

import io
import re
import unicodedata
import zipfile
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, time
from typing import Any

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils.exceptions import InvalidFileException

SHEET_README = "Lisez-moi"
SHEET_DAY = "Journée"
SHEET_ORDERS = "Commandes"
SHEET_TRIPS = "Tournées"

DAY_ROWS = ("Date", "Temps de préparation (min)", "Libellé")
ORDER_HEADERS = (
    "Code station",
    "Produit",
    "Volume demandé (L)",
    "Priorité",
    "Fenêtre début",
    "Fenêtre fin",
    "Commentaire",
)
TRIP_HEADERS = (
    "Tournée",
    "Camion",
    "Chauffeur",
    "Dépôt",
    "Ordre",
    "Code station",
    "Produit",
    "Volume livré (L)",
    "Km réels",
    "Heure départ dépôt",
    "Heure retour dépôt",
    "Heure arrivée station",
    "Heure départ station",
)
ORDER_REQUIRED = ("code_station", "produit", "volume_demande_l")
TRIP_REQUIRED = ("tournee", "camion", "depot", "ordre", "code_station", "produit", "volume_livre_l")

PRIORITIES = {"": "normal", "normal": "normal", "normale": "normal", "urgent": "urgent", "urgente": "urgent"}


# --------------------------------------------------------------------------- structures


@dataclass(slots=True)
class RowIssue:
    """Une anomalie localisée : feuille, numéro de ligne Excel (1 = en-têtes), colonne, message."""

    sheet: str
    row: int | None
    column: str | None
    message: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class RefOrder:
    row: int | None  # None : commande déduite des tournées
    station_code: str
    product_code: str
    requested_l: float
    priority: str = "normal"
    window_start: str | None = None  # "HH:MM", heure locale
    window_end: str | None = None
    comment: str | None = None


@dataclass(slots=True)
class RefDelivery:
    row: int
    product_code: str
    volume_l: float


@dataclass(slots=True)
class RefStop:
    row: int
    order: int  # ordre de passage saisi dans le fichier
    station_code: str
    arrival_s: int | None = None  # secondes depuis minuit local
    departure_s: int | None = None
    deliveries: list[RefDelivery] = field(default_factory=list)


@dataclass(slots=True)
class RefTrip:
    row: int
    key: str  # numéro ou libellé de la tournée dans le fichier
    truck_plate: str
    depot_code: str
    driver: str | None = None  # numéro de permis ou nom complet
    actual_km: float | None = None
    depart_s: int | None = None
    return_s: int | None = None
    stops: list[RefStop] = field(default_factory=list)


@dataclass(slots=True)
class ReferenceDayData:
    day: date | None = None
    prep_time_min: float | None = None
    label: str | None = None
    orders: list[RefOrder] = field(default_factory=list)
    trips: list[RefTrip] = field(default_factory=list)
    errors: list[RowIssue] = field(default_factory=list)
    warnings: list[RowIssue] = field(default_factory=list)
    row_count: int = 0  # lignes de données lues (commandes + livraisons)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["day"] = self.day.isoformat() if self.day else None
        return data


# --------------------------------------------------------------------------- normalisation


def normalize_key(value: Any) -> str:
    """« Volume livré (L) » → `volume_livre_l` ; sert aux en-têtes, noms de feuilles et codes."""
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def _blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _text(value: Any) -> str | None:
    if _blank(value):
        return None
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return str(value).strip()


def _number(value: Any) -> float | None:
    """Nombre saisi comme tel ou en texte (« 12 000 », « 12000,5 »). Lève ValueError sinon."""
    if _blank(value):
        return None
    if isinstance(value, bool):
        raise ValueError
    if isinstance(value, int | float):
        return float(value)
    text = str(value).replace(" ", "").replace(" ", "").replace(" ", "").replace(",", ".")
    return float(text)


def _seconds(value: Any) -> int | None:
    """Heure locale → secondes depuis minuit. Accepte une heure Excel, « 07:30 », « 7h30 »."""
    if _blank(value):
        return None
    if isinstance(value, datetime):
        value = value.time()
    if isinstance(value, time):
        return value.hour * 3600 + value.minute * 60 + value.second
    if isinstance(value, int | float) and not isinstance(value, bool):
        if 0 <= value < 1:  # fraction de journée (cellule au format numérique)
            return round(float(value) * 86400)
        raise ValueError
    match = re.fullmatch(r"(\d{1,2})\s*[:hH]\s*(\d{2})?(?::\d{2})?", str(value).strip())
    if not match:
        raise ValueError
    hours, minutes = int(match.group(1)), int(match.group(2) or 0)
    if hours > 23 or minutes > 59:
        raise ValueError
    return hours * 3600 + minutes * 60


def _date(value: Any) -> date | None:
    if _blank(value):
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    raise ValueError


def _hm(seconds: int | None) -> str | None:
    if seconds is None:
        return None
    return f"{seconds // 3600:02d}:{(seconds % 3600) // 60:02d}"


# --------------------------------------------------------------------------- lecture


def _find_sheet(workbook: Any, name: str) -> Any | None:
    wanted = normalize_key(name)
    for sheet in workbook.worksheets:
        if normalize_key(sheet.title) == wanted:
            return sheet
    return None


def _table(sheet: Any) -> tuple[dict[str, str], list[tuple[int, dict[str, Any]]]]:
    """Feuille tabulaire → (clé normalisée → en-tête tel que saisi, lignes non vides numérotées)."""
    rows = sheet.iter_rows(values_only=True)
    header_row = next(rows, None) or ()
    keys = [normalize_key(cell) for cell in header_row]
    headers = {key: str(cell).strip() for key, cell in zip(keys, header_row, strict=True) if key}
    lines: list[tuple[int, dict[str, Any]]] = []
    for number, values in enumerate(rows, start=2):
        if all(_blank(v) for v in values):
            continue
        lines.append((number, {key: value for key, value in zip(keys, values, strict=False) if key}))
    return headers, lines


class _Reader:
    def __init__(self) -> None:
        self.data = ReferenceDayData()

    def error(self, sheet: str, row: int | None, column: str | None, message: str) -> None:
        self.data.errors.append(RowIssue(sheet, row, column, message))

    def warning(self, sheet: str, row: int | None, column: str | None, message: str) -> None:
        self.data.warnings.append(RowIssue(sheet, row, column, message))

    # ----- valeurs typées avec signalement

    def number(self, sheet: str, row: int, column: str, value: Any, *, positive: bool = True) -> float | None:
        try:
            number = _number(value)
        except ValueError:
            self.error(sheet, row, column, f"Nombre attendu, valeur lue : « {value} ».")
            return None
        if number is not None and (number < 0 or (positive and number == 0)):
            self.error(sheet, row, column, f"Valeur strictement positive attendue, valeur lue : « {value} ».")
            return None
        return number

    def seconds(self, sheet: str, row: int, column: str, value: Any) -> int | None:
        try:
            return _seconds(value)
        except ValueError:
            self.error(sheet, row, column, f"Heure attendue au format HH:MM, valeur lue : « {value} ».")
            return None

    # ----- feuilles

    def read_day(self, sheet: Any) -> None:
        values: dict[str, Any] = {}
        rows: dict[str, int] = {}
        for number, cells in enumerate(sheet.iter_rows(values_only=True), start=1):
            if not cells or _blank(cells[0]):
                continue
            key = normalize_key(cells[0])
            values[key] = cells[1] if len(cells) > 1 else None
            rows[key] = number
        try:
            self.data.day = _date(values.get("date"))
        except ValueError:
            self.error(
                SHEET_DAY,
                rows.get("date"),
                "Date",
                f"Date attendue (AAAA-MM-JJ ou JJ/MM/AAAA), valeur lue : « {values.get('date')} ».",
            )
        prep_key = "temps_de_preparation_min"
        if not _blank(values.get(prep_key)):
            self.data.prep_time_min = self.number(
                SHEET_DAY, rows[prep_key], "Temps de préparation (min)", values[prep_key], positive=False
            )
        self.data.label = _text(values.get("libelle"))

    def read_orders(self, sheet: Any) -> None:
        headers, lines = _table(sheet)
        if not lines:
            return
        missing = [key for key in ORDER_REQUIRED if key not in headers]
        if missing:
            self.error(SHEET_ORDERS, 1, None, f"Colonnes obligatoires absentes : {', '.join(missing)}.")
            return
        seen: dict[tuple[str, str], int] = {}
        for row, cells in lines:
            self.data.row_count += 1
            station = _text(cells.get("code_station"))
            product = _text(cells.get("produit"))
            if station is None:
                self.error(SHEET_ORDERS, row, "Code station", "Code station obligatoire.")
            if product is None:
                self.error(SHEET_ORDERS, row, "Produit", "Produit obligatoire.")
            if _blank(cells.get("volume_demande_l")):
                self.error(SHEET_ORDERS, row, "Volume demandé (L)", "Volume demandé obligatoire.")
                volume = None
            else:
                volume = self.number(SHEET_ORDERS, row, "Volume demandé (L)", cells["volume_demande_l"])
            priority = PRIORITIES.get(normalize_key(cells.get("priorite")))
            if priority is None:
                self.error(
                    SHEET_ORDERS,
                    row,
                    "Priorité",
                    f"Priorité inconnue : « {cells.get('priorite')} » (attendu : normal ou urgent).",
                )
            start = self.seconds(SHEET_ORDERS, row, "Fenêtre début", cells.get("fenetre_debut"))
            end = self.seconds(SHEET_ORDERS, row, "Fenêtre fin", cells.get("fenetre_fin"))
            if _blank(cells.get("fenetre_debut")) != _blank(cells.get("fenetre_fin")):
                self.error(SHEET_ORDERS, row, "Fenêtre début", "Fenêtre incomplète : début et fin attendus.")
            elif start is not None and end is not None and end <= start:
                self.error(SHEET_ORDERS, row, "Fenêtre fin", "La fin de la fenêtre doit suivre son début.")
            if station is None or product is None or volume is None or priority is None:
                continue
            key = (normalize_key(station), normalize_key(product))
            if key in seen:
                self.error(
                    SHEET_ORDERS,
                    row,
                    "Code station",
                    f"Doublon : la station {station} a déjà une commande de {product} en ligne {seen[key]}. "
                    "Regrouper les volumes sur une seule ligne.",
                )
                continue
            seen[key] = row
            self.data.orders.append(
                RefOrder(
                    row=row,
                    station_code=station,
                    product_code=product,
                    requested_l=volume,
                    priority=priority,
                    window_start=_hm(start) if end is not None else None,
                    window_end=_hm(end) if start is not None else None,
                    comment=_text(cells.get("commentaire")),
                )
            )

    def read_trips(self, sheet: Any) -> None:
        headers, lines = _table(sheet)
        missing = [key for key in TRIP_REQUIRED if key not in headers]
        if missing:
            self.error(SHEET_TRIPS, 1, None, f"Colonnes obligatoires absentes : {', '.join(missing)}.")
            return
        if not lines:
            self.error(SHEET_TRIPS, None, None, "Aucune tournée : la feuille est vide.")
            return

        trips: dict[str, RefTrip] = {}
        stops: dict[tuple[str, int], RefStop] = {}
        delivered: dict[tuple[str, int, str], int] = {}

        for row, cells in lines:
            self.data.row_count += 1
            key = _text(cells.get("tournee"))
            if key is None:
                self.error(SHEET_TRIPS, row, "Tournée", "Numéro de tournée obligatoire.")
                continue
            trip = trips.get(normalize_key(key))
            if trip is None:
                trip = RefTrip(row=row, key=key, truck_plate="", depot_code="")
                trips[normalize_key(key)] = trip

            # Champs de la tournée : première valeur saisie, les suivantes doivent concorder.
            for attr, column, cell in (
                ("truck_plate", "Camion", "camion"),
                ("depot_code", "Dépôt", "depot"),
                ("driver", "Chauffeur", "chauffeur"),
            ):
                value = _text(cells.get(cell))
                current = getattr(trip, attr)
                if value is None:
                    continue
                if not current:
                    setattr(trip, attr, value)
                elif normalize_key(current) != normalize_key(value):
                    self.error(
                        SHEET_TRIPS,
                        row,
                        column,
                        f"Tournée {trip.key} : « {value} » contredit « {current} » saisi plus haut.",
                    )
            km = self.number(SHEET_TRIPS, row, "Km réels", cells.get("km_reels"))
            if km is not None:
                if trip.actual_km is None:
                    trip.actual_km = km
                elif abs(trip.actual_km - km) > 1e-6:
                    self.error(
                        SHEET_TRIPS,
                        row,
                        "Km réels",
                        f"Tournée {trip.key} : km réels différents d'une ligne à l'autre "
                        "(saisir le total de la tournée).",
                    )
            for attr, column, cell in (
                ("depart_s", "Heure départ dépôt", "heure_depart_depot"),
                ("return_s", "Heure retour dépôt", "heure_retour_depot"),
            ):
                value = self.seconds(SHEET_TRIPS, row, column, cells.get(cell))
                current = getattr(trip, attr)
                if value is None:
                    continue
                if current is None:
                    setattr(trip, attr, value)
                elif current != value:
                    self.error(
                        SHEET_TRIPS,
                        row,
                        column,
                        f"Tournée {trip.key} : heure différente d'une ligne à l'autre.",
                    )

            # Arrêt et livraison.
            station = _text(cells.get("code_station"))
            product = _text(cells.get("produit"))
            if station is None:
                self.error(SHEET_TRIPS, row, "Code station", "Code station obligatoire.")
            if product is None:
                self.error(SHEET_TRIPS, row, "Produit", "Produit obligatoire.")
            order_value = None
            if _blank(cells.get("ordre")):
                self.error(SHEET_TRIPS, row, "Ordre", "Ordre de passage obligatoire.")
            else:
                number = self.number(SHEET_TRIPS, row, "Ordre", cells["ordre"])
                if number is not None and not number.is_integer():
                    self.error(SHEET_TRIPS, row, "Ordre", "L'ordre de passage doit être un nombre entier.")
                elif number is not None:
                    order_value = int(number)
            if _blank(cells.get("volume_livre_l")):
                self.error(SHEET_TRIPS, row, "Volume livré (L)", "Volume livré obligatoire.")
                volume = None
            else:
                volume = self.number(SHEET_TRIPS, row, "Volume livré (L)", cells["volume_livre_l"])
            arrival = self.seconds(
                SHEET_TRIPS, row, "Heure arrivée station", cells.get("heure_arrivee_station")
            )
            departure = self.seconds(
                SHEET_TRIPS, row, "Heure départ station", cells.get("heure_depart_station")
            )
            if station is None or product is None or order_value is None or volume is None:
                continue

            stop_key = (normalize_key(key), order_value)
            stop = stops.get(stop_key)
            if stop is None:
                stop = RefStop(row=row, order=order_value, station_code=station)
                stops[stop_key] = stop
                trip.stops.append(stop)
            elif normalize_key(stop.station_code) != normalize_key(station):
                self.error(
                    SHEET_TRIPS,
                    row,
                    "Ordre",
                    f"Tournée {trip.key} : l'ordre {order_value} désigne déjà la station "
                    f"{stop.station_code} (ligne {stop.row}).",
                )
                continue
            if arrival is not None:
                stop.arrival_s = arrival if stop.arrival_s is None else stop.arrival_s
            if departure is not None:
                stop.departure_s = departure if stop.departure_s is None else stop.departure_s
            line_key = (*stop_key, normalize_key(product))
            if line_key in delivered:
                self.error(
                    SHEET_TRIPS,
                    row,
                    "Produit",
                    f"Doublon : {product} est déjà livré à cet arrêt en ligne {delivered[line_key]}.",
                )
                continue
            delivered[line_key] = row
            stop.deliveries.append(RefDelivery(row=row, product_code=product, volume_l=volume))

        for trip in trips.values():
            if not trip.truck_plate:
                self.error(SHEET_TRIPS, trip.row, "Camion", f"Tournée {trip.key} : camion obligatoire.")
            if not trip.depot_code:
                self.error(SHEET_TRIPS, trip.row, "Dépôt", f"Tournée {trip.key} : dépôt obligatoire.")
            if not trip.driver:
                self.warning(
                    SHEET_TRIPS, trip.row, "Chauffeur", f"Tournée {trip.key} : chauffeur non renseigné."
                )
            trip.stops.sort(key=lambda s: s.order)
        self.data.trips = [trip for trip in trips.values() if trip.stops]

    def reconcile_orders(self) -> None:
        """Rapproche livraisons et commandes par (station, produit)."""
        delivered: dict[tuple[str, str], tuple[str, str, float, int]] = {}
        for trip in self.data.trips:
            for stop in trip.stops:
                for delivery in stop.deliveries:
                    key = (normalize_key(stop.station_code), normalize_key(delivery.product_code))
                    previous = delivered.get(key)
                    total = delivery.volume_l + (previous[2] if previous else 0.0)
                    first_row = previous[3] if previous else delivery.row
                    delivered[key] = (stop.station_code, delivery.product_code, total, first_row)

        known = {(normalize_key(o.station_code), normalize_key(o.product_code)): o for o in self.data.orders}
        declared = bool(known)
        for key, (station, product, total, row) in delivered.items():
            order = known.get(key)
            if order is None:
                if declared:
                    self.warning(
                        SHEET_TRIPS,
                        row,
                        "Code station",
                        f"Livraison de {product} à {station} sans commande dans la feuille "
                        f"« {SHEET_ORDERS} » : commande déduite (demandé = livré).",
                    )
                self.data.orders.append(
                    RefOrder(row=None, station_code=station, product_code=product, requested_l=total)
                )
            elif total > order.requested_l + 1e-6:
                self.warning(
                    SHEET_TRIPS,
                    row,
                    "Volume livré (L)",
                    f"{station} / {product} : volume livré ({total:g} L) supérieur au volume demandé "
                    f"({order.requested_l:g} L).",
                )
        if not declared and delivered:
            self.warning(
                SHEET_ORDERS,
                None,
                None,
                "Aucune commande saisie : les commandes sont déduites des tournées (demandé = livré).",
            )


def read_reference_day(content: bytes) -> ReferenceDayData:
    """Lit le classeur d'une journée de référence. Ne lève jamais : les anomalies sont dans
    `errors` (bloquantes) et `warnings` (informatives)."""
    reader = _Reader()
    try:
        workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    except (InvalidFileException, zipfile.BadZipFile, KeyError, OSError, ValueError):
        reader.error("", None, None, "Fichier illisible : un classeur Excel (.xlsx) est attendu.")
        return reader.data
    try:
        day_sheet = _find_sheet(workbook, SHEET_DAY)
        if day_sheet is not None:
            reader.read_day(day_sheet)
        orders_sheet = _find_sheet(workbook, SHEET_ORDERS)
        if orders_sheet is not None:
            reader.read_orders(orders_sheet)
        trips_sheet = _find_sheet(workbook, SHEET_TRIPS)
        if trips_sheet is None:
            reader.error(SHEET_TRIPS, None, None, f"Feuille « {SHEET_TRIPS} » absente du classeur.")
        else:
            reader.read_trips(trips_sheet)
        reader.reconcile_orders()
    finally:
        workbook.close()
    return reader.data


# --------------------------------------------------------------------------- écriture (modèle)


def build_workbook(
    *,
    day: date | str | None,
    prep_time_min: float | None = None,
    label: str | None = None,
    orders: list[tuple] = (),
    trips: list[tuple] = (),
    readme: list[str] | None = None,
) -> bytes:
    """Fabrique un classeur au format attendu (fichier modèle, jeux d'essai).

    `orders` et `trips` : lignes dans l'ordre de `ORDER_HEADERS` et `TRIP_HEADERS`."""
    workbook = Workbook()
    bold = Font(bold=True)
    fill = PatternFill("solid", start_color="DDDDDD")

    sheet = workbook.active
    sheet.title = SHEET_README
    for line in readme or []:
        sheet.append([line])
    sheet.column_dimensions["A"].width = 120

    sheet = workbook.create_sheet(SHEET_DAY)
    for name, value in zip(DAY_ROWS, (day, prep_time_min, label), strict=True):
        sheet.append([name, value])
    for cell in sheet["A"]:
        cell.font = bold
    sheet.column_dimensions["A"].width = 30
    sheet.column_dimensions["B"].width = 40

    for title, headers, rows in (
        (SHEET_ORDERS, ORDER_HEADERS, orders),
        (SHEET_TRIPS, TRIP_HEADERS, trips),
    ):
        sheet = workbook.create_sheet(title)
        sheet.append(list(headers))
        for cell in sheet[1]:
            cell.font = bold
            cell.fill = fill
        for row in rows:
            sheet.append(list(row))
        for index in range(1, len(headers) + 1):
            sheet.column_dimensions[sheet.cell(row=1, column=index).column_letter].width = 22
        sheet.freeze_panes = "A2"

    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


TEMPLATE_README = [
    "Tournéo — journée de référence (journée A du test A/B)",
    "",
    "Ce classeur décrit une journée réellement effectuée, telle que le dispatcher l'a organisée à la main.",
    "Il est importé dans Tournéo (écran Comparaison A / B) et devient un plan « manuel de référence »,",
    "que le logiciel rejoue ensuite sur les mêmes commandes pour comparer les deux plans.",
    "",
    "Feuille « Journée »",
    "  - Date : date de la journée (obligatoire), au format AAAA-MM-JJ ou JJ/MM/AAAA.",
    "  - Temps de préparation (min) : temps passé par le dispatcher à construire ce plan (facultatif).",
    "  - Libellé : nom donné à cette journée dans les écrans et le rapport (facultatif).",
    "",
    "Feuille « Commandes » : une ligne par commande demandée ce jour-là, livrée ou non.",
    "  - Code station, Produit, Volume demandé (L) : obligatoires.",
    "  - Une seule ligne par station et par produit.",
    "  - Priorité : normal (par défaut) ou urgent. Fenêtre début / fin : heures HH:MM, facultatives.",
    "  - Une commande présente ici mais absente des tournées est comptée comme non livrée.",
    "  - Si la feuille est laissée vide, les commandes sont déduites des tournées (demandé = livré).",
    "",
    "Feuille « Tournées » : une ligne par livraison (une tournée, un arrêt, un produit).",
    "  - Tournée : numéro de la tournée ; un camion qui recharge dans la journée a plusieurs tournées.",
    "  - Camion : immatriculation. Chauffeur : numéro de permis ou nom complet. Dépôt : code du dépôt.",
    "  - Ordre : rang de la station dans la tournée (1, 2, 3…).",
    "    Plusieurs produits livrés au même arrêt : une ligne par produit, avec le même ordre.",
    "  - Volume livré (L) : volume réellement livré.",
    "  - Km réels : kilométrage total de la tournée, s'il est connu (facultatif).",
    "  - Heures (départ et retour dépôt, arrivée et départ station) : HH:MM, heure de Douala, facultatives.",
    "  - Camion, chauffeur, dépôt, km réels et heures du dépôt peuvent n'être saisis que sur la première",
    "    ligne de la tournée.",
    "",
    "Les codes (stations, produits, dépôts), immatriculations et chauffeurs doivent exister dans les",
    "référentiels de Tournéo. Les lignes d'exemple des feuilles sont à remplacer par vos données.",
    "Ne pas renommer les feuilles ni les colonnes.",
]

TEMPLATE_ORDERS = [
    ("ST-DLA-001", "SUPER", 12000, "normal", None, None, None),
    ("ST-DLA-001", "GASOIL", 8000, "normal", None, None, None),
    ("ST-DLA-002", "GASOIL", 15000, "urgent", "08:00", "12:00", "Rupture annoncée"),
    ("ST-DLA-003", "SUPER", 10000, "normal", None, None, None),
    ("ST-DLA-004", "PETROLE", 5000, "normal", None, None, "Non livrée ce jour-là"),
]

TEMPLATE_TRIPS = [
    (
        1,
        "LT-123-AA",
        "Jean Mbarga",
        "SCDP-DLA",
        1,
        "ST-DLA-001",
        "SUPER",
        12000,
        86,
        "07:30",
        "13:10",
        "08:15",
        "09:00",
    ),
    (1, None, None, None, 1, "ST-DLA-001", "GASOIL", 8000, None, None, None, None, None),
    (1, None, None, None, 2, "ST-DLA-003", "SUPER", 10000, None, None, None, "10:05", "10:50"),
    (
        2,
        "LT-456-BB",
        "Paul Etoa",
        "SCDP-DLA",
        1,
        "ST-DLA-002",
        "GASOIL",
        15000,
        54,
        "07:45",
        "11:20",
        "08:40",
        "09:30",
    ),
]


def build_template() -> bytes:
    """Fichier modèle `data/templates/reference_day.xlsx` (feuille « Lisez-moi » + exemple)."""
    return build_workbook(
        day="2027-01-12",
        prep_time_min=120,
        label="Journée A — exemple",
        orders=TEMPLATE_ORDERS,
        trips=TEMPLATE_TRIPS,
        readme=TEMPLATE_README,
    )
