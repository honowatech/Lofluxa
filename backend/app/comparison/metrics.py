"""Indicateurs d'un plan et comparaison de deux plans (F8.4) — module pur, sans base ni FastAPI.

Entrée : `PlanM`, une vue minimale d'un plan (tournées, arrêts, livraisons, commandes demandées,
violations, temps de préparation). Sortie : `PlanMetrics`, puis `compare` (écarts) et `verdict`
(seuil `ab_success_threshold_pct`, critères d'acceptation 1 et 2 de la spec §13).

Définition des indicateurs
--------------------------
Une tournée « compte » si elle a au moins un arrêt ; les tournées vides sont ignorées partout.
Les commandes « demandées » d'un plan sont celles qu'il devait servir : commandes présentes dans
ses livraisons + commandes non servies (`unserved_orders`).

- `distance_estimated_m` : somme des `trips.distance_m` (dépôt → arrêts → dépôt, matrice du moteur).
- `distance_actual_m` : somme des `trips.actual_distance_m` renseignés ; `None` si aucune tournée
  n'a de km réels. `distance_actual_trips` dit sur combien de tournées porte cette somme : si ce
  nombre est inférieur à `trips_count`, le total réel est partiel et n'est pas comparable tel quel.
- `trucks_used` / `drivers_used` : camions / chauffeurs distincts (tournée sans chauffeur : non compté).
- `trips_count` : nombre de tournées.
- `stations_requested` : stations distinctes des commandes demandées.
- `stations_served` : stations distinctes ayant au moins une livraison planifiée de volume > 0.
- `stations_delivered` : stations distinctes ayant un arrêt au statut `delivered` ; `None` tant
  qu'aucun arrêt du plan n'a été réalisé (tous `pending`).
- `orders_requested` / `orders_served` : commandes demandées / ayant un volume planifié > 0.
- `volume_requested_l` : somme des volumes demandés des commandes demandées.
- `volume_planned_l` : somme des volumes planifiés des livraisons.
- `volume_delivered_l` : somme des volumes réels (`actual_l`) renseignés ; `None` si aucun.
- `service_duration_s` : somme des durées de service prévues (retour − départ du dépôt, RM-11).
- `service_duration_actual_s` : somme des (retour réel − départ réel) des tournées où les deux
  heures sont connues ; `None` si aucune.
- `fill_rate_avg_pct` : moyenne simple, sur les tournées, de
  (volume planifié de la tournée ÷ capacité du camion) × 100, la capacité étant la somme de ses
  compartiments ; les tournées dont le camion n'a pas de capacité connue sont exclues ; `None`
  s'il n'en reste aucune.
- `violations_blocking` / `violations_warning` / `violations_total` : lignes de `constraint_violations`.
- `prep_time_s` : `plans.prep_time_s` s'il est saisi (plan manuel), sinon `computed_in_ms` arrondi
  à la seconde (plan calculé) ; `prep_time_source` vaut `manual`, `computed` ou `None`.

Écarts : `delta` = B − A ; `delta_pct` = (B − A) ÷ A × 100 ; 0 si A et B valent 0 ; `None` si A
vaut 0 et pas B (pourcentage indéfini) ou si l'une des deux valeurs est inconnue.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

DELIVERED = "delivered"
PENDING = "pending"


# --------------------------------------------------------------------------- entrées


@dataclass(frozen=True, slots=True)
class DeliveryM:
    order_id: str
    planned_l: float
    actual_l: float | None = None


@dataclass(frozen=True, slots=True)
class StopM:
    station_id: str
    status: str = PENDING
    deliveries: tuple[DeliveryM, ...] = ()


@dataclass(frozen=True, slots=True)
class TripM:
    truck_id: str
    driver_id: str | None = None
    truck_capacity_l: float = 0.0
    distance_m: int = 0
    duration_s: int = 0  # durée de service prévue (retour − départ du dépôt)
    actual_distance_m: int | None = None
    actual_duration_s: int | None = None  # retour réel − départ réel, si les deux sont connus
    stops: tuple[StopM, ...] = ()


@dataclass(frozen=True, slots=True)
class OrderM:
    id: str
    station_id: str
    requested_l: float


@dataclass(frozen=True, slots=True)
class PlanM:
    trips: tuple[TripM, ...] = ()
    orders: tuple[OrderM, ...] = ()  # commandes demandées (servies + non servies)
    violations_blocking: int = 0
    violations_warning: int = 0
    prep_time_s: int | None = None
    computed_in_ms: int | None = None


# --------------------------------------------------------------------------- sorties


@dataclass(frozen=True, slots=True)
class PlanMetrics:
    distance_estimated_m: int
    distance_actual_m: int | None
    distance_actual_trips: int
    trucks_used: int
    drivers_used: int
    trips_count: int
    stations_requested: int
    stations_served: int
    stations_delivered: int | None
    orders_requested: int
    orders_served: int
    volume_requested_l: float
    volume_planned_l: float
    volume_delivered_l: float | None
    service_duration_s: int
    service_duration_actual_s: int | None
    fill_rate_avg_pct: float | None
    violations_blocking: int
    violations_warning: int
    violations_total: int
    prep_time_s: int | None
    prep_time_source: str | None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class Indicator:
    key: str
    label: str
    unit: str  # m | s | l | pct | count
    lower_is_better: bool | None  # None : ni mieux ni moins bien (grandeur de contexte)


# Ordre d'affichage du tableau comparatif (F8.4).
INDICATORS: tuple[Indicator, ...] = (
    Indicator("distance_estimated_m", "Kilomètres estimés", "m", True),
    Indicator("distance_actual_m", "Kilomètres réels", "m", True),
    Indicator("trucks_used", "Camions mobilisés", "count", True),
    Indicator("drivers_used", "Chauffeurs mobilisés", "count", True),
    Indicator("trips_count", "Tournées", "count", True),
    Indicator("stations_requested", "Stations demandées", "count", None),
    Indicator("stations_served", "Stations servies par le plan", "count", False),
    Indicator("stations_delivered", "Stations réellement livrées", "count", False),
    Indicator("orders_requested", "Commandes demandées", "count", None),
    Indicator("orders_served", "Commandes servies par le plan", "count", False),
    Indicator("volume_requested_l", "Volume demandé", "l", None),
    Indicator("volume_planned_l", "Volume planifié", "l", False),
    Indicator("volume_delivered_l", "Volume réellement livré", "l", False),
    Indicator("service_duration_s", "Durée totale de service prévue", "s", True),
    Indicator("service_duration_actual_s", "Durée totale de service réelle", "s", True),
    Indicator("fill_rate_avg_pct", "Taux de remplissage moyen", "pct", False),
    Indicator("violations_blocking", "Violations bloquantes", "count", True),
    Indicator("violations_warning", "Avertissements", "count", True),
    Indicator("violations_total", "Violations (total)", "count", True),
    Indicator("prep_time_s", "Temps de préparation du plan", "s", True),
)


@dataclass(frozen=True, slots=True)
class MetricDelta:
    key: str
    label: str
    unit: str
    a: float | None
    b: float | None
    delta: float | None
    delta_pct: float | None
    better: str | None  # "a" | "b" | "equal" | None (inconnu ou sans sens)


@dataclass(frozen=True, slots=True)
class Verdict:
    """Verdict du test A/B : A = plan de référence (manuel), B = plan comparé (calculé)."""

    threshold_pct: float
    distance_a_m: int
    distance_b_m: int
    gain_m: int
    gain_pct: float | None  # (A − B) ÷ A × 100 sur les km estimés ; None si A = 0
    success: bool | None  # gain_pct ≥ seuil (critère d'acceptation 2) ; None si non calculable
    # Même calcul avec les km réels de A, s'ils sont connus pour toutes ses tournées (information).
    gain_vs_actual_pct: float | None
    no_blocking_violation: bool  # critère 1 : B sans violation bloquante
    orders_served_ok: bool  # critère 1 : B sert au moins autant de commandes que A
    message: str


# --------------------------------------------------------------------------- calcul


def compute_metrics(plan: PlanM) -> PlanMetrics:
    trips = [t for t in plan.trips if t.stops]

    actual_distances = [t.actual_distance_m for t in trips if t.actual_distance_m is not None]
    actual_durations = [t.actual_duration_s for t in trips if t.actual_duration_s is not None]

    planned_by_order: dict[str, float] = {}
    served_stations: set[str] = set()
    delivered_stations: set[str] = set()
    any_realized = False
    volume_planned = 0.0
    actual_volumes: list[float] = []
    fill_rates: list[float] = []

    for trip in trips:
        trip_volume = 0.0
        for stop in trip.stops:
            if stop.status != PENDING:
                any_realized = True
            if stop.status == DELIVERED:
                delivered_stations.add(stop.station_id)
            for delivery in stop.deliveries:
                trip_volume += delivery.planned_l
                planned_by_order[delivery.order_id] = (
                    planned_by_order.get(delivery.order_id, 0.0) + delivery.planned_l
                )
                if delivery.planned_l > 0:
                    served_stations.add(stop.station_id)
                if delivery.actual_l is not None:
                    actual_volumes.append(delivery.actual_l)
        volume_planned += trip_volume
        if trip.truck_capacity_l > 0:
            fill_rates.append(trip_volume / trip.truck_capacity_l * 100)

    if plan.prep_time_s is not None:
        prep_time_s, prep_source = plan.prep_time_s, "manual"
    elif plan.computed_in_ms is not None:
        prep_time_s, prep_source = round(plan.computed_in_ms / 1000), "computed"
    else:
        prep_time_s, prep_source = None, None

    return PlanMetrics(
        distance_estimated_m=sum(t.distance_m for t in trips),
        distance_actual_m=sum(actual_distances) if actual_distances else None,
        distance_actual_trips=len(actual_distances),
        trucks_used=len({t.truck_id for t in trips}),
        drivers_used=len({t.driver_id for t in trips if t.driver_id is not None}),
        trips_count=len(trips),
        stations_requested=len({o.station_id for o in plan.orders}),
        stations_served=len(served_stations),
        stations_delivered=len(delivered_stations) if any_realized else None,
        orders_requested=len(plan.orders),
        orders_served=sum(1 for volume in planned_by_order.values() if volume > 0),
        volume_requested_l=round(sum(o.requested_l for o in plan.orders), 2),
        volume_planned_l=round(volume_planned, 2),
        volume_delivered_l=round(sum(actual_volumes), 2) if actual_volumes else None,
        service_duration_s=sum(t.duration_s for t in trips),
        service_duration_actual_s=sum(actual_durations) if actual_durations else None,
        fill_rate_avg_pct=round(sum(fill_rates) / len(fill_rates), 2) if fill_rates else None,
        violations_blocking=plan.violations_blocking,
        violations_warning=plan.violations_warning,
        violations_total=plan.violations_blocking + plan.violations_warning,
        prep_time_s=prep_time_s,
        prep_time_source=prep_source,
    )


def _pct(delta: float, base: float) -> float | None:
    if base == 0:
        return None
    return round(delta / base * 100, 2)


def compare(a: PlanMetrics, b: PlanMetrics) -> list[MetricDelta]:
    """Écarts B − A, indicateur par indicateur, dans l'ordre de `INDICATORS`."""
    rows: list[MetricDelta] = []
    for indicator in INDICATORS:
        value_a = getattr(a, indicator.key)
        value_b = getattr(b, indicator.key)
        delta = delta_pct = better = None
        if value_a is not None and value_b is not None:
            delta = round(value_b - value_a, 2)
            # 0 → 0 : aucun écart (0 %) ; 0 → autre chose : pourcentage indéfini (None).
            delta_pct = 0.0 if value_a == 0 and value_b == 0 else _pct(value_b - value_a, value_a)
            if indicator.lower_is_better is not None:
                if delta == 0:
                    better = "equal"
                else:
                    better = "b" if (delta < 0) == indicator.lower_is_better else "a"
        rows.append(
            MetricDelta(
                key=indicator.key,
                label=indicator.label,
                unit=indicator.unit,
                a=value_a,
                b=value_b,
                delta=delta,
                delta_pct=delta_pct,
                better=better,
            )
        )
    return rows


def _fr(value: float) -> str:
    return f"{value:.1f}".replace(".", ",")


def verdict(a: PlanMetrics, b: PlanMetrics, threshold_pct: float) -> Verdict:
    """Verdict par rapport au seuil de gain kilométrique (km estimés des deux plans, même matrice)."""
    gain_m = a.distance_estimated_m - b.distance_estimated_m
    gain_pct = _pct(gain_m, a.distance_estimated_m)
    success = None if gain_pct is None else gain_pct >= threshold_pct

    gain_vs_actual = None
    if a.distance_actual_m is not None and a.distance_actual_trips == a.trips_count:
        gain_vs_actual = _pct(a.distance_actual_m - b.distance_estimated_m, a.distance_actual_m)

    if success is None:
        message = "Verdict impossible : le plan A n'a aucun kilomètre estimé."
    elif success:
        message = (
            f"Objectif atteint : le plan B parcourt {_fr(gain_pct)} % de kilomètres en moins que le "
            f"plan A (seuil : {_fr(threshold_pct)} %)."
        )
    elif gain_pct >= 0:
        message = (
            f"Objectif non atteint : le gain kilométrique du plan B est de {_fr(gain_pct)} %, "
            f"sous le seuil de {_fr(threshold_pct)} %."
        )
    else:
        message = (
            f"Objectif non atteint : le plan B parcourt {_fr(-gain_pct)} % de kilomètres en plus "
            f"que le plan A (seuil de gain : {_fr(threshold_pct)} %)."
        )

    return Verdict(
        threshold_pct=threshold_pct,
        distance_a_m=a.distance_estimated_m,
        distance_b_m=b.distance_estimated_m,
        gain_m=gain_m,
        gain_pct=gain_pct,
        success=success,
        gain_vs_actual_pct=gain_vs_actual,
        no_blocking_violation=b.violations_blocking == 0,
        orders_served_ok=b.orders_served >= a.orders_served,
        message=message,
    )
