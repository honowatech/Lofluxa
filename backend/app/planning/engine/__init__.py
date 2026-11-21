"""Moteur de tournées (spec §7) — point d'entrée unique.

    from app.planning.engine import solve, ENGINE_VERSION

Modules : `or_tools_solver` (orchestration), `routing_model` (modèle OR-Tools), `context`
(préparation), `plan_builder` / `scheduling` / `drivers` (post-traitement), `rescue` (repêchage),
`compartments`, `distance_matrix`, `osrm_client`, `objective`, `metrics`.
"""

from __future__ import annotations

from collections.abc import Callable

from app.planning.domain import Matrix, PlanningProblem, PlanningResult
from app.planning.engine.version import ENGINE_VERSION

__all__ = ["ENGINE_VERSION", "ProgressCallback", "solve"]

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
    # Import différé : OR-Tools n'est chargé qu'au premier calcul (l'API démarre sans lui).
    from app.planning.engine.or_tools_solver import solve as _solve

    return _solve(problem, matrix, progress)
