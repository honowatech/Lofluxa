"""Défauts d'intégration encore ouverts, débusqués par les scénarios de bout en bout (lot L15).

Chaque test décrit le comportement **attendu** et échoue aujourd'hui : il est marqué
`xfail(strict=True)` avec sa raison (fichier et fonction en cause). Le jour où le lot propriétaire
corrige, le test passe, `strict` le signale : retirer la marque et déplacer le test dans
`test_non_regression.py`. Le détail (entrée, attendu, constaté, piste) est dans `docs/DEMO.md` §5.
"""

from __future__ import annotations
