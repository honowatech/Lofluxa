"""F8.4 — indicateurs d'un plan, écarts et verdict : valeurs calculées à la main."""

from app.comparison.metrics import (
    INDICATORS,
    DeliveryM,
    OrderM,
    PlanM,
    StopM,
    TripM,
    compare,
    compute_metrics,
    verdict,
)

ORDERS = (
    OrderM("O1", "S1", 12000),
    OrderM("O2", "S1", 8000),
    OrderM("O3", "S2", 15000),
    OrderM("O4", "S3", 10000),
    OrderM("O5", "S4", 5000),  # jamais servie par le plan manuel
)


def _manual() -> PlanM:
    """Journée manuelle : 3 tournées, 2 camions, 2 chauffeurs, réel partiellement renseigné."""
    return PlanM(
        trips=(
            TripM(
                truck_id="T1",
                driver_id="D1",
                truck_capacity_l=40000,
                distance_m=62_400,
                duration_s=4 * 3600,
                actual_distance_m=70_000,
                actual_duration_s=5 * 3600,
                stops=(
                    StopM("S1", "delivered", (DeliveryM("O1", 12000, 11900), DeliveryM("O2", 8000, 8000))),
                    StopM("S3", "delivered", (DeliveryM("O4", 6000, 6000),)),
                ),
            ),
            TripM(
                truck_id="T2",
                driver_id="D2",
                truck_capacity_l=20000,
                distance_m=37_600,
                duration_s=3 * 3600,
                stops=(StopM("S2", "delivered", (DeliveryM("O3", 15000, None),)),),
            ),
            TripM(  # second chargement du camion T1, même chauffeur
                truck_id="T1",
                driver_id="D1",
                truck_capacity_l=40000,
                distance_m=20_000,
                duration_s=3600,
                actual_distance_m=21_500,
                stops=(StopM("S3", "skipped", (DeliveryM("O4", 4000, None),)),),
            ),
            TripM(truck_id="T9", driver_id="D9", truck_capacity_l=30000, distance_m=999),  # vide : ignorée
        ),
        orders=ORDERS,
        violations_blocking=1,
        violations_warning=2,
        prep_time_s=7200,
        computed_in_ms=None,
    )


def _computed() -> PlanM:
    """Plan calculé : 2 tournées, tout est servi, rien de réalisé."""
    return PlanM(
        trips=(
            TripM(
                truck_id="T1",
                driver_id="D1",
                truck_capacity_l=40000,
                distance_m=70_000,
                duration_s=5 * 3600,
                stops=(
                    StopM("S1", deliveries=(DeliveryM("O1", 12000), DeliveryM("O2", 8000))),
                    StopM("S3", deliveries=(DeliveryM("O4", 10000),)),
                    StopM("S4", deliveries=(DeliveryM("O5", 5000),)),
                ),
            ),
            TripM(
                truck_id="T2",
                driver_id=None,  # chauffeur non trouvé
                truck_capacity_l=20000,
                distance_m=32_000,
                duration_s=2 * 3600 + 1800,
                stops=(StopM("S2", deliveries=(DeliveryM("O3", 15000),)),),
            ),
        ),
        orders=ORDERS,
        computed_in_ms=41_600,
    )


def test_indicateurs_du_plan_manuel():
    metrics = compute_metrics(_manual())

    assert metrics.distance_estimated_m == 62_400 + 37_600 + 20_000  # 120,0 km
    assert metrics.distance_actual_m == 70_000 + 21_500  # deux tournées sur trois renseignées
    assert metrics.distance_actual_trips == 2
    assert (metrics.trucks_used, metrics.drivers_used, metrics.trips_count) == (2, 2, 3)
    assert (metrics.stations_requested, metrics.stations_served) == (4, 3)
    assert metrics.stations_delivered == 3  # S1, S3 (livrée à la tournée 1, sautée à la 3) et S2
    assert (metrics.orders_requested, metrics.orders_served) == (5, 4)
    assert metrics.volume_requested_l == 50000.0
    assert metrics.volume_planned_l == 12000 + 8000 + 6000 + 15000 + 4000
    assert metrics.volume_delivered_l == 11900 + 8000 + 6000
    assert metrics.service_duration_s == 8 * 3600
    assert metrics.service_duration_actual_s == 5 * 3600
    # (26 000 / 40 000 + 15 000 / 20 000 + 4 000 / 40 000) / 3 = (65 + 75 + 10) / 3
    assert metrics.fill_rate_avg_pct == 50.0
    assert (metrics.violations_blocking, metrics.violations_warning, metrics.violations_total) == (1, 2, 3)
    assert (metrics.prep_time_s, metrics.prep_time_source) == (7200, "manual")


def test_indicateurs_du_plan_calcule_reel_non_renseigne():
    metrics = compute_metrics(_computed())

    assert metrics.distance_estimated_m == 102_000
    assert metrics.distance_actual_m is None and metrics.distance_actual_trips == 0
    assert (metrics.trucks_used, metrics.drivers_used, metrics.trips_count) == (2, 1, 2)
    assert (metrics.stations_requested, metrics.stations_served, metrics.stations_delivered) == (4, 4, None)
    assert (metrics.orders_requested, metrics.orders_served) == (5, 5)
    assert (metrics.volume_requested_l, metrics.volume_planned_l, metrics.volume_delivered_l) == (
        50000,
        50000,
        None,
    )
    assert metrics.service_duration_s == 7 * 3600 + 1800
    assert metrics.service_duration_actual_s is None
    assert metrics.fill_rate_avg_pct == 81.25  # (35 000 / 40 000 + 15 000 / 20 000) / 2
    assert metrics.violations_total == 0
    assert (metrics.prep_time_s, metrics.prep_time_source) == (42, "computed")  # 41,6 s arrondi


def test_plan_vide_et_cas_limites():
    metrics = compute_metrics(PlanM())
    assert metrics.distance_estimated_m == 0 and metrics.trips_count == 0
    assert (
        metrics.fill_rate_avg_pct is None and metrics.prep_time_s is None and metrics.prep_time_source is None
    )
    assert metrics.stations_delivered is None and metrics.volume_delivered_l is None

    # Camion sans capacité connue : exclu du taux de remplissage ; volume planifié nul : commande non servie.
    plan = PlanM(
        trips=(TripM("T1", stops=(StopM("S1", deliveries=(DeliveryM("O1", 0.0),)),)),),
        orders=(OrderM("O1", "S1", 1000),),
        prep_time_s=0,
        computed_in_ms=5000,
    )
    metrics = compute_metrics(plan)
    assert metrics.fill_rate_avg_pct is None
    assert (metrics.orders_served, metrics.stations_served) == (0, 0)
    assert (metrics.prep_time_s, metrics.prep_time_source) == (0, "manual")  # la saisie prime, même à zéro


def test_ecarts_en_valeur_et_en_pourcentage():
    rows = {row.key: row for row in compare(compute_metrics(_manual()), compute_metrics(_computed()))}
    assert list(rows) == [indicator.key for indicator in INDICATORS]

    km = rows["distance_estimated_m"]
    assert (km.a, km.b, km.delta, km.delta_pct, km.better) == (120_000, 102_000, -18_000, -15.0, "b")
    assert (rows["trips_count"].delta, rows["trips_count"].delta_pct, rows["trips_count"].better) == (
        -1,
        -33.33,
        "b",
    )
    assert (rows["trucks_used"].delta, rows["trucks_used"].better) == (0, "equal")
    assert (rows["drivers_used"].delta, rows["drivers_used"].better) == (-1, "b")
    assert (
        rows["stations_served"].delta,
        rows["stations_served"].delta_pct,
        rows["stations_served"].better,
    ) == (
        1,
        33.33,
        "b",
    )
    assert (rows["volume_planned_l"].delta, rows["volume_planned_l"].delta_pct) == (5000, 11.11)
    assert (rows["fill_rate_avg_pct"].delta, rows["fill_rate_avg_pct"].better) == (31.25, "b")
    assert (rows["service_duration_s"].delta, rows["service_duration_s"].better) == (-1800, "b")
    assert (rows["violations_blocking"].delta, rows["violations_blocking"].delta_pct) == (-1, -100.0)
    assert (rows["prep_time_s"].delta, rows["prep_time_s"].delta_pct) == (-7158, -99.42)
    # Réel inconnu d'un côté : pas d'écart.
    actual = rows["distance_actual_m"]
    assert (actual.a, actual.b, actual.delta, actual.delta_pct, actual.better) == (
        91_500,
        None,
        None,
        None,
        None,
    )
    # Grandeur de contexte : écart donné, mais ni mieux ni moins bien.
    assert (rows["volume_requested_l"].delta, rows["volume_requested_l"].better) == (0, None)
    # A = 0 : pas de pourcentage.
    inverse = {row.key: row for row in compare(compute_metrics(_computed()), compute_metrics(_manual()))}
    assert (inverse["violations_total"].delta, inverse["violations_total"].delta_pct) == (3, None)
    assert inverse["violations_total"].better == "a"


def test_verdict_par_rapport_au_seuil():
    manual, computed = compute_metrics(_manual()), compute_metrics(_computed())

    ok = verdict(manual, computed, 10.0)
    assert (ok.gain_m, ok.gain_pct, ok.success) == (18_000, 15.0, True)
    assert ok.threshold_pct == 10.0 and (ok.distance_a_m, ok.distance_b_m) == (120_000, 102_000)
    assert ok.gain_vs_actual_pct is None  # km réels de A incomplets (2 tournées sur 3)
    assert ok.no_blocking_violation is True and ok.orders_served_ok is True
    assert ok.message == (
        "Objectif atteint : le plan B parcourt 15,0 % de kilomètres en moins que le plan A (seuil : 10,0 %)."
    )

    assert verdict(manual, computed, 15.0).success is True  # seuil atteint pile
    short = verdict(manual, computed, 20.0)
    assert short.success is False
    assert short.message == (
        "Objectif non atteint : le gain kilométrique du plan B est de 15,0 %, sous le seuil de 20,0 %."
    )

    worse = verdict(computed, manual, 10.0)
    assert (worse.gain_pct, worse.success) == (-17.65, False)
    assert worse.no_blocking_violation is False and worse.orders_served_ok is False
    assert "17,6 % de kilomètres en plus" in worse.message

    unknown = verdict(compute_metrics(PlanM()), computed, 10.0)
    assert unknown.gain_pct is None and unknown.success is None
    assert unknown.message.startswith("Verdict impossible")


def test_verdict_gain_sur_les_km_reels_si_complets():
    manual = PlanM(
        trips=(
            TripM("T1", "D1", 40000, distance_m=50_000, actual_distance_m=64_000, stops=(StopM("S1"),)),
            TripM("T2", "D2", 20000, distance_m=30_000, actual_distance_m=36_000, stops=(StopM("S2"),)),
        )
    )
    computed = PlanM(trips=(TripM("T1", "D1", 40000, distance_m=70_000, stops=(StopM("S1"), StopM("S2"))),))
    result = verdict(compute_metrics(manual), compute_metrics(computed), 10.0)
    assert result.gain_pct == 12.5  # (80 − 70) / 80
    assert result.gain_vs_actual_pct == 30.0  # (100 − 70) / 100
