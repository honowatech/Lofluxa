"""Client OSRM minimal : service `/table` (spec §7.2).

Synchrone (httpx) : le moteur tourne dans une tâche de fond Celery. Toute erreur (réseau, statut
HTTP, réponse incomplète) est convertie en `OsrmError` ; l'appelant décide du repli.
"""

from __future__ import annotations

import httpx

DEFAULT_TIMEOUT_S = 20.0


class OsrmError(RuntimeError):
    """OSRM indisponible ou réponse inexploitable."""


class OsrmClient:
    def __init__(
        self,
        base_url: str,
        *,
        profile: str = "driving",
        timeout_s: float = DEFAULT_TIMEOUT_S,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._profile = profile
        self._timeout_s = timeout_s
        self._transport = transport  # injectable pour les tests (httpx.MockTransport)

    def table(
        self,
        coords: list[tuple[float, float]],
        *,
        sources: list[int] | None = None,
        destinations: list[int] | None = None,
    ) -> tuple[list[list[int]], list[list[int]]]:
        """Matrices (distances en mètres, durées en secondes) entre des points `(lat, lon)`.

        `sources` / `destinations` : indices dans `coords` (par défaut : tous les points).
        """
        if not coords:
            return [], []
        # OSRM attend « lon,lat ».
        path = ";".join(f"{lon:.6f},{lat:.6f}" for lat, lon in coords)
        query: dict[str, str] = {"annotations": "distance,duration"}
        if sources is not None:
            query["sources"] = ";".join(str(i) for i in sources)
        if destinations is not None:
            query["destinations"] = ";".join(str(i) for i in destinations)
        url = f"{self._base_url}/table/v1/{self._profile}/{path}"
        try:
            with httpx.Client(timeout=self._timeout_s, transport=self._transport) as client:
                response = client.get(url, params=query)
                response.raise_for_status()
                payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise OsrmError(f"OSRM injoignable ou réponse invalide : {exc}") from exc

        if not isinstance(payload, dict) or payload.get("code") != "Ok":
            code = payload.get("code") if isinstance(payload, dict) else None
            raise OsrmError(f"OSRM a répondu « {code} ».")
        distances, durations = payload.get("distances"), payload.get("durations")
        n_rows = len(sources) if sources is not None else len(coords)
        n_cols = len(destinations) if destinations is not None else len(coords)
        for name, table in (("distances", distances), ("durations", durations)):
            if not isinstance(table, list) or len(table) != n_rows:
                raise OsrmError(f"Réponse OSRM incomplète (« {name} »).")
            for row in table:
                if not isinstance(row, list) or len(row) != n_cols or any(v is None for v in row):
                    raise OsrmError(f"Réponse OSRM incomplète (« {name} ») : paire sans itinéraire.")
        return (
            [[int(round(v)) for v in row] for row in distances],
            [[int(round(v)) for v in row] for row in durations],
        )
