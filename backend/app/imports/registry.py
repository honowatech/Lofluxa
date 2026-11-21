"""Registre des types d'import (« kinds ») : kind → prévisualisation / application / fichier modèle.

Le routeur (`app/imports/router.py`) ne connaît aucun kind en particulier : il délègue au `KindHandler`
enregistré ici. **Ajouter un kind ne demande de modifier aucun fichier existant** :

1. créer un module dans `app/imports/` (ex. `app/imports/reference_day.py`, lot L7) — c'est aussi le seul
   endroit où un fichier Excel / CSV peut être lu (utiliser `app.imports.tabular.read_table`) ;
2. y appeler `register_kind(KindHandler(...))` au niveau du module.

Tous les modules de `app/imports/` sont importés automatiquement à la première utilisation du registre
(`load_kinds`), donc l'enregistrement se fait tout seul. Exemple minimal :

    from app.core.enums import ImportKind, Role
    from app.imports.registry import KindHandler, PreviewResult, UploadedFile, register_kind
    from app.imports.schemas import ImportItem, RowIssue
    from app.imports.tabular import FileError, read_table

    async def preview(session, file: UploadedFile, options: dict[str, str]) -> PreviewResult:
        table = read_table(file.content, file.filename, sheet="Tournées")   # peut lever FileError
        ...                                  # contrôles en lecture seule : ne rien écrire en base ici
        return PreviewResult(row_count=len(table.rows), issues=[...], items=[...], data=[...])

    async def apply(session, batch) -> dict:
        records = batch.report["data"]       # données normalisées produites par `preview`
        ...                                  # écritures via l'ORM (pas de commit : le routeur s'en charge)
        return {"plan_id": "..."}            # rangé dans report["applied"]

    register_kind(KindHandler(kind=ImportKind.REFERENCE_DAY, label="Journée de référence",
                              roles=(Role.DISPATCHER,), preview=preview, apply=apply, template=make_xlsx))

Contrat d'un handler :
- `preview(session, file, options)` : lit et contrôle, **sans écrire**. `options` = paramètres de requête
  de l'appel (ex. `day`). Renvoie les anomalies (`RowIssue`, gravité `error` ou `warning`), les effets
  annoncés (`ImportItem` : création / mise à jour / inchangé) et les données normalisées (JSON). Le routeur
  crée le lot `import_batches` : statut `previewed`, ou `rejected` s'il y a au moins une erreur.
- `apply(session, batch)` : applique `batch.report["data"]`. Appelé seulement pour un lot `previewed`
  (jamais pour un lot en erreur ou déjà appliqué). Lève `ConflictError` si la base a changé au point que
  la prévisualisation n'est plus valable. Renvoie un résumé libre (dict JSON).
- `template()` : contenu du fichier modèle .xlsx (facultatif).
- `roles` : rôles autorisés à prévisualiser et appliquer (`admin` passe toujours).
"""

import importlib
import pkgutil
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

import app.imports as _package
from app.core.enums import ImportKind, Role
from app.imports.models import ImportBatch
from app.imports.schemas import ImportItem, RowIssue


@dataclass(frozen=True)
class UploadedFile:
    content: bytes
    filename: str


@dataclass
class PreviewResult:
    row_count: int
    issues: list[RowIssue] = field(default_factory=list)
    items: list[ImportItem] = field(default_factory=list)
    data: list[dict[str, Any]] = field(default_factory=list)
    options: dict[str, Any] = field(default_factory=dict)  # options retenues, rangées dans le rapport


@dataclass(frozen=True)
class KindHandler:
    kind: ImportKind
    label: str
    roles: tuple[Role, ...]
    preview: Callable[[AsyncSession, UploadedFile, dict[str, str]], Awaitable[PreviewResult]]
    apply: Callable[[AsyncSession, ImportBatch], Awaitable[dict[str, Any]]]
    template: Callable[[], bytes] | None = None


_KINDS: dict[ImportKind, KindHandler] = {}
_loaded = False
# Modules d'infrastructure du paquet, sans kind à enregistrer.
_SKIP = {"models", "router", "registry"}


def register_kind(handler: KindHandler) -> KindHandler:
    """Enregistre (ou remplace) le handler d'un kind."""
    _KINDS[ImportKind(handler.kind)] = handler
    return handler


def load_kinds() -> None:
    """Importe tous les modules de `app/imports/` pour que chacun enregistre ses kinds (une seule fois)."""
    global _loaded
    if _loaded:
        return
    _loaded = True
    for module in pkgutil.iter_modules(_package.__path__):
        if module.name not in _SKIP:
            importlib.import_module(f"{_package.__name__}.{module.name}")


def get_kind(kind: ImportKind | str) -> KindHandler | None:
    load_kinds()
    try:
        return _KINDS.get(ImportKind(kind))
    except ValueError:
        return None


def registered_kinds() -> dict[ImportKind, KindHandler]:
    load_kinds()
    return dict(_KINDS)
