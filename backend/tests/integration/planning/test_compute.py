"""Base ↔ domaine, calcul et trace (F4.1, F4.5, F4.6, RM-20)."""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import func, select

from app.availability.models import DailyDepotStock, DailyResourceStatus
from app.core.enums import OrderStatus, PlanKind, PlanStatus, TruckStatus
from app.core.errors import ConflictError, ValidationAppError
from app.core.time import utcnow
from app.planning import mapping, service
from app.planning.distance_cache import DbDistanceCache
from app.planning.models import DistanceCache
from tests.integration.planning import fakes as fakes_module


async def test_build_problem_commandes_confirmees_et_ressources(db, world, fakes):
    world.orders["o5"].status = OrderStatus.DRAFT
    world.trucks["LT-002-BB"].status = TruckStatus.MAINTENANCE
    db.add(
        DailyResourceStatus(day=world.day, driver_id=world.drivers["Che"].id, available=False, reason="Repos")
    )
    await db.flush()

    problem = await service.build_problem(db, world.day)

    assert {o.id for o in problem.orders} == {str(world.orders[k].id) for k in ("o1", "o2", "o3", "o4")}
    # Tous les camions et chauffeurs, avec statut et disponibilité du jour.
    assert len(problem.trucks) == 2 and len(problem.drivers) == 3
    assert not problem.truck(str(world.trucks["LT-002-BB"].id)).affectable
    assert problem.driver(str(world.drivers["Che"].id)).available_today is False
    assert problem.driver(str(world.drivers["Abena"].id)).default_truck_id == str(
        world.trucks["LT-001-AA"].id
    )
    # Affectation du jour (F2.4).
    assert problem.driver_by_truck == {str(world.trucks["LT-002-BB"].id): str(world.drivers["Biya"].id)}
    # Fenêtres du jour (mardi 06:00–18:00) et fenêtre de commande en secondes locales.
    assert problem.depots[0].windows == ((6 * 3600, 18 * 3600),)
    assert problem.order(str(world.orders["o2"].id)).window == (7 * 3600, 16 * 3600)
    assert problem.truck(str(world.trucks["LT-001-AA"].id)).total_capacity_l == 30000
    assert {s.code for s in problem.stations} == {"ST-01", "ST-02", "ST-03", "ST-04"}


async def test_build_problem_stock_depot_saisie_la_plus_recente(db, world, fakes):
    super_id = world.products["SUPER"].id
    for minutes, volume in ((5, "50000"), (10, "42000")):
        db.add(
            DailyDepotStock(
                depot_id=world.depot.id,
                product_id=super_id,
                day=world.day,
                available_l=Decimal(volume),
                entered_at=utcnow() + timedelta(minutes=minutes),
            )
        )
    await db.flush()
    problem = await service.build_problem(db, world.day)
    assert problem.depot_stocks[(str(world.depot.id), str(super_id))] == 42000.0
    # Produit sans saisie : clé absente (RM-08, avertissement « stock non renseigné »).
    assert (str(world.depot.id), str(world.products["PETROLE"].id)) not in problem.depot_stocks


async def test_build_problem_order_ids_imposes_et_surcharge_de_parametres(db, world, fakes):
    world.orders["o1"].status = OrderStatus.DELIVERED
    await db.flush()
    problem = await service.build_problem(
        db, world.day, params_override={"max_service_hours": 9.5}, order_ids=[world.orders["o1"].id]
    )
    assert [o.id for o in problem.orders] == [str(world.orders["o1"].id)]
    assert problem.params.max_service_hours == 9.5
    assert problem.params.default_depot_wait_min == 90  # réglage par défaut conservé

    with pytest.raises(ValidationAppError):
        await service.build_problem(db, world.day, params_override={"vitesse": 3})


async def test_run_compute_enregistre_le_plan_et_sa_trace(db, world, fakes, dispatcher):
    seen = []
    plan = await service.run_compute(
        db, world.day, params_override={"solver_seed": 7}, progress=lambda pct, msg: seen.append(pct)
    )

    assert plan.status == PlanStatus.DRAFT and plan.kind == PlanKind.COMPUTED
    assert plan.version == 1 and plan.root_plan_id == plan.id and plan.parent_plan_id is None
    # Trace de reproductibilité (F4.6).
    assert plan.engine_version == fakes_module.FAKE_ENGINE_VERSION
    assert plan.params_snapshot["solver_seed"] == 7 and plan.params_snapshot["timezone"] == "Africa/Douala"
    assert plan.computed_at is not None and plan.computed_in_ms == 12
    assert plan.approximate is True  # matrice de repli
    assert plan.solver_log == {"status": "FAKE", "iterations": 1}
    assert plan.created_by == dispatcher.id
    # Métriques : celles du moteur + celles recalculées par le service.
    assert plan.metrics["objective_km"] == 123.4
    assert plan.metrics["trips_count"] == 2 and plan.metrics["orders_served"] == 5
    assert plan.metrics["planned_l"] == 38000.0 and plan.metrics["orders_unserved"] == 0
    assert plan.metrics["total_distance_m"] == sum(t.distance_m for t in plan.trips) > 0
    # Contenu : 2 tournées, arrêts ordonnés, livraisons, plan de chargement.
    first, second = plan.trips
    assert [s.seq for s in first.stops] == [1, 2, 3]
    assert first.driver_id == world.drivers["Abena"].id and second.driver_id == world.drivers["Biya"].id
    assert len(second.stops) == 1 and len(second.stops[0].deliveries) == 2
    assert sum(x.planned_l for x in first.compartment_loads) == Decimal("24000")
    assert plan.unserved == [] and plan.violations == []
    # Progression croissante jusqu'à 100.
    assert seen == sorted(seen) and seen[-1] == 100


async def test_RM_20_heures_stockees_en_utc(db, plan, world):
    """RM-20 : départ à 08:15 heure de Douala (06:00 + 90 min d'attente + 45 min de chargement)
    → stocké 07:15 UTC ; la relecture en domaine redonne les secondes locales."""
    trip = plan.trips[0]
    assert trip.planned_start_at.astimezone(UTC) == datetime(2027, 1, 12, 5, 0, tzinfo=UTC)
    assert trip.planned_depart_at.astimezone(UTC) == datetime(2027, 1, 12, 7, 15, tzinfo=UTC)

    trips = await service.load_plan_trips(db, plan.id)
    assert trips[0].ref == str(trip.id)
    assert trips[0].start_s == 6 * 3600 and trips[0].depart_s == 8 * 3600 + 15 * 60
    assert trips[0].stops[0].ref == str(trip.stops[0].id)
    assert trips[0].stops[0].arrival_s == mapping.to_seconds(
        world.day, trip.stops[0].planned_arrival_at, "Africa/Douala"
    )
    assert trips[0].volumes_by_product()[str(world.products["SUPER"].id)] == 16000.0


async def test_run_compute_sans_commande_confirmee(db, world, fakes):
    for order in world.orders.values():
        order.status = OrderStatus.DRAFT
    await db.flush()
    with pytest.raises(ConflictError) as excinfo:
        await service.run_compute(db, world.day)
    assert "12/01/2027" in excinfo.value.message


async def test_non_servies_enregistrees_avec_leur_raison(db, world, fakes):
    """F4.4 : une commande non servie ne disparaît jamais silencieusement."""
    fakes.engine.skip = {str(world.orders["o3"].id)}
    plan = await service.run_compute(db, world.day)
    assert [(u.order_id, u.reason_code) for u in plan.unserved] == [(world.orders["o3"].id, "other")]
    assert [v.rule_code for v in plan.violations] == ["RM-15"]  # fakes. : urgente non servie
    assert plan.metrics["blocking_count"] == 1 and plan.metrics["orders_unserved"] == 1


async def test_cache_des_distances_en_base(db, world, fakes):
    problem = await service.build_problem(db, world.day)
    matrix = await mapping.build_plan_matrix(db, problem)
    count = await db.scalar(select(func.count()).select_from(DistanceCache))
    assert count == 5 * 4  # 5 nœuds, toutes les paires orientées

    # Une valeur déjà en cache est relue, pas recalculée.
    a, b = (fakes_module.fake_coord_hash(n.lat, n.lon) for n in (problem.depots[0], problem.stations[0]))
    cache = DbDistanceCache()
    await cache.preload(db, [a, b])
    assert cache.get_many([(a, b), (a, "inconnu")]) == {
        (a, b): (
            matrix.distance(problem.depots[0].id, problem.stations[0].id),
            matrix.duration(problem.depots[0].id, problem.stations[0].id),
        )
    }
    cache.put_many({(a, b): (1234, 99)})
    assert await cache.flush(db) == 1 and await cache.flush(db) == 0
    again = await mapping.build_plan_matrix(db, problem)
    assert again.distance(problem.depots[0].id, problem.stations[0].id) == 1234
    assert await db.scalar(select(func.count()).select_from(DistanceCache)) == count
