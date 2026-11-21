"""Matrice distances/durées (spec §7.2) : OSRM `/table` + cache, repli haversine."""

from __future__ import annotations

import hashlib
import logging
from typing import Protocol

from app.core.geo import haversine_m
from app.planning.domain import Matrix, Params, PlanningProblem
from app.planning.engine.osrm_client import OsrmClient, OsrmError

logger = logging.getLogger(__name__)

COORD_DECIMALS = 5  # spec §7.2 : coordonnées arrondies à 5 décimales (≈ 1 m)


class DistanceCacheStore(Protocol):
    """Accès au cache `distance_cache`. Implémentation base fournie par le lot L5 (service de plans)."""

    def get_many(self, pairs: list[tuple[str, str]]) -> dict[tuple[str, str], tuple[int, int]]:
        """(origin_hash, dest_hash) → (distance_m, duration_s) pour les paires connues."""
        ...

    def put_many(self, entries: dict[tuple[str, str], tuple[int, int]]) -> None: ...


class InMemoryDistanceCache:
    """Cache en mémoire (tests, scripts, calculs hors base) — respecte `DistanceCacheStore`."""

    def __init__(self) -> None:
        self._entries: dict[tuple[str, str], tuple[int, int]] = {}

    def get_many(self, pairs: list[tuple[str, str]]) -> dict[tuple[str, str], tuple[int, int]]:
        return {pair: self._entries[pair] for pair in pairs if pair in self._entries}

    def put_many(self, entries: dict[tuple[str, str], tuple[int, int]]) -> None:
        self._entries.update(entries)

    def __len__(self) -> int:
        return len(self._entries)


def coord_hash(lat: float, lon: float) -> str:
    """Clé de cache : hash (SHA-1, 40 caractères) des coordonnées arrondies à 5 décimales."""
    # « + 0.0 » : évite que −0.0 et 0.0 donnent deux clés différentes.
    rounded = (round(lat, COORD_DECIMALS) + 0.0, round(lon, COORD_DECIMALS) + 0.0)
    key = ",".join(f"{value:.{COORD_DECIMALS}f}" for value in rounded)
    return hashlib.sha1(key.encode("ascii"), usedforsecurity=False).hexdigest()


def problem_nodes(problem: PlanningProblem) -> list[tuple[str, float, float]]:
    """Nœuds `(id, lat, lon)` d'un problème : tous les dépôts, puis les stations concernées par les
    commandes du jour ou par une tournée verrouillée."""
    needed = {o.station_id for o in problem.orders}
    needed |= {stop.station_id for trip in problem.locked_trips for stop in trip.stops}
    nodes = [(d.id, d.lat, d.lon) for d in problem.depots]
    nodes += [(s.id, s.lat, s.lon) for s in problem.stations if s.id in needed]
    return nodes


def haversine_matrix(nodes: list[tuple[str, float, float]], params: Params) -> Matrix:
    """Repli sans OSRM : haversine × coefficient, vitesse moyenne paramétrée ; `approximate=True`."""
    speed_m_s = params.default_avg_speed_kmh * 1000.0 / 3600.0
    size = len(nodes)
    distance = [[0] * size for _ in range(size)]
    duration = [[0] * size for _ in range(size)]
    for i, (_, lat1, lon1) in enumerate(nodes):
        for j, (_, lat2, lon2) in enumerate(nodes):
            if i == j:
                continue
            meters = haversine_m(lat1, lon1, lat2, lon2) * params.haversine_factor
            distance[i][j] = int(round(meters))
            duration[i][j] = int(round(meters / speed_m_s))
    return Matrix(tuple(n[0] for n in nodes), distance, duration, approximate=True)


def build_matrix(
    nodes: list[tuple[str, float, float]],
    params: Params,
    *,
    osrm_url: str | None = None,
    cache: DistanceCacheStore | None = None,
    client: OsrmClient | None = None,
) -> Matrix:
    """Construit la matrice entre tous les nœuds `(node_id, lat, lon)` (dépôts + stations).

    OSRM `/table` avec mise en cache ; repli si OSRM est indisponible ou `osrm_url` est None :
    haversine × `params.haversine_factor` et vitesse `params.default_avg_speed_kmh`, avec
    `Matrix.approximate = True`.

    Le cache est consulté d'abord : si toutes les paires y sont, OSRM n'est pas appelé. Sinon un
    seul appel `/table` complète les lignes manquantes, et les nouvelles paires sont mises en cache.
    Les valeurs du repli haversine ne sont jamais mises en cache. `client` permet d'injecter un
    client OSRM (tests) ; à défaut il est créé à partir de `osrm_url`.
    """
    if client is None and osrm_url:
        client = OsrmClient(osrm_url)
    if client is None:
        return haversine_matrix(nodes, params)

    size = len(nodes)
    hashes = [coord_hash(lat, lon) for _, lat, lon in nodes]
    pairs = sorted({(hashes[i], hashes[j]) for i in range(size) for j in range(size) if i != j})
    known: dict[tuple[str, str], tuple[int, int]] = {}
    if cache is not None and pairs:
        known = dict(cache.get_many(pairs))

    missing_rows = [
        i for i in range(size) if any(j != i and (hashes[i], hashes[j]) not in known for j in range(size))
    ]
    if missing_rows:
        coords = [(lat, lon) for _, lat, lon in nodes]
        try:
            distances, durations = client.table(coords, sources=missing_rows)
        except OsrmError as exc:
            logger.warning("Repli haversine pour la matrice de distances : %s", exc)
            return haversine_matrix(nodes, params)
        fresh: dict[tuple[str, str], tuple[int, int]] = {}
        for row, i in enumerate(missing_rows):
            for j in range(size):
                if i != j:
                    fresh[(hashes[i], hashes[j])] = (distances[row][j], durations[row][j])
        known.update(fresh)
        if cache is not None:
            cache.put_many(fresh)

    distance = [[0] * size for _ in range(size)]
    duration = [[0] * size for _ in range(size)]
    for i in range(size):
        for j in range(size):
            if i != j and hashes[i] != hashes[j]:
                distance[i][j], duration[i][j] = known[(hashes[i], hashes[j])]
    return Matrix(tuple(n[0] for n in nodes), distance, duration, approximate=False)
