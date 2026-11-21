"""Règles métier RM-xx — SOURCE UNIQUE DE VÉRITÉ (spec §6, §8.2).

Une fonction par règle, appelée à la fois par le moteur (filtrage) et par l'édition manuelle
(contrôle). Chaque règle a un test unitaire qui la cite : `test_RM_05_...`.

>>> LOT L1 : ce fichier est un gabarit. Les signatures ci-dessous sont le contrat ; à implémenter.
"""

from __future__ import annotations

from app.planning.domain import Matrix, PlanningProblem, TripD, UnservedD, ViolationD


def check_plan(
    problem: PlanningProblem,
    trips: list[TripD],
    unserved: list[UnservedD] | None = None,
    matrix: Matrix | None = None,
) -> list[ViolationD]:
    """Contrôle complet d'un plan : renvoie toutes les violations (bloquantes et avertissements).

    Les horaires des tournées (`start_s`, `depart_s`, `arrival_s`…) sont supposés à jour
    (voir `app.planning.timing.schedule_trip`). `matrix` est facultative (non requise par les règles).
    """
    raise NotImplementedError("Lot L1 — règles métier")


def has_blocking(violations: list[ViolationD]) -> bool:
    return any(v.severity == "blocking" for v in violations)
