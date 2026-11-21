"""Matrice distances/durées (spec §7.2) — gabarit, LOT L2."""

from __future__ import annotations

from typing import Protocol

from app.planning.domain import Matrix, Params


class DistanceCacheStore(Protocol):
    """Accès au cache `distance_cache`. Implémentation base fournie par le lot L5 (service de plans)."""

    def get_many(self, pairs: list[tuple[str, str]]) -> dict[tuple[str, str], tuple[int, int]]:
        """(origin_hash, dest_hash) → (distance_m, duration_s) pour les paires connues."""
        ...

    def put_many(self, entries: dict[tuple[str, str], tuple[int, int]]) -> None: ...


def coord_hash(lat: float, lon: float) -> str:
    """Clé de cache : hash des coordonnées arrondies à 5 décimales."""
    raise NotImplementedError("Lot L2")


def build_matrix(
    nodes: list[tuple[str, float, float]],
    params: Params,
    *,
    osrm_url: str | None = None,
    cache: DistanceCacheStore | None = None,
) -> Matrix:
    """Construit la matrice entre tous les nœuds `(node_id, lat, lon)` (dépôts + stations).

    OSRM `/table` avec mise en cache ; repli si OSRM est indisponible ou `osrm_url` est None :
    haversine × `params.haversine_factor` et vitesse `params.default_avg_speed_kmh`, avec
    `Matrix.approximate = True`.
    """
    raise NotImplementedError("Lot L2 — matrice de distances")
