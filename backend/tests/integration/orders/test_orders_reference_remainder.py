"""Commandes d'une journée de référence (F8.1) écartées par défaut, et reliquat d'une commande (RM-16)."""

from decimal import Decimal

from sqlalchemy import event, select

from app.core.db import async_engine
from app.core.enums import (
    ImportKind,
    ImportStatus,
    OrderSource,
    OrderStatus,
    PlanKind,
    PlanStatus,
    StopStatus,
)
from app.imports.models import ImportBatch
from app.orders import service
from app.orders.models import Order
from app.planning import service as planning_service
from app.planning.models import Plan, Stop, StopDelivery, Trip
from tests.integration.orders.factories import (
    DAY,
    make_depot,
    make_driver,
    make_order,
    make_station,
    make_truck,
)

S = OrderStatus


async def _batch(db, kind: ImportKind) -> ImportBatch:
    batch = ImportBatch(kind=kind, filename=f"{kind.value}.xlsx", status=ImportStatus.APPLIED)
    db.add(batch)
    await db.commit()
    return batch


async def _imported(db, station, product, batch, status=S.DRAFT) -> Order:
    order = await make_order(db, station, product, status=status)
    order.source, order.import_batch_id = OrderSource.IMPORT, batch.id
    await db.commit()
    return order


async def _world(db, products):
    """Deux commandes du jour (une saisie, une importée par F3.2) et deux d'une journée de référence."""
    station = await make_station(db, tanks={products["SUPER"]: (30000, 3000)})
    reference = await _batch(db, ImportKind.REFERENCE_DAY)
    daily = await _batch(db, ImportKind.ORDERS)
    manual = await make_order(db, station, products["SUPER"], status=S.CONFIRMED)
    imported = await _imported(db, station, products["SUPER"], daily)
    ref_delivered = await _imported(db, station, products["SUPER"], reference, S.DELIVERED)
    ref_postponed = await _imported(db, station, products["SUPER"], reference, S.POSTPONED)
    return manual, imported, ref_delivered, ref_postponed


async def test_E6_liste_sans_les_commandes_de_la_journee_de_reference(client, db, auth_headers, products):
    manual, imported, ref_delivered, ref_postponed = await _world(db, products)
    headers = await auth_headers("manager")
    params = {"day": DAY.isoformat()}

    default = (await client.get("/orders", params=params, headers=headers)).json()
    assert default["total"] == 2
    assert {item["id"] for item in default["items"]} == {str(manual.id), str(imported.id)}
    assert all(item["is_reference"] is False for item in default["items"])
    # Le filtre par statut ne les fait pas réapparaître.
    delivered = await client.get("/orders", params={**params, "status": "delivered"}, headers=headers)
    assert delivered.json()["total"] == 0

    everything = (
        await client.get("/orders", params={**params, "include_reference": "true"}, headers=headers)
    ).json()
    assert everything["total"] == 4
    flags = {item["id"]: item for item in everything["items"]}
    assert flags[str(ref_delivered.id)]["is_reference"] is True
    assert flags[str(ref_postponed.id)]["is_reference"] is True
    assert flags[str(imported.id)]["is_reference"] is False  # import de commandes du jour (F3.2)
    # Pas de reliquat pour une commande de référence.
    for key in ("planned_l", "delivered_l", "remaining_l"):
        assert flags[str(ref_delivered.id)][key] is None
        assert flags[str(manual.id)][key] is not None

    # La lecture unitaire reste possible.
    one = await client.get(f"/orders/{ref_delivered.id}", headers=headers)
    assert one.status_code == 200
    assert one.json()["is_reference"] is True


async def test_E6_resume_sans_les_commandes_de_la_journee_de_reference(client, db, auth_headers, products):
    await _world(db, products)
    response = await client.get(
        "/availability/summary", params={"day": DAY.isoformat()}, headers=await auth_headers("manager")
    )
    orders = response.json()["orders"]
    assert orders["total"] == 2
    assert orders["by_status"]["confirmed"] == 1
    assert orders["by_status"]["draft"] == 1
    assert orders["by_status"]["delivered"] == 0
    assert orders["by_status"]["postponed"] == 0


async def test_E6_le_calcul_du_jour_ne_prend_pas_les_commandes_de_reference(db, products):
    manual, _imported_order, _ref_delivered, _ref_postponed = await _world(db, products)
    await make_depot(db)
    problem = await planning_service.build_problem(db, DAY)
    assert [order.id for order in problem.orders] == [str(manual.id)]

    ids = (
        await db.execute(select(Order.id).where(Order.day == DAY, service.not_reference_order()))
    ).scalars()
    assert len(set(ids)) == 2


async def _published_plan(db, deliveries, *, status=PlanStatus.PUBLISHED, kind=PlanKind.COMPUTED) -> Stop:
    """Plan d'une tournée et d'un arrêt ; `deliveries` : [(commande, planifié, livré ou None)]."""
    depot = await make_depot(db, f"DEP-{status.value}-{kind.value}")
    truck = await make_truck(db, f"LT-{status.value[:3]}-{kind.value[:3]}")
    driver = await make_driver(db, f"Chauffeur {status.value} {kind.value}")
    plan = Plan(day=DAY, kind=kind, status=status)
    trip = Trip(seq=1, truck_id=truck.id, driver_id=driver.id, depot_id=depot.id)
    stop = Stop(seq=1, station_id=deliveries[0][0].station_id)
    for order, planned, actual in deliveries:
        stop.deliveries.append(
            StopDelivery(
                order_id=order.id,
                product_id=order.product_id,
                planned_l=Decimal(str(planned)),
                actual_l=None if actual is None else Decimal(str(actual)),
            )
        )
    trip.stops.append(stop)
    plan.trips.append(trip)
    db.add(plan)
    await db.commit()
    return stop


async def test_RM_16_reliquat_d_une_commande(client, db, auth_headers, products):
    station = await make_station(db, tanks={products["SUPER"]: (30000, 3000)})
    super_ = products["SUPER"]
    untouched = await make_order(db, station, super_, status=S.CONFIRMED, requested_l=10000)
    partial = await make_order(db, station, super_, status=S.CONFIRMED, requested_l=6000)
    full = await make_order(db, station, super_, status=S.PLANNED, requested_l=8000)
    done = await make_order(db, station, super_, status=S.DELIVERED, requested_l=5000)
    cancelled = await make_order(db, station, super_, status=S.CANCELLED, requested_l=4000)
    await _published_plan(db, [(partial, 3000, 2950.5), (full, 8000, None), (done, 5000, 4990)])
    # Un plan brouillon et un plan de référence ne comptent pas.
    await _published_plan(db, [(untouched, 10000, None)], status=PlanStatus.DRAFT)
    await _published_plan(db, [(untouched, 10000, 10000)], kind=PlanKind.MANUAL_REFERENCE)
    headers = await auth_headers("manager")

    statements: list[str] = []

    def _count(conn, cursor, statement, *args):
        statements.append(statement)

    event.listen(async_engine.sync_engine, "before_cursor_execute", _count)
    try:
        listing = await client.get("/orders", params={"day": DAY.isoformat()}, headers=headers)
    finally:
        event.remove(async_engine.sync_engine, "before_cursor_execute", _count)
    assert listing.status_code == 200, listing.text
    rows = {item["id"]: item for item in listing.json()["items"]}

    def volumes(order) -> tuple:
        row = rows[str(order.id)]
        return row["planned_l"], row["delivered_l"], row["remaining_l"]

    assert volumes(untouched) == (0.0, 0.0, 10000.0)
    assert volumes(partial) == (3000.0, 2950.5, 3000.0)
    assert volumes(full) == (8000.0, 0.0, 0.0)
    assert volumes(done) == (5000.0, 4990.0, 0.0)
    assert volumes(cancelled) == (0.0, 0.0, 0.0)  # plus rien à planifier
    # Les volumes de la page sont lus en bloc, pas commande par commande.
    assert sum("FROM stop_deliveries" in s for s in statements) <= 2

    one = (await client.get(f"/orders/{partial.id}", headers=headers)).json()
    assert (one["planned_l"], one["delivered_l"], one["remaining_l"]) == (3000.0, 2950.5, 3000.0)


async def test_RM_16_arret_saute_la_commande_reste_a_planifier(client, db, auth_headers, products):
    station = await make_station(db)
    order = await make_order(db, station, products["SUPER"], status=S.CONFIRMED, requested_l=7000)
    stop = await _published_plan(db, [(order, 7000, None)])
    stop.status = StopStatus.SKIPPED
    await db.commit()
    row = (await client.get(f"/orders/{order.id}", headers=await auth_headers("manager"))).json()
    assert (row["planned_l"], row["delivered_l"], row["remaining_l"]) == (0.0, 0.0, 7000.0)
