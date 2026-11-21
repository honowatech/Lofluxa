"""Consultation du journal d'audit (F9.3)."""

import uuid
from datetime import UTC, datetime

from app.audit.models import AuditLog


def _entry(table: str, row_id: str, actor_id, at: datetime, action: str = "update") -> AuditLog:
    return AuditLog(
        table_name=table,
        row_id=row_id,
        action=action,
        before={"v": 1},
        after={"v": 2},
        actor_id=actor_id,
        at=at,
    )


async def _seed(db, make_user):
    alice = await make_user("dispatcher", email="alice@tourneo-test.cm")
    bob = await make_user("supply", email="bob@tourneo-test.cm")
    plan_id = str(uuid.uuid4())
    db.add_all(
        [
            _entry("plans", plan_id, alice.id, datetime(2027, 1, 10, 8, 0, tzinfo=UTC), "insert"),
            _entry("plans", plan_id, alice.id, datetime(2027, 1, 11, 9, 0, tzinfo=UTC)),
            _entry("plans", str(uuid.uuid4()), bob.id, datetime(2027, 1, 12, 10, 0, tzinfo=UTC)),
            _entry("settings", "max_service_hours", bob.id, datetime(2027, 1, 12, 23, 30, tzinfo=UTC)),
            _entry("trips", str(uuid.uuid4()), None, datetime(2027, 1, 13, 7, 0, tzinfo=UTC), "delete"),
        ]
    )
    await db.flush()
    return alice, bob, plan_id


async def test_reserve_aux_roles_admin_et_manager(client, auth_headers):
    for role in ("admin", "manager"):
        assert (await client.get("/audit", headers=await auth_headers(role))).status_code == 200
    for role in ("dispatcher", "fleet", "supply"):
        assert (await client.get("/audit", headers=await auth_headers(role))).status_code == 403
    assert (await client.get("/audit")).status_code == 401


async def test_liste_paginee_du_plus_recent_au_plus_ancien_avec_nom_de_l_acteur(
    client, auth_headers, db, make_user
):
    alice, _bob, _plan_id = await _seed(db, make_user)
    headers = await auth_headers("manager")
    body = (await client.get("/audit", params={"limit": 2}, headers=headers)).json()
    assert body["total"] == 5 and body["limit"] == 2 and len(body["items"]) == 2
    assert [item["table_name"] for item in body["items"]] == ["trips", "settings"]
    assert body["items"][0]["actor_id"] is None and body["items"][0]["actor_name"] is None
    assert body["items"][1]["actor_name"] == "Test supply"
    assert body["items"][1]["actor_email"] == "bob@tourneo-test.cm"
    assert body["items"][1]["before"] == {"v": 1} and body["items"][1]["after"] == {"v": 2}
    assert body["items"][1]["at"].startswith("2027-01-12T23:30:00")

    next_page = (await client.get("/audit", params={"limit": 2, "offset": 2}, headers=headers)).json()
    assert [item["at"][:10] for item in next_page["items"]] == ["2027-01-12", "2027-01-11"]
    assert next_page["items"][1]["actor_name"] == alice.full_name


async def test_filtres_table_et_ligne(client, auth_headers, db, make_user):
    _alice, _bob, plan_id = await _seed(db, make_user)
    headers = await auth_headers("admin")
    plans = (await client.get("/audit", params={"table": "plans"}, headers=headers)).json()
    assert plans["total"] == 3
    one = (await client.get("/audit", params={"table": "plans", "row_id": plan_id}, headers=headers)).json()
    assert one["total"] == 2 and [item["action"] for item in one["items"]] == ["update", "insert"]
    none = (await client.get("/audit", params={"table": "loadings"}, headers=headers)).json()
    assert none == {"items": [], "total": 0, "limit": 50, "offset": 0}


async def test_filtres_acteur_et_action(client, auth_headers, db, make_user):
    alice, bob, _plan_id = await _seed(db, make_user)
    headers = await auth_headers("admin")
    by_bob = (await client.get("/audit", params={"actor_id": str(bob.id)}, headers=headers)).json()
    assert by_bob["total"] == 2 and {item["actor_id"] for item in by_bob["items"]} == {str(bob.id)}
    inserts = (
        await client.get("/audit", params={"actor_id": str(alice.id), "action": "insert"}, headers=headers)
    ).json()
    assert inserts["total"] == 1
    assert (await client.get("/audit", params={"action": "truncate"}, headers=headers)).status_code == 422


async def test_filtre_par_periode_en_jours_locaux(client, auth_headers, db, make_user):
    await _seed(db, make_user)
    headers = await auth_headers("admin")
    window = (
        await client.get(
            "/audit", params={"date_from": "2027-01-11", "date_to": "2027-01-12"}, headers=headers
        )
    ).json()
    # 23:30 UTC le 12 = 00:30 le 13 à Douala (UTC+1) : hors de la période (RM-20).
    assert [item["at"][:13] for item in window["items"]] == ["2027-01-12T10", "2027-01-11T09"]
    since = (await client.get("/audit", params={"date_from": "2027-01-13"}, headers=headers)).json()
    assert [item["table_name"] for item in since["items"]] == ["trips", "settings"]
    until = (await client.get("/audit", params={"date_to": "2027-01-10"}, headers=headers)).json()
    assert until["total"] == 1


async def test_une_modification_de_parametre_apparait_dans_le_journal(client, login):
    admin, tokens = await login("admin")
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}
    await client.put("/settings", json={"values": {"company_name": "OLA Test"}}, headers=headers)
    body = (
        await client.get("/audit", params={"table": "settings", "row_id": "company_name"}, headers=headers)
    ).json()
    assert body["total"] == 1
    assert body["items"][0]["actor_name"] == admin.full_name
    assert body["items"][0]["after"]["value"] == "OLA Test"
