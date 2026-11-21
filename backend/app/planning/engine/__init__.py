"""Moteur de tournées (spec §7) — point d'entrée unique.

>>> LOT L2 : ce paquet est un gabarit. Les signatures ci-dessous sont le contrat ; à implémenter
    dans or_tools_solver.py, compartments.py, distance_matrix.py, osrm_client.py, objective.py.
"""

from __future__ import annotations

from collections.abc import Callable

from app.planning.domain import Matrix, PlanningProblem, PlanningResult

ENGINE_VERSION = "0.0.0-gabarit"

# Rappel de progression : (pourcentage 0-100, message en français).
ProgressCallback = Callable[[int, str], None]


def solve(
    problem: PlanningProblem,
    matrix: Matrix,
    progress: ProgressCallback | None = None,
) -> PlanningResult:
    """Calcule le plan de tournées du jour J.

    - ne modifie pas les tournées de `problem.locked_trips` et les renvoie telles quelles (RM-17),
      leurs ressources et volumes étant déduits de ce qui reste à planifier ;
    - toute commande non servie figure dans `unserved` avec sa raison (F4.4), urgentes en tête (RM-15) ;
    - horaires finaux calculés par `app.planning.timing.schedule_trip` ;
    - `violations` = `rules.check_plan(...)` sur le résultat ;
    - déterministe : même entrée + même graine (`params.solver_seed`) → même sortie.
    """
    raise NotImplementedError("Lot L2 — moteur de tournées")
