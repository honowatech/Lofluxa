"""Paramètres métier : toute valeur paramétrable vit dans la table `settings` (spec §0, F9.2).

`DEFAULTS` décrit les clés connues, leur valeur par défaut et leur description. Les valeurs par
défaut sont insérées par `python -m app.cli seed` ; une clé absente de la table retombe sur son défaut.
Pour ajouter un paramètre : l'ajouter ici (et dans `Params` s'il concerne le moteur ou les règles).
"""

from dataclasses import fields
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.admin.models import Setting
from app.planning.domain import Params

# clé → (valeur par défaut, description)
DEFAULTS: dict[str, tuple[Any, str]] = {
    "default_avg_speed_kmh": (40.0, "Vitesse moyenne par défaut des camions (km/h)"),
    "max_service_hours": (11.0, "Durée maximale de service d'un chauffeur par jour (heures) — RM-11"),
    "default_depot_wait_min": (90, "Temps d'attente moyen au dépôt avant chargement (minutes)"),
    "depot_loading_time_min": (45, "Durée d'un chargement au dépôt (minutes)"),
    "default_unload_time_min": (45, "Temps de dépotage par défaut en station (minutes)"),
    "default_max_loadings_per_truck_day": (2, "Nombre max de chargements par camion et par jour — RM-14"),
    "compartment_safety_margin_pct": (2.0, "Marge de sécurité sur la capacité des compartiments (%) — RM-05"),
    "loading_tolerance_pct": (2.0, "Tolérance d'écart volume chargé / planifié (%) — RM-13"),
    "window_tolerance_min": (30, "Dépassement de fenêtre toléré en avertissement (minutes) — RM-10"),
    "partial_delivery_min_pct": (50.0, "Part minimale livrable d'une commande (%) — RM-16"),
    "day_start_time": ("06:00", "Heure de début de journée (heure locale)"),
    "timezone": ("Africa/Douala", "Fuseau horaire d'affichage"),
    "objective_distance_weight": (1.0, "Objectif : poids de la distance totale"),
    "objective_vehicle_fixed_cost_km": (40.0, "Objectif : coût fixe par véhicule utilisé (km équivalents)"),
    "objective_unserved_penalty_normal_km": (500.0, "Objectif : pénalité commande normale non servie (km)"),
    "objective_unserved_penalty_urgent_km": (5000.0, "Objectif : pénalité commande urgente non servie (km)"),
    "solver_time_limit_s": (45, "Limite de temps du solveur (secondes)"),
    "solver_no_improvement_s": (10, "Arrêt anticipé du solveur sans amélioration (secondes)"),
    "solver_seed": (42, "Graine du solveur (reproductibilité)"),
    "haversine_factor": (1.3, "Coefficient appliqué à la distance à vol d'oiseau si OSRM est indisponible"),
    "ab_success_threshold_pct": (10.0, "Seuil de réussite du test A/B : gain kilométrique minimal (%)"),
    "import_max_file_mb": (10, "Taille maximale d'un fichier d'import (Mo)"),
    "company_name": ("OLA Energy Cameroun", "Nom affiché en en-tête des documents PDF"),
    "pdf_logo_url": (None, "Logo des documents PDF (URL ou chemin de fichier ; vide = nom en texte)"),
}


def _merge(rows: list[Setting]) -> dict[str, Any]:
    values = {key: default for key, (default, _) in DEFAULTS.items()}
    values.update({row.key: row.value for row in rows})
    return values


async def load_settings(session: AsyncSession) -> dict[str, Any]:
    """Tous les paramètres (valeurs en base, complétées par les défauts)."""
    rows = (await session.execute(select(Setting))).scalars().all()
    return _merge(list(rows))


def load_settings_sync(session: Session) -> dict[str, Any]:
    return _merge(list(session.execute(select(Setting)).scalars().all()))


async def get_setting(session: AsyncSession, key: str) -> Any:
    row = await session.get(Setting, key)
    if row is not None:
        return row.value
    if key in DEFAULTS:
        return DEFAULTS[key][0]
    raise KeyError(f"Paramètre inconnu : {key}")


def params_from_settings(values: dict[str, Any], override: dict[str, Any] | None = None) -> Params:
    """Construit les paramètres du moteur à partir des réglages (+ surcharge ponctuelle d'un calcul)."""
    merged = {**values, **(override or {})}
    names = {f.name for f in fields(Params)}
    return Params(**{name: merged[name] for name in names if name in merged and merged[name] is not None})


async def load_params(session: AsyncSession, override: dict[str, Any] | None = None) -> Params:
    return params_from_settings(await load_settings(session), override)
