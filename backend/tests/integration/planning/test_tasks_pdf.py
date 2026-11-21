"""Lancement en tâche de fond, suivi `/tasks`, feuilles de route PDF (§11)."""

import pytest

from app.core.enums import PlanKind
from app.planning import service, tasks
from app.planning.tasks import compute_plan_task, recompute_plan_task


@pytest.fixture
def dispatched(monkeypatch):
    """Capture les lancements de tâches (une tâche réelle ne verrait pas la transaction du test)."""
    calls = []
    monkeypatch.setattr(
        tasks, "dispatch_compute", lambda **kw: calls.append(("compute", kw)) or "tache-calcul-1"
    )
    monkeypatch.setattr(
        tasks, "dispatch_recompute", lambda **kw: calls.append(("recompute", kw)) or "tache-recalcul-1"
    )
    return calls


class _Result:
    def __init__(self, state, info=None):
        self.state, self.info = state, info


async def test_post_plans_compute_lance_la_tache(client, auth_headers, world, dispatched):
    payload = {"day": "2027-01-12", "params": {"solver_time_limit_s": 20}}
    response = await client.post("/plans/compute", json=payload, headers=await auth_headers())
    assert response.status_code == 202 and response.json() == {"task_id": "tache-calcul-1"}
    kind, kwargs = dispatched[0]
    assert kind == "compute" and kwargs["day"] == "2027-01-12" and kwargs["kind"] == "computed"
    assert kwargs["params_override"] == {"solver_time_limit_s": 20} and kwargs["user_id"]
    assert kwargs["order_ids"] is None and kwargs["parent_plan_id"] is None


async def test_post_plans_compute_refus(client, auth_headers, world, dispatched):
    headers = await auth_headers()
    assert (
        await client.post("/plans/compute", json={"day": "2027-01-12"}, headers=await auth_headers("supply"))
    ).status_code == 403
    unknown = await client.post(
        "/plans/compute", json={"day": "2027-01-12", "params": {"turbo": 1}}, headers=headers
    )
    assert unknown.status_code == 422 and unknown.json()["details"][0]["field"] == "params.turbo"
    empty = await client.post("/plans/compute", json={"day": "2027-01-13"}, headers=headers)
    assert empty.status_code == 409 and empty.json()["code"] == "no_orders_to_plan"
    assert "13/01/2027" in empty.json()["message"]
    assert dispatched == []


async def test_launch_compute_transmet_le_rejeu(db, world, dispatched):
    order_ids = [world.orders["o1"].id]
    task_id = await service.launch_compute(
        db,
        world.day,
        user_id=None,
        kind=PlanKind.REPLAY,
        order_ids=order_ids,
        parent_plan_id=order_ids[0],
        label="Rejeu",
    )
    assert task_id == "tache-calcul-1"
    kwargs = dispatched[0][1]
    assert kwargs["kind"] == "replay" and kwargs["order_ids"] == [str(order_ids[0])]
    assert (
        kwargs["parent_plan_id"] == str(order_ids[0])
        and kwargs["label"] == "Rejeu"
        and kwargs["user_id"] is None
    )


async def test_post_recompute_lance_la_tache(client, auth_headers, plan, dispatched):
    plan_id = plan.id
    response = await client.post(f"/plans/{plan_id}/recompute", headers=await auth_headers())
    assert response.status_code == 202 and response.json() == {"task_id": "tache-recalcul-1"}
    assert dispatched[0] == (
        "recompute",
        {"plan_id": str(plan_id), "user_id": dispatched[0][1]["user_id"], "params_override": None},
    )
    with_params = await client.post(
        f"/plans/{plan_id}/recompute", json={"params": {"solver_seed": 3}}, headers=await auth_headers()
    )
    assert with_params.status_code == 202 and dispatched[1][1]["params_override"] == {"solver_seed": 3}
    missing = await client.post(
        "/plans/018f0000-0000-7000-8000-000000000000/recompute", headers=await auth_headers()
    )
    assert missing.status_code == 404


@pytest.mark.parametrize(
    ("result", "expected"),
    [
        (_Result("PENDING"), {"state": "pending", "progress": 0, "plan_id": None, "error": None}),
        (_Result("STARTED", {"pid": 1}), {"state": "running", "progress": 0}),
        (
            _Result("PROGRESS", {"progress": 40, "message": "Calcul des tournées"}),
            {"state": "running", "progress": 40, "message": "Calcul des tournées"},
        ),
        (
            _Result("SUCCESS", {"plan_id": "018f0000-0000-7000-8000-000000000001"}),
            {
                "state": "succeeded",
                "progress": 100,
                "plan_id": "018f0000-0000-7000-8000-000000000001",
                "error": None,
            },
        ),
        (
            _Result("SUCCESS", {"error": "Aucune commande confirmée à planifier pour le 12/01/2027."}),
            {
                "state": "failed",
                "plan_id": None,
                "error": "Aucune commande confirmée à planifier pour le 12/01/2027.",
            },
        ),
        (_Result("FAILURE", RuntimeError("boom")), {"state": "failed", "plan_id": None}),
    ],
)
async def test_get_task(client, auth_headers, monkeypatch, result, expected):
    monkeypatch.setattr(tasks, "AsyncResult", lambda task_id, app=None: result)
    response = await client.get("/tasks/abc-123", headers=await auth_headers("manager"))
    assert response.status_code == 200
    body = response.json()
    assert body["task_id"] == "abc-123"
    assert {key: body[key] for key in expected} == expected
    if body["state"] == "failed":
        assert body["error"] and "boom" not in body["error"]  # message lisible, sans détail technique
    assert (await client.get("/tasks/abc-123")).status_code == 401


async def test_tache_celery_reelle_erreur_lisible(fakes):
    """La tâche ouvre sa propre connexion : elle ne voit pas les données du test (aucune commande
    validée en base) et doit renvoyer un message lisible, pas une trace technique."""
    result = compute_plan_task.apply(kwargs={"day": "2031-03-04"})
    assert result.result == {
        "error": "Aucune commande confirmée à planifier pour le 04/03/2031.",
        "code": "no_orders_to_plan",
    }
    status = tasks.task_status(result.id)
    assert status["state"] == "failed" and status["error"].startswith("Aucune commande confirmée")

    missing = recompute_plan_task.apply(kwargs={"plan_id": "018f0000-0000-7000-8000-000000000000"})
    assert missing.result == {"error": "Plan introuvable.", "code": "not_found"}


async def test_tache_celery_sans_moteur_installe():
    """Sans le lot L2 (gabarit), l'échec reste lisible pour le dispatcher."""
    result = recompute_plan_task.apply(kwargs={"plan_id": "pas-un-uuid"})
    assert result.result["code"] == "internal_error" and result.id in result.result["error"]


async def test_feuille_de_route_pdf_d_une_tournee(client, auth_headers, plan):
    trip = plan.trips[0]
    response = await client.get(f"/trips/{trip.id}/route-sheet.pdf", headers=await auth_headers("fleet"))
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/pdf"
    assert "feuille-de-route_2027-01-12_T1_LT-001-AA.pdf" in response.headers["content-disposition"]
    assert response.content.startswith(b"%PDF") and len(response.content) > 3000
    assert (await client.get(f"/trips/{trip.id}/route-sheet.pdf")).status_code == 401
    missing = await client.get(
        "/trips/018f0000-0000-7000-8000-000000000000/route-sheet.pdf", headers=await auth_headers()
    )
    assert missing.status_code == 404


async def test_feuilles_de_route_pdf_du_plan(client, auth_headers, plan):
    one = await client.get(f"/trips/{plan.trips[0].id}/route-sheet.pdf", headers=await auth_headers())
    response = await client.get(f"/plans/{plan.id}/route-sheets.pdf", headers=await auth_headers("manager"))
    assert response.status_code == 200, response.text
    assert response.content.startswith(b"%PDF")
    assert response.content.count(b"/Type /Page") > one.content.count(b"/Type /Page") or len(
        response.content
    ) > len(one.content)
    assert "feuilles-de-route_2027-01-12_v1.pdf" in response.headers["content-disposition"]


async def test_contenu_de_la_feuille_de_route(db, plan):
    """Le gabarit porte toutes les mentions du §11 (vérifié sur le HTML avant conversion en PDF)."""
    from app.core.pdf import render_html
    from app.planning import route_sheet

    html = render_html(route_sheet.TEMPLATE, await route_sheet._context(db, plan, [plan.trips[0]]))
    for expected in (
        "OLA Energy Cameroun",
        "Feuille de route",
        "12/01/2027",
        "LT-001-AA",
        "Abena",
        "SCDP-DLA",
        "08:15",  # départ prévu, heure de Douala (RM-20)
        "ST-01 — Station 1",
        "Super",
        "10\u202f000 L",  # séparateur de milliers : espace fine insécable
        "Gérant 1",
        "+237 600 00 00 01",
        "Plan de chargement",
        "16\u202f000 L",
        "Chauffeur — nom, date et signature",
        "Dispatcher — nom, date et signature",
        "BROUILLON",
    ):
        assert expected in html, expected
