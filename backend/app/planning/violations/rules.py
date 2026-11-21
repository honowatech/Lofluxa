"""Règles métier RM-xx — SOURCE UNIQUE DE VÉRITÉ (spec §6, §8.2).

Une fonction publique pure par règle, sur les structures de `app.planning.domain`, renvoyant
`list[ViolationD]` (liste vide = conforme). Appelées par le moteur et par l'édition manuelle.
Chaque règle a un test unitaire qui la cite : `tests/unit/rules/test_rm_xx_*.py`.

Règles (signature commune `(problem, trips)` sauf mention) :

    rm_01_trip_resources              RM-01  un camion, un chauffeur, un dépôt par tournée       bloquant
    rm_02_no_overlap                  RM-02  pas de chevauchement camion / chauffeur             bloquant
    rm_03_driver_eligible             RM-03  permis / habilitation valides, chauffeur disponible bloquant
    rm_04_truck_eligible              RM-04  camion affectable                                   bloquant
    rm_05_compartment_capacity        RM-05  capacité utile des compartiments                    bloquant
    rm_06_compartment_single_product  RM-06  un seul produit par compartiment                    bloquant
    rm_07_compartment_allowed_product RM-07  produit autorisé dans le compartiment               bloquant
    rm_08_depot_stock                 RM-08  stock dépôt (non renseigné : avertissement)         bloq./avert.
    rm_09_truck_size                  RM-09  gabarit accepté par la station                      bloquant
    rm_10_time_windows                RM-10  horaires station, fenêtre commande, horaires dépôt  avert./bloq.
    rm_11_service_duration            RM-11  durée de service par tournée et cumul chauffeur     bloquant
    rm_14_max_loadings                RM-14  chargements par camion et par jour au dépôt         bloquant
    rm_15_urgent_orders(problem, trips, unserved=None)
                                      RM-15  commande urgente non servie                         bloquant
    rm_16_delivery_volume             RM-16  volume livré ≤ demandé, partiel ≥ seuil             avertissement
    rm_17_locked_trips_unchanged(before, after, problem=None)
                                      RM-17  tournée verrouillée inchangée après recalcul        bloquant

Agrégation : `check_plan(problem, trips, unserved=None, matrix=None)` et `has_blocking(violations)`.

Prédicats de filtrage (définis dans `predicates.py`, réexportés ici) — à utiliser par le moteur pour
ne construire que des solutions admissibles et par l'édition manuelle pour proposer les bons choix :

    is_truck_assignable(truck) / assignable_trucks(problem)                   RM-04
    is_driver_assignable(driver, day) / assignable_drivers(problem)           RM-03
    truck_can_serve_station(truck, station) / trucks_for_station(problem, station)   RM-09
    compartment_usable_capacity_l(compartment, params)                        RM-05
    compartment_accepts_product(compartment, product_id, current_product_id=None)    RM-06/07
    compartment_accepts_volume(compartment, volume_l, params, already_loaded_l=0.0)  RM-05
    compartment_can_load(compartment, product_id, volume_l, params, *, current_product_id, already_loaded_l)
    truck_product_capacity_l(truck, product_id, params)                       RM-05/07
    intervals_overlap(a_start, a_end, b_start, b_end) / trips_overlap(a, b)   RM-02
    window_severity(lateness_s, params)                                       RM-10
    service_duration_exceeded(duration_s, params)                             RM-11
    min_partial_volume_l(order, params) / delivery_volume_allowed(order, volume_l, params)  RM-16
    is_urgent(order) / sort_unserved(problem, unserved)                       RM-15

Conventions :
  - `trips` est le plan complet du jour (tournées verrouillées comprises) et ses horaires sont à
    jour (`app.planning.timing.schedule_trip`) ;
  - une référence inconnue (camion, chauffeur, dépôt absent du problème) est signalée par RM-01 ;
    les autres règles ignorent alors la tournée concernée plutôt que d'échouer ;
  - aucun seuil en dur : tout vient de `problem.params` (ou du dépôt / de la station) ;
  - hors de ce module : RM-12/RM-13 (`app.loading`), RM-18 (service de plans), RM-19 (`app.events`),
    RM-20 (`app.core.time`).
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

from app.core.enums import Severity, TruckSize
from app.planning.domain import (
    DepotD,
    DriverD,
    Matrix,
    OrderD,
    PlanningProblem,
    ProductD,
    StationD,
    StopD,
    TripD,
    TruckD,
    UnservedD,
    ViolationD,
)
from app.planning.timing import lateness_s, stop_windows
from app.planning.violations.eligibility import driver_unavailable_reason, truck_block_reason
from app.planning.violations.predicates import (
    VOLUME_EPSILON_L,
    assignable_drivers,
    assignable_trucks,
    compartment_accepts_product,
    compartment_accepts_volume,
    compartment_can_load,
    compartment_usable_capacity_l,
    delivery_volume_allowed,
    intervals_overlap,
    is_driver_assignable,
    is_truck_assignable,
    is_urgent,
    min_partial_volume_l,
    service_duration_exceeded,
    sort_unserved,
    trips_overlap,
    truck_can_serve_station,
    truck_product_capacity_l,
    trucks_for_station,
    window_severity,
)

__all__ = [
    "VOLUME_EPSILON_L",
    "assignable_drivers",
    "assignable_trucks",
    "check_plan",
    "compartment_accepts_product",
    "compartment_accepts_volume",
    "compartment_can_load",
    "compartment_usable_capacity_l",
    "delivery_volume_allowed",
    "has_blocking",
    "intervals_overlap",
    "is_driver_assignable",
    "is_truck_assignable",
    "is_urgent",
    "min_partial_volume_l",
    "rm_01_trip_resources",
    "rm_02_no_overlap",
    "rm_03_driver_eligible",
    "rm_04_truck_eligible",
    "rm_05_compartment_capacity",
    "rm_06_compartment_single_product",
    "rm_07_compartment_allowed_product",
    "rm_08_depot_stock",
    "rm_09_truck_size",
    "rm_10_time_windows",
    "rm_11_service_duration",
    "rm_14_max_loadings",
    "rm_15_urgent_orders",
    "rm_16_delivery_volume",
    "rm_17_locked_trips_unchanged",
    "service_duration_exceeded",
    "sort_unserved",
    "truck_can_serve_station",
    "truck_product_capacity_l",
    "trips_overlap",
    "trucks_for_station",
    "window_severity",
]

BLOCKING = Severity.BLOCKING
WARNING = Severity.WARNING

_SIZE_FR = {TruckSize.SMALL: "petit", TruckSize.MEDIUM: "moyen", TruckSize.LARGE: "grand"}


# --------------------------------------------------------------------------- outillage interne


@dataclass(frozen=True, slots=True)
class _Index:
    """Accès par identifiant aux entités du problème, tolérant aux références inconnues."""

    trucks: dict[str, TruckD]
    drivers: dict[str, DriverD]
    depots: dict[str, DepotD]
    stations: dict[str, StationD]
    orders: dict[str, OrderD]
    products: dict[str, ProductD]

    @classmethod
    def of(cls, problem: PlanningProblem) -> _Index:
        return cls(
            trucks={t.id: t for t in problem.trucks},
            drivers={d.id: d for d in problem.drivers},
            depots={d.id: d for d in problem.depots},
            stations={s.id: s for s in problem.stations},
            orders={o.id: o for o in problem.orders},
            products={p.id: p for p in problem.products},
        )

    def product_code(self, product_id: str) -> str:
        product = self.products.get(product_id)
        return product.code if product else product_id

    def station_code(self, station_id: str) -> str:
        station = self.stations.get(station_id)
        return station.code if station else station_id

    def trip_label(self, trip: TripD) -> str:
        truck = self.trucks.get(trip.truck_id)
        if truck is None:
            return f"Tournée {trip.seq}"
        return f"Tournée {trip.seq} (camion {truck.plate})"

    def order_label(self, order: OrderD) -> str:
        return (
            f"commande de {_litres(order.requested_l)} de {self.product_code(order.product_id)} "
            f"pour la station {self.station_code(order.station_id)}"
        )


def _litres(volume_l: float) -> str:
    """12 000 L (séparateur de milliers : espace)."""
    return f"{volume_l:,.0f}".replace(",", " ") + " L"


def _clock(seconds: int) -> str:
    """Secondes depuis minuit local → HH:MM."""
    return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}"


def _duration(seconds: int) -> str:
    """Durée → « 11 h 05 »."""
    return f"{seconds // 3600} h {seconds % 3600 // 60:02d}"


def _minutes(seconds: int) -> str:
    """Retard en minutes, arrondi à la minute supérieure."""
    return f"{-(-seconds // 60)} min"


def _seqs(trips: list[TripD]) -> str:
    return ", ".join(str(t.seq) for t in trips)


def _by_start(trips: list[TripD]) -> list[TripD]:
    return sorted(trips, key=lambda t: (t.start_s, t.seq))


# --------------------------------------------------------------------------- RM-01


def rm_01_trip_resources(problem: PlanningProblem, trips: list[TripD]) -> list[ViolationD]:
    """RM-01 : une tournée a exactement un camion, un chauffeur et un dépôt de chargement (bloquant)."""
    index = _Index.of(problem)
    violations: list[ViolationD] = []

    def add(trip: TripD, text: str) -> None:
        violations.append(ViolationD("RM-01", BLOCKING, f"{index.trip_label(trip)} : {text}", trip.seq))

    for trip in trips:
        if not trip.truck_id:
            add(trip, "aucun camion affecté.")
        elif trip.truck_id not in index.trucks:
            add(trip, "le camion affecté est inconnu du référentiel.")
        if not trip.driver_id:
            add(trip, "aucun chauffeur affecté.")
        elif trip.driver_id not in index.drivers:
            add(trip, "le chauffeur affecté est inconnu du référentiel.")
        if not trip.depot_id:
            add(trip, "aucun dépôt de chargement.")
        elif trip.depot_id not in index.depots:
            add(trip, "le dépôt de chargement est inconnu du référentiel.")
    return violations


# --------------------------------------------------------------------------- RM-02


def rm_02_no_overlap(problem: PlanningProblem, trips: list[TripD]) -> list[ViolationD]:
    """RM-02 : un camion ou un chauffeur n'est pas sur deux tournées qui se chevauchent (bloquant).

    Une violation par paire de tournées et par ressource, rattachée à la tournée la plus tardive.
    """
    index = _Index.of(problem)
    by_truck: dict[str, list[TripD]] = defaultdict(list)
    by_driver: dict[str, list[TripD]] = defaultdict(list)
    for trip in trips:
        if trip.truck_id:
            by_truck[trip.truck_id].append(trip)
        if trip.driver_id:
            by_driver[trip.driver_id].append(trip)

    violations: list[ViolationD] = []

    def scan(groups: dict[str, list[TripD]], who: dict[str, str]) -> None:
        for resource_id, group in groups.items():
            ordered = _by_start(group)
            for i, first in enumerate(ordered):
                for second in ordered[i + 1 :]:
                    if not trips_overlap(first, second):
                        continue
                    violations.append(
                        ViolationD(
                            "RM-02",
                            BLOCKING,
                            f"{who.get(resource_id, resource_id)} est sur deux tournées qui se "
                            f"chevauchent : tournée {first.seq} ({_clock(first.start_s)}–"
                            f"{_clock(first.return_s)}) et tournée {second.seq} "
                            f"({_clock(second.start_s)}–{_clock(second.return_s)}).",
                            second.seq,
                        )
                    )

    scan(by_truck, {t.id: f"Le camion {t.plate}" for t in index.trucks.values()})
    scan(by_driver, {d.id: f"Le chauffeur {d.full_name}" for d in index.drivers.values()})
    return violations


# --------------------------------------------------------------------------- RM-03 / RM-04


def _is_done(trip: TripD) -> bool:
    """Tournée dont plus aucun arrêt n'est en attente (tous livrés ou sautés, ou tournée vidée par
    une panne, RM-19). L'affectabilité (RM-03, RM-04) vaut pour ce qui reste à faire : un camion
    tombé en panne ou un chauffeur devenu indisponible en cours de journée ne rend pas fautive la
    tournée qu'il a déjà réalisée (ajout du lot L10, F6.1 / F6.2)."""
    return all(stop.status != "pending" for stop in trip.stops)


def rm_03_driver_eligible(problem: PlanningProblem, trips: list[TripD]) -> list[ViolationD]:
    """RM-03 : un chauffeur dont le permis ou l'habilitation matières dangereuses est expiré à la
    date J n'est pas affectable (bloquant). Un chauffeur indisponible (statut du référentiel ou
    marqué indisponible pour J, F2.3) est signalé de la même façon."""
    index = _Index.of(problem)
    violations = []
    for trip in trips:
        driver = index.drivers.get(trip.driver_id) if trip.driver_id else None
        if driver is None or _is_done(trip):
            continue
        reason = driver_unavailable_reason(driver, problem.day)
        if reason:
            violations.append(
                ViolationD(
                    "RM-03",
                    BLOCKING,
                    f"{index.trip_label(trip)} : le chauffeur {driver.full_name} n'est pas "
                    f"affectable. {reason}",
                    trip.seq,
                )
            )
    return violations


def rm_04_truck_eligible(problem: PlanningProblem, trips: list[TripD]) -> list[ViolationD]:
    """RM-04 : un camion en maintenance, en panne, réservé ou marqué indisponible pour J n'est pas
    affectable (bloquant)."""
    index = _Index.of(problem)
    violations = []
    for trip in trips:
        truck = index.trucks.get(trip.truck_id)
        if truck is None or _is_done(trip):
            continue
        reason = truck_block_reason(truck)
        if reason:
            violations.append(
                ViolationD(
                    "RM-04",
                    BLOCKING,
                    f"Tournée {trip.seq} : le camion {truck.plate} n'est pas affectable. {reason}",
                    trip.seq,
                )
            )
    return violations


# --------------------------------------------------------------------------- RM-05 / RM-06 / RM-07


def rm_05_compartment_capacity(problem: PlanningProblem, trips: list[TripD]) -> list[ViolationD]:
    """RM-05 : volume chargé dans un compartiment ≤ capacité × (1 − marge de sécurité) (bloquant).

    Contrôle le plan de chargement (`trip.loads`) et vérifie qu'il couvre bien tous les volumes à
    livrer : un volume qui n'a trouvé place dans aucun compartiment (ou affecté à un compartiment
    qui n'appartient pas au camion) est une violation de capacité.
    """
    index = _Index.of(problem)
    params = problem.params
    violations = []
    for trip in trips:
        truck = index.trucks.get(trip.truck_id)
        if truck is None:
            continue
        compartments = {c.id: c for c in truck.compartments}
        loaded: dict[str, float] = defaultdict(float)
        loaded_by_product: dict[str, float] = defaultdict(float)
        for load in trip.loads:
            loaded[load.compartment_id] += load.planned_l
            if load.compartment_id in compartments:
                loaded_by_product[load.product_id] += load.planned_l

        for compartment_id, volume in loaded.items():
            compartment = compartments.get(compartment_id)
            if compartment is None:
                violations.append(
                    ViolationD(
                        "RM-05",
                        BLOCKING,
                        f"{index.trip_label(trip)} : {_litres(volume)} affectés à un compartiment "
                        f"qui n'appartient pas à ce camion.",
                        trip.seq,
                    )
                )
            elif not compartment_accepts_volume(compartment, volume, params):
                usable = compartment_usable_capacity_l(compartment, params)
                violations.append(
                    ViolationD(
                        "RM-05",
                        BLOCKING,
                        f"{index.trip_label(trip)} : compartiment {compartment.position} chargé à "
                        f"{_litres(volume)} pour une capacité utile de {_litres(usable)} "
                        f"({_litres(compartment.capacity_l)} moins la marge de sécurité de "
                        f"{params.compartment_safety_margin_pct:g} %).",
                        trip.seq,
                    )
                )

        for product_id, to_deliver in trip.volumes_by_product().items():
            missing = to_deliver - loaded_by_product.get(product_id, 0.0)
            if missing > VOLUME_EPSILON_L:
                capacity = truck_product_capacity_l(truck, product_id, params)
                violations.append(
                    ViolationD(
                        "RM-05",
                        BLOCKING,
                        f"{index.trip_label(trip)} : {_litres(missing)} de "
                        f"{index.product_code(product_id)} ne tiennent dans aucun compartiment "
                        f"({_litres(to_deliver)} à livrer, capacité utile compatible du camion : "
                        f"{_litres(capacity)}).",
                        trip.seq,
                    )
                )
    return violations


def rm_06_compartment_single_product(problem: PlanningProblem, trips: list[TripD]) -> list[ViolationD]:
    """RM-06 : un compartiment ne contient qu'un seul produit par tournée (bloquant)."""
    index = _Index.of(problem)
    violations = []
    for trip in trips:
        truck = index.trucks.get(trip.truck_id)
        positions = {c.id: c.position for c in truck.compartments} if truck else {}
        products: dict[str, list[str]] = defaultdict(list)
        for load in trip.loads:
            if load.product_id not in products[load.compartment_id]:
                products[load.compartment_id].append(load.product_id)
        for compartment_id, product_ids in products.items():
            if len(product_ids) > 1:
                codes = " et ".join(index.product_code(p) for p in product_ids)
                violations.append(
                    ViolationD(
                        "RM-06",
                        BLOCKING,
                        f"{index.trip_label(trip)} : le compartiment "
                        f"{positions.get(compartment_id, compartment_id)} contient plusieurs "
                        f"produits ({codes}) ; un seul produit par compartiment.",
                        trip.seq,
                    )
                )
    return violations


def rm_07_compartment_allowed_product(problem: PlanningProblem, trips: list[TripD]) -> list[ViolationD]:
    """RM-07 : un compartiment ne reçoit qu'un produit de sa liste autorisée, si définie (bloquant)."""
    index = _Index.of(problem)
    violations = []
    for trip in trips:
        truck = index.trucks.get(trip.truck_id)
        if truck is None:
            continue
        compartments = {c.id: c for c in truck.compartments}
        reported: set[tuple[str, str]] = set()
        for load in trip.loads:
            compartment = compartments.get(load.compartment_id)
            key = (load.compartment_id, load.product_id)
            if compartment is None or compartment.accepts(load.product_id) or key in reported:
                continue
            reported.add(key)
            allowed = ", ".join(sorted(index.product_code(p) for p in compartment.allowed_product_ids or ()))
            violations.append(
                ViolationD(
                    "RM-07",
                    BLOCKING,
                    f"{index.trip_label(trip)} : le compartiment {compartment.position} n'est pas "
                    f"autorisé à recevoir {index.product_code(load.product_id)} "
                    f"(produits autorisés : {allowed or 'aucun'}).",
                    trip.seq,
                )
            )
    return violations


# --------------------------------------------------------------------------- RM-08


def rm_08_depot_stock(problem: PlanningProblem, trips: list[TripD]) -> list[ViolationD]:
    """RM-08 : volume total planifié d'un produit au départ d'un dépôt ≤ stock saisi pour J
    (bloquant). Aucun stock saisi : avertissement « stock non renseigné ».

    Une violation par (dépôt, produit), au niveau du plan (pas de `trip_seq`).
    """
    index = _Index.of(problem)
    totals: dict[tuple[str, str], float] = defaultdict(float)
    concerned: dict[tuple[str, str], list[TripD]] = defaultdict(list)
    for trip in trips:
        for product_id, volume in trip.volumes_by_product().items():
            if volume <= 0:
                continue
            totals[(trip.depot_id, product_id)] += volume
            concerned[(trip.depot_id, product_id)].append(trip)

    violations = []
    for (depot_id, product_id), planned in totals.items():
        depot = index.depots.get(depot_id)
        if depot is None:
            continue
        product = index.product_code(product_id)
        tours = f"tournées concernées : {_seqs(concerned[(depot_id, product_id)])}"
        stock = problem.depot_stocks.get((depot_id, product_id))
        if stock is None:
            violations.append(
                ViolationD(
                    "RM-08",
                    WARNING,
                    f"Dépôt {depot.code} : stock non renseigné pour {product} "
                    f"({_litres(planned)} planifiés ; {tours}).",
                )
            )
        elif planned > stock + VOLUME_EPSILON_L:
            violations.append(
                ViolationD(
                    "RM-08",
                    BLOCKING,
                    f"Dépôt {depot.code} : {_litres(planned)} de {product} planifiés pour un stock "
                    f"disponible de {_litres(stock)} (dépassement de {_litres(planned - stock)} ; "
                    f"{tours}).",
                )
            )
    return violations


# --------------------------------------------------------------------------- RM-09


def rm_09_truck_size(problem: PlanningProblem, trips: list[TripD]) -> list[ViolationD]:
    """RM-09 : une station n'est livrée que par un camion de gabarit ≤ son gabarit maximal (bloquant)."""
    index = _Index.of(problem)
    violations = []
    for trip in trips:
        truck = index.trucks.get(trip.truck_id)
        if truck is None:
            continue
        for stop in trip.stops:
            station = index.stations.get(stop.station_id)
            if station is None or truck_can_serve_station(truck, station):
                continue
            violations.append(
                ViolationD(
                    "RM-09",
                    BLOCKING,
                    f"Tournée {trip.seq}, arrêt {stop.seq} : le camion {truck.plate} (gabarit "
                    f"{_SIZE_FR[truck.size]}) est trop grand pour la station {station.code} "
                    f"(gabarit maximal accepté : {_SIZE_FR[station.max_truck_size]}).",
                    trip.seq,
                    stop.seq,
                )
            )
    return violations


# --------------------------------------------------------------------------- RM-10


def _tolerance_note(severity: Severity, problem: PlanningProblem) -> str:
    tolerance = problem.params.window_tolerance_min
    if severity == WARNING:
        return f"retard toléré jusqu'à {tolerance} min"
    return f"au-delà de la tolérance de {tolerance} min"


def _stop_window_violation(
    problem: PlanningProblem, index: _Index, trip: TripD, stop: StopD, station: StationD
) -> ViolationD | None:
    windows = stop_windows(problem, stop)
    late = lateness_s(stop.arrival_s, windows)
    severity = window_severity(late, problem.params)
    if severity is None:
        return None
    where = f"{index.trip_label(trip)}, arrêt {stop.seq}"
    windowed = [
        order
        for delivery in stop.deliveries
        if (order := index.orders.get(delivery.order_id)) is not None and order.window is not None
    ]
    if not station.windows:
        return ViolationD(
            "RM-10",
            BLOCKING,
            f"{where} : la station {station.code} n'a aucun horaire de réception ce jour "
            f"(arrivée estimée à {_clock(stop.arrival_s)}).",
            trip.seq,
            stop.seq,
        )
    if not windows:
        return ViolationD(
            "RM-10",
            BLOCKING,
            f"{where} : aucun créneau commun entre les horaires de réception de la station "
            f"{station.code} et la fenêtre de livraison demandée.",
            trip.seq,
            stop.seq,
            windowed[0].id if windowed else None,
        )
    limit = _clock(stop.arrival_s - late)
    note = _tolerance_note(severity, problem)
    if lateness_s(stop.arrival_s, station.windows) >= late:
        return ViolationD(
            "RM-10",
            severity,
            f"{where} : arrivée estimée à {_clock(stop.arrival_s)} à la station {station.code}, "
            f"{_minutes(late)} après la fin de réception ({limit}) — {note}.",
            trip.seq,
            stop.seq,
        )
    culprit = next((o for o in windowed if lateness_s(stop.arrival_s, (o.window,)) > 0), None)
    return ViolationD(
        "RM-10",
        severity,
        f"{where} : arrivée estimée à {_clock(stop.arrival_s)} à la station {station.code}, "
        f"{_minutes(late)} après la fin de la fenêtre de livraison demandée ({limit}) — {note}.",
        trip.seq,
        stop.seq,
        culprit.id if culprit else None,
    )


def rm_10_time_windows(problem: PlanningProblem, trips: list[TripD]) -> list[ViolationD]:
    """RM-10 : arrivée estimée dans les horaires de réception de la station et dans la fenêtre de la
    commande si elle existe. Retard ≤ `window_tolerance_min` : avertissement ; au-delà : bloquant.

    Contrôle aussi, avec la même gradation, l'arrivée au dépôt (`start_s`) par rapport à ses
    horaires d'ouverture. Une arrivée en avance n'est pas un retard : le camion attend l'ouverture
    (`arrival_s` est déjà l'heure de début de service).
    """
    index = _Index.of(problem)
    violations = []
    for trip in trips:
        depot = index.depots.get(trip.depot_id)
        if depot is not None:
            late = lateness_s(trip.start_s, depot.windows)
            severity = window_severity(late, problem.params)
            if severity is not None and not depot.windows:
                violations.append(
                    ViolationD(
                        "RM-10",
                        BLOCKING,
                        f"{index.trip_label(trip)} : le dépôt {depot.code} est fermé ce jour.",
                        trip.seq,
                    )
                )
            elif severity is not None:
                violations.append(
                    ViolationD(
                        "RM-10",
                        severity,
                        f"{index.trip_label(trip)} : arrivée au dépôt {depot.code} à "
                        f"{_clock(trip.start_s)}, {_minutes(late)} après sa fermeture "
                        f"({_clock(trip.start_s - late)}) — {_tolerance_note(severity, problem)}.",
                        trip.seq,
                    )
                )
        for stop in trip.stops:
            station = index.stations.get(stop.station_id)
            if station is None:
                continue
            violation = _stop_window_violation(problem, index, trip, stop, station)
            if violation is not None:
                violations.append(violation)
    return violations


# --------------------------------------------------------------------------- RM-11


def rm_11_service_duration(problem: PlanningProblem, trips: list[TripD]) -> list[ViolationD]:
    """RM-11 : durée de service d'une tournée (départ dépôt → retour dépôt) et cumul journalier par
    chauffeur ≤ durée maximale de service (bloquant).

    Le cumul n'est signalé que pour un chauffeur ayant plusieurs tournées (sinon il ferait doublon
    avec la violation de la tournée) ; il est rattaché à sa dernière tournée.
    """
    index = _Index.of(problem)
    params = problem.params
    maximum = _duration(params.max_service_s)
    violations = []
    by_driver: dict[str, list[TripD]] = defaultdict(list)
    for trip in trips:
        duration = trip.return_s - trip.depart_s
        if service_duration_exceeded(duration, params):
            violations.append(
                ViolationD(
                    "RM-11",
                    BLOCKING,
                    f"{index.trip_label(trip)} : durée de service de {_duration(duration)} (départ "
                    f"du dépôt {_clock(trip.depart_s)}, retour {_clock(trip.return_s)}), "
                    f"maximum {maximum}.",
                    trip.seq,
                )
            )
        if trip.driver_id:
            by_driver[trip.driver_id].append(trip)

    for driver_id, group in by_driver.items():
        if len(group) < 2:
            continue
        total = sum(t.return_s - t.depart_s for t in group)
        if service_duration_exceeded(total, params):
            ordered = _by_start(group)
            driver = index.drivers.get(driver_id)
            name = driver.full_name if driver else driver_id
            violations.append(
                ViolationD(
                    "RM-11",
                    BLOCKING,
                    f"Chauffeur {name} : {_duration(total)} de service cumulées sur la journée "
                    f"(tournées {_seqs(ordered)}), maximum {maximum}.",
                    ordered[-1].seq,
                )
            )
    return violations


# --------------------------------------------------------------------------- RM-14


def rm_14_max_loadings(problem: PlanningProblem, trips: list[TripD]) -> list[ViolationD]:
    """RM-14 : un camion ne dépasse pas le nombre maximal de chargements par jour du dépôt (bloquant).

    Les chargements sont comptés par (camion, dépôt). La violation est rattachée au premier
    chargement en trop.
    """
    index = _Index.of(problem)
    groups: dict[tuple[str, str], list[TripD]] = defaultdict(list)
    for trip in trips:
        if trip.truck_id and trip.depot_id in index.depots:
            groups[(trip.truck_id, trip.depot_id)].append(trip)

    violations = []
    for (truck_id, depot_id), group in groups.items():
        depot = index.depots[depot_id]
        limit = problem.max_loadings(depot)
        if len(group) <= limit:
            continue
        ordered = _by_start(group)
        truck = index.trucks.get(truck_id)
        violations.append(
            ViolationD(
                "RM-14",
                BLOCKING,
                f"Camion {truck.plate if truck else truck_id} : {len(group)} chargements prévus au "
                f"dépôt {depot.code} dans la journée (tournées {_seqs(ordered)}), maximum {limit}.",
                ordered[limit].seq,
            )
        )
    return violations


# --------------------------------------------------------------------------- RM-15 / RM-16


def _planned_by_order(trips: list[TripD]) -> dict[str, float]:
    totals: dict[str, float] = defaultdict(float)
    for trip in trips:
        for stop in trip.stops:
            for delivery in stop.deliveries:
                totals[delivery.order_id] += delivery.planned_l
    return totals


def rm_15_urgent_orders(
    problem: PlanningProblem, trips: list[TripD], unserved: list[UnservedD] | None = None
) -> list[ViolationD]:
    """RM-15 : une commande urgente doit être servie (bloquant tant qu'elle n'est pas reportée).

    Est en violation toute commande urgente du problème qui figure dans `unserved`, ou qui n'est
    livrée par aucune tournée (même si elle a été oubliée dans `unserved` : une commande ne disparaît
    jamais silencieusement, F4.4). Une commande reportée (`postponed`) ne fait plus partie de
    `problem.orders` : elle ne bloque donc plus.
    """
    index = _Index.of(problem)
    planned = _planned_by_order(trips)
    reasons = {u.order_id: u.reason_text for u in unserved or []}
    violations = []
    for order in problem.orders:
        if not is_urgent(order):
            continue
        if order.id not in reasons and planned.get(order.id, 0.0) > 0:
            continue
        reason = reasons.get(order.id, "").rstrip(".")
        detail = f" ({reason})" if reason else ""
        violations.append(
            ViolationD(
                "RM-15",
                BLOCKING,
                f"Commande urgente non servie : {index.order_label(order)}{detail}. "
                f"La servir ou la reporter "
                f"explicitement avant de publier.",
                order_id=order.id,
            )
        )
    return violations


def rm_16_delivery_volume(problem: PlanningProblem, trips: list[TripD]) -> list[ViolationD]:
    """RM-16 : volume livré ≤ volume demandé ; livraison partielle autorisée si ≥
    `partial_delivery_min_pct` du demandé (avertissement dans les deux cas de violation).

    Le volume d'une commande est cumulé sur tout le plan. Une livraison partielle au-dessus du seuil
    est conforme ; une commande non livrée du tout relève des non servies, pas de cette règle.
    """
    index = _Index.of(problem)
    params = problem.params
    first_seen: dict[str, tuple[int, int]] = {}
    for trip in trips:
        for stop in trip.stops:
            for delivery in stop.deliveries:
                first_seen.setdefault(delivery.order_id, (trip.seq, stop.seq))

    violations = []
    for order_id, planned in _planned_by_order(trips).items():
        order = index.orders.get(order_id)
        if order is None or planned <= 0 or delivery_volume_allowed(order, planned, params):
            continue
        trip_seq, stop_seq = first_seen[order_id]
        label = index.order_label(order)
        label = label[0].upper() + label[1:]
        if planned > order.requested_l:
            text = (
                f"{label} : {_litres(planned)} planifiés, soit {_litres(planned - order.requested_l)} "
                f"de plus que le volume demandé."
            )
        else:
            text = (
                f"{label} : livraison partielle de {_litres(planned)} "
                f"({planned / order.requested_l * 100:.0f} % du demandé), sous le minimum de "
                f"{params.partial_delivery_min_pct:g} % ({_litres(min_partial_volume_l(order, params))})."
            )
        violations.append(ViolationD("RM-16", WARNING, text, trip_seq, stop_seq, order_id))
    return violations


# --------------------------------------------------------------------------- RM-17


def _trip_signature(trip: TripD) -> tuple:
    """Contenu d'une tournée qu'un recalcul ne doit pas toucher : ressources, séquence, volumes,
    plan de chargement. Les heures et le numéro de tournée n'en font pas partie."""
    return (
        trip.truck_id,
        trip.driver_id,
        trip.depot_id,
        tuple(
            (
                s.station_id,
                tuple(sorted((d.order_id, d.product_id, round(d.planned_l, 3)) for d in s.deliveries)),
            )
            for s in trip.stops
        ),
        tuple(sorted((c.compartment_id, c.product_id, round(c.planned_l, 3)) for c in trip.loads)),
    )


def _locked_violations(
    reference: list[TripD], after: list[TripD], problem: PlanningProblem | None
) -> list[ViolationD]:
    index = _Index.of(problem) if problem is not None else None
    remaining = list(after)
    changed: list[TripD] = []
    for trip in reference:
        signature = _trip_signature(trip)
        match = next((t for t in remaining if _trip_signature(t) == signature), None)
        if match is None:
            changed.append(trip)
        else:
            remaining.remove(match)

    violations = []
    for trip in changed:
        label = index.trip_label(trip) if index else f"Tournée {trip.seq}"
        twin = next((t for t in remaining if trip.ref is not None and t.ref == trip.ref), None) or next(
            (t for t in remaining if t.seq == trip.seq), None
        )
        if twin is None:
            text = f"{label} verrouillée : elle a disparu du plan après le recalcul."
        else:
            remaining.remove(twin)
            before_sig, after_sig = _trip_signature(trip), _trip_signature(twin)
            names = ("le camion", "le chauffeur", "le dépôt", "les arrêts ou les volumes livrés",
                     "le plan de chargement")  # fmt: skip
            diffs = [name for name, a, b in zip(names, before_sig, after_sig, strict=True) if a != b]
            text = f"{label} verrouillée : le recalcul a modifié {', '.join(diffs)}."
        violations.append(ViolationD("RM-17", BLOCKING, text, trip.seq))
    return violations


def rm_17_locked_trips_unchanged(
    before: list[TripD], after: list[TripD], problem: PlanningProblem | None = None
) -> list[ViolationD]:
    """RM-17 : une tournée verrouillée n'est pas modifiée par un recalcul (bloquant).

    Compare deux états d'un plan : chaque tournée `locked` de `before` doit se retrouver à
    l'identique dans `after` — même camion, chauffeur, dépôt, mêmes arrêts dans le même ordre, mêmes
    volumes, même plan de chargement. Le numéro de tournée et les heures peuvent changer.
    `problem` (facultatif) ne sert qu'à nommer le camion dans le message.
    """
    return _locked_violations([t for t in before if t.locked], after, problem)


# --------------------------------------------------------------------------- agrégation


def check_plan(
    problem: PlanningProblem,
    trips: list[TripD],
    unserved: list[UnservedD] | None = None,
    matrix: Matrix | None = None,
) -> list[ViolationD]:
    """Contrôle complet d'un plan : renvoie toutes les violations (bloquantes et avertissements),
    dans l'ordre des règles.

    Les horaires des tournées (`start_s`, `depart_s`, `arrival_s`…) sont supposés à jour
    (voir `app.planning.timing.schedule_trip`). `matrix` est facultative (non requise par les règles).
    `trips` est le plan complet du jour. Si `problem.locked_trips` est renseigné (recalcul en
    conservant, F5.3), RM-17 vérifie que ces tournées se retrouvent inchangées dans `trips`.
    """
    violations: list[ViolationD] = []
    for rule in (
        rm_01_trip_resources,
        rm_02_no_overlap,
        rm_03_driver_eligible,
        rm_04_truck_eligible,
        rm_05_compartment_capacity,
        rm_06_compartment_single_product,
        rm_07_compartment_allowed_product,
        rm_08_depot_stock,
        rm_09_truck_size,
        rm_10_time_windows,
        rm_11_service_duration,
        rm_14_max_loadings,
    ):
        violations.extend(rule(problem, trips))
    violations.extend(rm_15_urgent_orders(problem, trips, unserved))
    violations.extend(rm_16_delivery_volume(problem, trips))
    if problem.locked_trips:
        violations.extend(_locked_violations(problem.locked_trips, trips, problem))
    return violations


def has_blocking(violations: list[ViolationD]) -> bool:
    """Vrai si au moins une violation est bloquante (la publication du plan est alors refusée)."""
    return any(v.severity == Severity.BLOCKING for v in violations)
