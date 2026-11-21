"""Modèle de domaine du moteur de tournées — CONTRAT PARTAGÉ entre les modules.

Structures pures (aucune dépendance à la base ni à FastAPI) utilisées par :
  - le moteur (`app.planning.engine`) : PlanningProblem + Matrix → PlanningResult ;
  - les règles (`app.planning.violations.rules`) : contrôle d'un plan, calculé ou édité à la main ;
  - le service de plans (`app.planning.service`) : conversion base ↔ domaine ;
  - les jeux de données fictifs (`data/fixtures/*`), sérialisés en JSON à partir de ces structures.

Conventions :
  - identifiants : `str` (UUID sous forme de texte, ou code lisible dans les jeux de test) ;
  - temps : secondes entières depuis minuit local (Africa/Douala) du jour J — voir `app.core.time` ;
  - volumes : litres (`float`), distances : mètres (`int`), durées : secondes (`int`).

Ne pas modifier une signature existante sans mettre à jour docs/CONTRATS.md.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any

from app.core.enums import OrderPriority, Severity, TruckSize, TruckStatus, UnservedReason

Window = tuple[int, int]  # (début, fin) en secondes depuis minuit local

DAY_S = 24 * 3600


# --------------------------------------------------------------------------- paramètres


@dataclass(frozen=True, slots=True)
class Params:
    """Paramètres du calcul, lus depuis la table `settings` (jamais en dur ailleurs).

    Les valeurs par défaut ci-dessous sont celles de `app.core.settings_store.DEFAULTS`.
    """

    default_avg_speed_kmh: float = 40.0
    max_service_hours: float = 11.0  # RM-11
    default_depot_wait_min: int = 90  # attente avant chargement (Q2)
    depot_loading_time_min: int = 45  # durée du chargement lui-même (§7.3)
    default_unload_time_min: int = 45
    default_max_loadings_per_truck_day: int = 2  # RM-14 (Q2)
    compartment_safety_margin_pct: float = 2.0  # RM-05
    loading_tolerance_pct: float = 2.0  # RM-13
    window_tolerance_min: int = 30  # RM-10
    partial_delivery_min_pct: float = 50.0  # RM-16
    day_start_time: str = "06:00"
    timezone: str = "Africa/Douala"
    # Fonction objectif (§7.3), en « kilomètres équivalents »
    objective_distance_weight: float = 1.0
    objective_vehicle_fixed_cost_km: float = 40.0
    objective_unserved_penalty_normal_km: float = 500.0
    objective_unserved_penalty_urgent_km: float = 5000.0
    # Solveur
    solver_time_limit_s: int = 45
    solver_no_improvement_s: int = 10
    # Arrêt anticipé indépendant de l'horloge (reproductibilité) : nombre de solutions consécutives
    # sans amélioration ; 0 = critère désactivé.
    solver_no_improvement_solutions: int = 1000
    solver_seed: int = 42
    # Repli sans OSRM (§7.2)
    haversine_factor: float = 1.3

    @property
    def max_service_s(self) -> int:
        return int(self.max_service_hours * 3600)

    @property
    def day_start_s(self) -> int:
        hours, minutes = self.day_start_time.split(":")[:2]
        return int(hours) * 3600 + int(minutes) * 60


# --------------------------------------------------------------------------- entrées


@dataclass(frozen=True, slots=True)
class ProductD:
    id: str
    code: str
    label: str = ""


@dataclass(frozen=True, slots=True)
class CompartmentD:
    id: str
    position: int
    capacity_l: float
    allowed_product_ids: frozenset[str] | None = None  # None = tous produits (RM-07)

    def accepts(self, product_id: str) -> bool:
        return self.allowed_product_ids is None or product_id in self.allowed_product_ids


@dataclass(frozen=True, slots=True)
class TruckD:
    id: str
    plate: str
    size: TruckSize
    compartments: tuple[CompartmentD, ...]
    carrier_id: str | None = None
    avg_speed_kmh: float | None = None  # None → Params.default_avg_speed_kmh
    status: TruckStatus = TruckStatus.AVAILABLE
    available_today: bool = True  # False si marqué indisponible pour J (F2.2)

    @property
    def affectable(self) -> bool:
        """RM-04."""
        return self.status == TruckStatus.AVAILABLE and self.available_today

    @property
    def total_capacity_l(self) -> float:
        return sum(c.capacity_l for c in self.compartments)


@dataclass(frozen=True, slots=True)
class DriverD:
    id: str
    full_name: str
    carrier_id: str | None = None
    license_expiry: date | None = None
    hazmat_cert: bool = True
    hazmat_expiry: date | None = None
    status: str = "available"
    available_today: bool = True  # False si marqué indisponible pour J (F2.3)
    default_truck_id: str | None = None


@dataclass(frozen=True, slots=True)
class DepotD:
    id: str
    code: str
    lat: float
    lon: float
    windows: tuple[Window, ...] = ((0, DAY_S),)  # horaires d'ouverture du jour J
    avg_wait_min: int | None = None  # None → Params.default_depot_wait_min
    max_loadings_per_truck_day: int | None = None  # None → Params.default_max_loadings_per_truck_day
    name: str = ""


@dataclass(frozen=True, slots=True)
class StationD:
    id: str
    code: str
    lat: float
    lon: float
    windows: tuple[Window, ...] = ((0, DAY_S),)  # horaires de réception du jour J
    max_truck_size: TruckSize = TruckSize.LARGE  # RM-09
    unload_time_min: int | None = None  # None → Params.default_unload_time_min
    name: str = ""


@dataclass(frozen=True, slots=True)
class OrderD:
    id: str
    station_id: str
    product_id: str
    requested_l: float
    priority: OrderPriority = OrderPriority.NORMAL
    window: Window | None = None  # fenêtre de livraison souhaitée (F3.1)


@dataclass(slots=True)
class Matrix:
    """Matrice distances/durées entre nœuds (dépôts + stations), indexée par identifiant."""

    node_ids: tuple[str, ...]
    distance_m: list[list[int]]
    duration_s: list[list[int]]
    approximate: bool = False  # True si repli haversine (§7.2)
    _index: dict[str, int] = field(default_factory=dict, repr=False)

    def __post_init__(self) -> None:
        self._index = {node_id: i for i, node_id in enumerate(self.node_ids)}

    def distance(self, origin_id: str, dest_id: str) -> int:
        return self.distance_m[self._index[origin_id]][self._index[dest_id]]

    def duration(self, origin_id: str, dest_id: str) -> int:
        return self.duration_s[self._index[origin_id]][self._index[dest_id]]


# --------------------------------------------------------------------------- sorties (plan)


@dataclass(slots=True)
class DeliveryD:
    order_id: str
    product_id: str
    planned_l: float


@dataclass(slots=True)
class StopD:
    seq: int  # 1, 2, 3… dans la tournée
    station_id: str
    arrival_s: int = 0
    departure_s: int = 0
    distance_from_prev_m: int = 0
    deliveries: list[DeliveryD] = field(default_factory=list)
    status: str = "pending"  # pending | delivered | skipped (RM-19)
    ref: str | None = None  # identifiant base (stops.id) si le plan est persisté


@dataclass(slots=True)
class CompartmentLoadD:
    compartment_id: str
    product_id: str
    planned_l: float


@dataclass(slots=True)
class TripD:
    """Une tournée : un camion, un chauffeur, un dépôt, une séquence d'arrêts (RM-01).

    Chronologie : `start_s` (arrivée au dépôt) → attente + chargement → `depart_s` (départ du dépôt)
    → arrêts → `return_s` (retour au dépôt). Durée de service (RM-11) = return_s − depart_s.
    """

    seq: int  # numéro de la tournée dans le plan
    truck_id: str
    depot_id: str
    driver_id: str | None = None
    start_s: int = 0
    depart_s: int = 0
    return_s: int = 0
    distance_m: int = 0
    duration_s: int = 0
    stops: list[StopD] = field(default_factory=list)
    loads: list[CompartmentLoadD] = field(default_factory=list)
    locked: bool = False  # RM-17
    ref: str | None = None  # identifiant base (trips.id) si le plan est persisté

    def volumes_by_product(self) -> dict[str, float]:
        totals: dict[str, float] = {}
        for stop in self.stops:
            for delivery in stop.deliveries:
                totals[delivery.product_id] = totals.get(delivery.product_id, 0.0) + delivery.planned_l
        return totals


@dataclass(slots=True)
class UnservedD:
    order_id: str
    reason_code: UnservedReason
    reason_text: str = ""


@dataclass(slots=True)
class ViolationD:
    rule_code: str  # "RM-05"
    severity: Severity
    message: str  # en français, lisible par le dispatcher
    trip_seq: int | None = None
    stop_seq: int | None = None
    order_id: str | None = None


@dataclass(slots=True)
class PlanningProblem:
    """Tout ce dont le moteur et les règles ont besoin pour le jour J."""

    day: date
    products: list[ProductD]
    depots: list[DepotD]
    stations: list[StationD]
    trucks: list[TruckD]  # tous les camions connus ; filtrer avec `truck.affectable` (RM-04)
    drivers: list[DriverD]  # tous les chauffeurs connus ; filtrer avec la règle RM-03
    orders: list[OrderD]  # commandes `confirmed` à planifier
    # Stock disponible par (depot_id, product_id). Clé absente = stock non renseigné (RM-08 avertissement).
    depot_stocks: dict[tuple[str, str], float] = field(default_factory=dict)
    # Affectation du jour camion → chauffeur (F2.4) ; à défaut, `DriverD.default_truck_id`.
    driver_by_truck: dict[str, str] = field(default_factory=dict)
    params: Params = field(default_factory=Params)
    # Tournées verrouillées à conserver telles quelles lors d'un recalcul (F5.3, RM-17).
    locked_trips: list[TripD] = field(default_factory=list)

    def product(self, product_id: str) -> ProductD:
        return next(p for p in self.products if p.id == product_id)

    def depot(self, depot_id: str) -> DepotD:
        return next(d for d in self.depots if d.id == depot_id)

    def station(self, station_id: str) -> StationD:
        return next(s for s in self.stations if s.id == station_id)

    def truck(self, truck_id: str) -> TruckD:
        return next(t for t in self.trucks if t.id == truck_id)

    def driver(self, driver_id: str) -> DriverD:
        return next(d for d in self.drivers if d.id == driver_id)

    def order(self, order_id: str) -> OrderD:
        return next(o for o in self.orders if o.id == order_id)

    def depot_wait_s(self, depot: DepotD) -> int:
        wait = depot.avg_wait_min if depot.avg_wait_min is not None else self.params.default_depot_wait_min
        return wait * 60

    def loading_s(self) -> int:
        return self.params.depot_loading_time_min * 60

    def unload_s(self, station: StationD) -> int:
        minutes = (
            station.unload_time_min
            if station.unload_time_min is not None
            else self.params.default_unload_time_min
        )
        return minutes * 60

    def max_loadings(self, depot: DepotD) -> int:
        if depot.max_loadings_per_truck_day is not None:
            return depot.max_loadings_per_truck_day
        return self.params.default_max_loadings_per_truck_day


@dataclass(slots=True)
class PlanningResult:
    trips: list[TripD]
    unserved: list[UnservedD] = field(default_factory=list)
    violations: list[ViolationD] = field(default_factory=list)
    approximate: bool = False
    engine_version: str = ""
    computed_in_ms: int = 0
    # Journal de résolution : temps, itérations, statut du solveur, valeur de l'objectif…
    solver_log: dict[str, Any] = field(default_factory=dict)
    # Métriques agrégées : km totaux, nb camions, nb tournées, taux de remplissage moyen…
    metrics: dict[str, Any] = field(default_factory=dict)
