"""Journal d'audit automatique (F9.3) et `created_by`."""

from datetime import date
from decimal import Decimal

from sqlalchemy import select

from app.admin.models import Setting
from app.audit.models import AuditLog
from app.availability.models import DailyDepotStock
from app.core.context import current_user_id
from app.core.geo import latlon, point
from app.core.settings_store import get_setting, load_params
from app.core.time import utcnow
from app.referentials.models import Depot


async def test_ecriture_sur_table_auditee_journalisee(db, make_user, products):
    user = await make_user("supply")
    token = current_user_id.set(user.id)
    try:
        depot = Depot(code="SCDP-DLA", name="SCDP Douala", location=point(4.0483, 9.7043))
        db.add(depot)
        await db.flush()
        stock = DailyDepotStock(
            depot_id=depot.id,
            product_id=products["SUPER"].id,
            day=date(2027, 1, 12),
            available_l=Decimal("120000"),
            entered_at=utcnow(),
            entered_by=user.id,
        )
        db.add(stock)
        await db.flush()
        stock.available_l = Decimal("90000")
        await db.flush()
    finally:
        current_user_id.reset(token)

    assert depot.created_by == user.id
    lat, lon = latlon(depot.location)
    assert round(lat, 4) == 4.0483 and round(lon, 4) == 9.7043

    logs = (
        (
            await db.execute(
                select(AuditLog)
                .where(AuditLog.table_name == "daily_depot_stocks")
                .order_by(AuditLog.at, AuditLog.id)
            )
        )
        .scalars()
        .all()
    )
    assert [entry.action for entry in logs] == ["insert", "update"]
    assert logs[0].row_id == str(stock.id)
    assert logs[0].actor_id == user.id
    assert logs[1].before == {"available_l": 120000.0}
    assert logs[1].after == {"available_l": 90000.0}
    # Les dépôts ne font pas partie des tables auditées.
    assert (await db.execute(select(AuditLog).where(AuditLog.table_name == "depots"))).first() is None


async def test_parametres_defaut_et_surcharge(db):
    assert await get_setting(db, "max_service_hours") == 11.0
    db.add(Setting(key="max_service_hours", value=10))
    await db.flush()
    params = await load_params(db, {"solver_time_limit_s": 5})
    assert params.max_service_s == 10 * 3600
    assert params.solver_time_limit_s == 5
    assert params.window_tolerance_min == 30
