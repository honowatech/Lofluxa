"""Moteur commun des imports « par enregistrements » (stations, camions, chauffeurs, dépôts, commandes).

Un `RecordKind` décrit un kind en trois temps, indépendants de la source des données :

1. `fetch(source, options)` : enregistrements normalisés fournis par une `ImportSource` ;
2. `plan(session, records, options)` : contrôles en base **en lecture seule** → anomalies + étapes
   (`Step` : effet annoncé `ImportItem` et fonction `run` qui l'appliquera) ;
3. application : le plan est **recalculé** à partir des données normalisées du lot et comparé à celui de
   la prévisualisation ; s'il diffère (la base a changé entre-temps), rien n'est écrit et l'utilisateur
   doit prévisualiser à nouveau. Aucune mise à jour non annoncée ne peut donc être appliquée.
"""

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import date, datetime, time
from decimal import Decimal
from enum import Enum
from typing import Any, ClassVar

from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import ImportKind, Role
from app.core.errors import ConflictError
from app.imports.columns import FileSpec
from app.imports.models import ImportBatch
from app.imports.registry import KindHandler, PreviewResult, UploadedFile
from app.imports.schemas import FieldChange, ImportItem, RowIssue
from app.imports.source import ExcelImportSource
from app.imports.templates import build_template


@dataclass
class Step:
    item: ImportItem
    run: Callable[[AsyncSession, ImportBatch], Awaitable[None]] | None = None


@dataclass
class Plan:
    issues: list[RowIssue] = field(default_factory=list)
    steps: list[Step] = field(default_factory=list)

    def error(self, row: int | None, column: str | None, value: Any, message: str) -> None:
        self.issues.append(RowIssue(row=row, column=column, value=_text(value), message=message))

    def warning(self, row: int | None, column: str | None, value: Any, message: str) -> None:
        self.issues.append(
            RowIssue(row=row, column=column, value=_text(value), message=message, severity="warning")
        )

    def error_count(self) -> int:
        return sum(1 for issue in self.issues if issue.severity == "error")


def _text(value: Any) -> str | None:
    return None if value is None else str(show(value))


def show(value: Any) -> Any:
    """Valeur affichable et sérialisable en JSON (avant / après d'un changement)."""
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, Decimal):
        value = float(value)
    if isinstance(value, float):
        return int(value) if value.is_integer() else round(value, 7)
    if isinstance(value, time):
        return value.strftime("%H:%M")
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): show(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [show(v) for v in value]
    return value


def same(old: Any, new: Any) -> bool:
    old, new = show(old), show(new)
    if isinstance(old, int | float) and isinstance(new, int | float) and not isinstance(old, bool):
        return abs(float(old) - float(new)) < 1e-6
    if isinstance(old, str) and isinstance(new, str):
        return old.strip() == new.strip()
    return old == new


def scalar_changes(
    obj: Any, record: BaseModel, spec: FileSpec, fields: dict[str, str]
) -> tuple[list[FieldChange], dict[str, Any]]:
    """Compare les champs fournis d'un enregistrement à l'objet en base.

    `fields` : champ de l'enregistrement → attribut du modèle. Un champ à `None` (cellule vide) est ignoré.
    Renvoie les changements à annoncer (vide pour une création) et les valeurs à écrire.
    """
    changes: list[FieldChange] = []
    updates: dict[str, Any] = {}
    for key, attr in fields.items():
        new = getattr(record, key)
        if new is None:
            continue
        old = getattr(obj, attr) if obj is not None else None
        if obj is None:
            updates[attr] = new
        elif not same(old, new):
            updates[attr] = new
            changes.append(FieldChange(field=attr, label=spec.header(key), before=show(old), after=show(new)))
    return changes, updates


def signature(items: list[ImportItem] | list[dict[str, Any]]) -> str:
    """Empreinte des effets annoncés, pour détecter une prévisualisation périmée."""
    normalized = [
        ImportItem.model_validate(item).model_dump(mode="json", exclude={"row"})
        if isinstance(item, dict)
        else item.model_dump(mode="json", exclude={"row"})
        for item in items
    ]
    return json.dumps(show(normalized), sort_keys=True, ensure_ascii=False)


class RecordKind:
    """Base d'un kind d'import par enregistrements. Une sous-classe définit `fetch` et `plan`."""

    kind: ClassVar[ImportKind]
    label: ClassVar[str]
    roles: ClassVar[tuple[Role, ...]]
    spec: ClassVar[FileSpec]
    record_model: ClassVar[type[BaseModel]]

    def parse_options(self, raw: dict[str, str]) -> dict[str, Any]:
        """Options de la requête de prévisualisation retenues par ce kind (sérialisables en JSON)."""
        return {}

    def fetch(self, source: ExcelImportSource, options: dict[str, Any]) -> list[Any]:
        raise NotImplementedError

    async def plan(self, session: AsyncSession, records: list[Any], options: dict[str, Any]) -> Plan:
        raise NotImplementedError

    async def preview(self, session: AsyncSession, file: UploadedFile, raw: dict[str, str]) -> PreviewResult:
        options = self.parse_options(raw)
        source = ExcelImportSource(file.content, file.filename)
        records = self.fetch(source, options)
        plan = await self.plan(session, records, options)
        return PreviewResult(
            row_count=source.row_count,
            issues=sorted(source.issues + plan.issues, key=lambda i: (i.row or 0, i.severity)),
            items=[step.item for step in plan.steps],
            data=[record.model_dump(mode="json") for record in records],
            options=options,
        )

    async def apply(self, session: AsyncSession, batch: ImportBatch) -> dict[str, Any]:
        report = batch.report or {}
        records = [self.record_model.model_validate(data) for data in report.get("data", [])]
        plan = await self.plan(session, records, report.get("options", {}))
        if plan.error_count() or signature([s.item for s in plan.steps]) != signature(
            report.get("items", [])
        ):
            raise ConflictError(
                "Les données ont changé depuis la prévisualisation : relancez la prévisualisation du fichier "
                "avant d'appliquer.",
                code="stale_preview",
                details=[i.model_dump() for i in plan.issues if i.severity == "error"],
            )
        counts = {"created": 0, "updated": 0, "unchanged": 0}
        for step in plan.steps:
            if step.run is not None and step.item.action != "unchanged":
                await step.run(session, batch)
            counts[{"create": "created", "update": "updated"}.get(step.item.action, "unchanged")] += 1
        await session.flush()
        return counts

    def handler(self) -> KindHandler:
        return KindHandler(
            kind=self.kind,
            label=self.label,
            roles=self.roles,
            preview=self.preview,
            apply=self.apply,
            template=lambda: build_template(self.spec),
        )
