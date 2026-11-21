"""Couche d'import isolée (spec §8.3) : protocole `ImportSource` et implémentation Excel / CSV.

`ImportSource` est le contrat que respecteront les futures sources (`AccpacImportSource` — SAGE 300,
`SapImportSource` — OData) : elles renvoient les mêmes enregistrements normalisés (`app/imports/schemas.py`),
et tout le reste (contrôles en base, prévisualisation, application) est réutilisé tel quel.

`ExcelImportSource` est la seule implémentation du MVP. Elle lit un fichier xlsx ou csv déjà reçu en
mémoire, ne touche pas à la base, et consigne ses anomalies dans `issues` (ligne, colonne, valeur, message).
Un enregistrement dont une ligne est en erreur n'est pas renvoyé : l'import ne s'applique alors pas.
"""

from collections.abc import Callable
from datetime import date
from typing import Any, Protocol, runtime_checkable

from app.imports import columns as cols
from app.imports import tabular as tab
from app.imports.schemas import (
    CompartmentIn,
    DeliveryOut,
    DepotIn,
    DriverIn,
    OrderIn,
    PushResult,
    RowIssue,
    StationIn,
    TankIn,
    TruckIn,
)


@runtime_checkable
class ImportSource(Protocol):
    """Protocole de la spec §8.3 (à la lettre)."""

    def fetch_stations(self) -> list[StationIn]: ...
    def fetch_trucks(self) -> list[TruckIn]: ...
    def fetch_drivers(self) -> list[DriverIn]: ...
    def fetch_orders(self, day: date) -> list[OrderIn]: ...
    def push_deliveries(self, deliveries: list[DeliveryOut]) -> PushResult: ...  # sans effet dans le MVP


class _Line:
    """Une ligne du fichier après interprétation de ses cellules."""

    def __init__(self, number: int) -> None:
        self.number = number
        self.values: dict[str, Any] = {}
        self.valid = True


class ExcelImportSource:
    """Source d'import lisant un fichier Excel (.xlsx) ou CSV.

    En plus du protocole : `fetch_depots()` (les dépôts s'importent aussi, F1.6), `issues` (anomalies
    relevées à la lecture) et `row_count` (nombre de lignes de données lues).
    """

    def __init__(self, content: bytes, filename: str) -> None:
        self.content = content
        self.filename = filename
        self.issues: list[RowIssue] = []
        self.row_count = 0

    # --- Protocole ----------------------------------------------------------------------------------

    def fetch_stations(self) -> list[StationIn]:
        spec = cols.STATIONS
        return self._grouped(
            spec,
            key="code",
            what="la station",
            sub_key="product_code",
            sub_what="cuve",
            build_sub=lambda line: TankIn(
                row=line.number,
                product_code=line.values["product_code"],
                capacity_l=line.values["capacity_l"],
                safety_stock_l=line.values.get("safety_stock_l"),
            ),
            sub_required=("capacity_l",),
            sub_label=lambda value: f"le produit {value}",
            build=lambda first, main, subs: StationIn(row=first, tanks=subs, **main),
        )

    def fetch_trucks(self) -> list[TruckIn]:
        spec = cols.TRUCKS
        return self._grouped(
            spec,
            key="plate",
            what="le camion",
            sub_key="position",
            sub_what="compartiment",
            build_sub=lambda line: CompartmentIn(
                row=line.number,
                position=line.values["position"],
                capacity_l=line.values["capacity_l"],
                allowed_product_codes=line.values.get("allowed_product_codes"),
            ),
            sub_required=("capacity_l",),
            sub_label=lambda value: f"le compartiment {value}",
            build=lambda first, main, subs: TruckIn(row=first, compartments=subs, **main),
        )

    def fetch_drivers(self) -> list[DriverIn]:
        return self._flat(cols.DRIVERS, "license_no", "le numéro de permis", DriverIn)

    def fetch_depots(self) -> list[DepotIn]:
        return self._flat(cols.DEPOTS, "code", "le code dépôt", DepotIn)

    def fetch_orders(self, day: date | None = None) -> list[OrderIn]:
        """Commandes du fichier. `day` fourni : seule cette journée est acceptée (les autres lignes sont
        signalées en erreur) et une cellule « Date » vide prend cette valeur."""
        spec = cols.ORDERS
        orders: list[OrderIn] = []
        for line in self._lines(spec, defaults={"day": day} if day else None):
            values = line.values
            if day and values.get("day") and values["day"] != day:
                self._issue(
                    line.number,
                    spec.header("day"),
                    values["day"].strftime("%d/%m/%Y"),
                    f"La date ne correspond pas à la journée importée ({day.strftime('%d/%m/%Y')}).",
                )
                line.valid = False
            start, end = values.get("window_start"), values.get("window_end")
            if start and end and start >= end:
                self._issue(
                    line.number,
                    spec.header("window_end"),
                    end.strftime("%H:%M"),
                    f"La fin de la fenêtre doit être après son début ({start.strftime('%H:%M')}).",
                )
                line.valid = False
            if line.valid:
                orders.append(OrderIn(row=line.number, **values))
        return orders

    def push_deliveries(self, deliveries: list[DeliveryOut]) -> PushResult:
        """Sans effet dans le MVP : un fichier Excel n'est pas un système vers lequel renvoyer des données."""
        return PushResult(pushed=0, message="Aucun envoi : la source Excel est en lecture seule.")

    # --- Lecture générique --------------------------------------------------------------------------

    def _issue(
        self, row: int | None, column: str | None, value: Any, message: str, severity: str = "error"
    ) -> None:
        shown = None if value is None else tab.parse_text(value)[:200]
        self.issues.append(RowIssue(row=row, column=column, value=shown, message=message, severity=severity))

    def _lines(self, spec: cols.FileSpec, defaults: dict[str, Any] | None = None) -> list[_Line]:
        """Lit la feuille, associe les colonnes, interprète chaque cellule et relève les anomalies."""
        defaults = defaults or {}
        try:
            table = tab.read_table(self.content, self.filename, sheet=spec.sheet)
        except tab.FileError as exc:
            self._issue(None, None, None, str(exc))
            return []
        by_header: dict[str, cols.Column] = {}
        for column in spec.columns:
            for name in (tab.norm_header(column.header), column.key, *column.aliases):
                by_header.setdefault(name, column)
        mapping: dict[str, cols.Column] = {}  # en-tête normalisé du fichier → colonne
        for header_key, original in table.headers.items():
            column = by_header.get(header_key)
            if column is None:
                self._issue(
                    table.header_line, original, None, "Colonne inconnue : elle est ignorée.", "warning"
                )
            elif column in mapping.values():
                self._issue(table.header_line, original, None, f"Colonne en double avec « {column.header} ».")
            else:
                mapping[header_key] = column
        present = {column.key for column in mapping.values()}
        missing = [c for c in spec.columns if c.required and c.key not in present and c.key not in defaults]
        for column in missing:
            self._issue(
                table.header_line, column.header, None, f"Colonne obligatoire absente : « {column.header} »."
            )
        if missing:
            return []
        self.row_count = len(table.rows)
        lines: list[_Line] = []
        for raw in table.rows:
            line = _Line(raw.line)
            failed: set[str] = set()
            for header_key, column in mapping.items():
                cell = raw.cells.get(header_key)
                if tab.is_blank(cell):
                    continue
                try:
                    line.values[column.key] = column.parse(cell)
                except tab.CellError as exc:
                    self._issue(raw.line, column.header, cell, str(exc))
                    failed.add(column.key)
            for column in spec.columns:
                if not column.required or column.key in line.values or column.key in failed:
                    continue
                if column.key in defaults:
                    line.values[column.key] = defaults[column.key]
                else:
                    self._issue(raw.line, column.header, None, f"« {column.header} » est obligatoire.")
                    failed.add(column.key)
            line.valid = not failed
            lines.append(line)
        return lines

    def _flat(self, spec: cols.FileSpec, key: str, what: str, model: type) -> list[Any]:
        """Fichiers à une ligne par enregistrement ; une clé répétée est une erreur."""
        records: list[Any] = []
        seen: dict[str, int] = {}
        for line in self._lines(spec):
            value = line.values.get(key)
            if value is not None:
                folded = str(value).casefold()
                if folded in seen:
                    self._issue(
                        line.number,
                        spec.header(key),
                        value,
                        f"Doublon : {what} « {value} » figure déjà à la ligne {seen[folded]}.",
                    )
                    continue
                seen[folded] = line.number
            if line.valid:
                records.append(model(row=line.number, **line.values))
        return records

    def _grouped(
        self,
        spec: cols.FileSpec,
        *,
        key: str,
        what: str,
        sub_key: str,
        sub_what: str,
        build_sub: Callable[[_Line], Any],
        sub_required: tuple[str, ...],
        sub_label: Callable[[Any], str],
        build: Callable[[int, dict[str, Any], list[Any]], Any],
    ) -> list[Any]:
        """Fichiers à lignes répétées : même clé = un enregistrement et ses sous-lignes."""
        sub_keys = {c.key for c in spec.columns if c.sub}
        groups: dict[str, list[_Line]] = {}
        broken: set[str] = set()
        for line in self._lines(spec):
            value = line.values.get(key)
            if value is None:
                continue  # clé absente ou invalide : anomalie déjà relevée
            groups.setdefault(value, []).append(line)
            if not line.valid:
                broken.add(value)

        records: list[Any] = []
        for value, lines in groups.items():
            first = lines[0]
            main: dict[str, Any] = {key: value}
            origin: dict[str, int] = {}
            subs: list[Any] = []
            seen_subs: dict[Any, int] = {}
            valid = value not in broken
            for line in lines:
                for field_key, field_value in line.values.items():
                    if field_key in sub_keys or field_key == key:
                        continue
                    if field_key not in main:
                        main[field_key] = field_value
                        origin[field_key] = line.number
                    elif main[field_key] != field_value:
                        self._issue(
                            line.number,
                            spec.header(field_key),
                            field_value,
                            f"Valeur différente de celle de la ligne {origin[field_key]} pour {what} "
                            f"{value} : laissez la cellule vide ou indiquez la même valeur.",
                        )
                        valid = False
                sub_value = line.values.get(sub_key)
                if sub_value is None:
                    extra = [k for k in line.values if k in sub_keys]
                    if extra and line.valid:
                        self._issue(
                            line.number,
                            spec.header(sub_key),
                            None,
                            f"« {spec.header(sub_key)} » est obligatoire pour décrire un(e) {sub_what}.",
                        )
                        valid = False
                    continue
                if sub_value in seen_subs:
                    self._issue(
                        line.number,
                        spec.header(sub_key),
                        sub_value,
                        f"Doublon : {sub_label(sub_value)} figure déjà à la ligne {seen_subs[sub_value]} "
                        f"pour {what} {value}.",
                    )
                    valid = False
                    continue
                seen_subs[sub_value] = line.number
                absent = [k for k in sub_required if k not in line.values]
                if absent and line.valid:
                    for field_key in absent:
                        self._issue(
                            line.number,
                            spec.header(field_key),
                            None,
                            f"« {spec.header(field_key)} » est obligatoire pour un(e) {sub_what}.",
                        )
                    valid = False
                    continue
                if line.valid:
                    subs.append(build_sub(line))
            if valid:
                records.append(build(first.number, main, subs))
        return records
