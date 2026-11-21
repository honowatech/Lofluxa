"""Cache des distances en base (table `distance_cache`, spec §7.2) — implémentation du
`DistanceCacheStore` attendu par `engine.distance_matrix.build_matrix`.

Le protocole du moteur est synchrone alors que la session de l'API est asynchrone : le cache est
donc **préchargé** en mémoire avant la construction de la matrice (`preload`), sert les lectures
depuis la mémoire, met les écritures en attente, puis les enregistre après coup (`flush`).

    cache = DbDistanceCache()
    await cache.preload(session, hashes)
    matrix = build_matrix(nodes, params, osrm_url=..., cache=cache)
    await cache.flush(session)
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.planning.models import DistanceCache

Pair = tuple[str, str]
Entry = tuple[int, int]  # (distance_m, duration_s)


class DbDistanceCache:
    """Cache `distance_cache` préchargé ; conforme au protocole `DistanceCacheStore`."""

    def __init__(self) -> None:
        self._known: dict[Pair, Entry] = {}
        self._pending: dict[Pair, Entry] = {}

    async def preload(self, session: AsyncSession, hashes: list[str]) -> None:
        """Charge toutes les paires connues entre les nœuds dont on donne les hash."""
        unique = sorted(set(hashes))
        if not unique:
            return
        rows = await session.execute(
            select(DistanceCache).where(
                DistanceCache.origin_hash.in_(unique), DistanceCache.dest_hash.in_(unique)
            )
        )
        for row in rows.scalars():
            self._known[(row.origin_hash, row.dest_hash)] = (row.distance_m, row.duration_s)

    def get_many(self, pairs: list[Pair]) -> dict[Pair, Entry]:
        return {pair: self._known[pair] for pair in pairs if pair in self._known}

    def put_many(self, entries: dict[Pair, Entry]) -> None:
        for pair, value in entries.items():
            value = (int(value[0]), int(value[1]))
            if self._known.get(pair) != value:
                self._pending[pair] = value
            self._known[pair] = value

    async def flush(self, session: AsyncSession) -> int:
        """Enregistre les paires mises en attente (insertion ou mise à jour). Renvoie leur nombre."""
        if not self._pending:
            return 0
        now = utcnow()
        values = [
            {
                "origin_hash": origin,
                "dest_hash": dest,
                "distance_m": distance,
                "duration_s": duration,
                "computed_at": now,
            }
            for (origin, dest), (distance, duration) in self._pending.items()
        ]
        stmt = insert(DistanceCache).values(values)
        stmt = stmt.on_conflict_do_update(
            index_elements=[DistanceCache.origin_hash, DistanceCache.dest_hash],
            set_={
                "distance_m": stmt.excluded.distance_m,
                "duration_s": stmt.excluded.duration_s,
                "computed_at": stmt.excluded.computed_at,
            },
        )
        await session.execute(stmt)
        count = len(self._pending)
        self._pending.clear()
        return count
