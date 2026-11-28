"""Preuve A/B de bout en bout (démo du jalon J5, critères d'acceptation 1 et 2).

Journée A : `data/fixtures/demo_douala/import/reference_day.xlsx`, un plan manuel plausible et
volontairement médiocre fabriqué par `scripts/demo/make_reference_day.py` (stations prises dans l'ordre
de leur code). Elle est importée par `POST /reference-days/import`, rejouée par le vrai moteur
(`POST /plans/{id}/replay`), puis comparée (`GET /comparison`, `GET /comparison.pdf`).
"""

from __future__ import annotations

import json

import pytest

from tests.e2e.conftest import artifacts_dir, load, run_ab


async def _plan(api, plan_id: str) -> dict:
    return (await api.call("GET", f"/plans/{plan_id}", "manager")).json()


def _served(plan: dict) -> set[str]:
    return {d["order_id"] for t in plan["trips"] for s in t["stops"] for d in s["deliveries"]}


async def test_journee_a_fabriquee_importee_rejouee_et_comparee(api, db, tasks):
    summary = await load(api, "demo_douala", orders=False)  # référentiels et stocks ; pas de commandes
    assert "orders" not in summary.imports and summary.orders_total == 0

    ab = await run_ab(api, db, tasks)

    # ----- journée A : plan manuel de référence (F8.1)
    imported = ab["imported"]
    assert imported["status"] == "applied" and imported["error_count"] == 0, imported["errors"]
    assert imported["warnings"] == []
    plan_a = await _plan(api, ab["plan_a"])
    assert plan_a["kind"] == "manual_reference" and plan_a["day"] == summary.day.isoformat()
    assert plan_a["prep_time_s"] == 120 * 60
    assert len(plan_a["trips"]) == 7 and len({t["truck_id"] for t in plan_a["trips"]}) == 4
    assert {t["status"] for t in plan_a["trips"]} == {"completed"}  # la journée a eu lieu
    assert all(t["driver_id"] and t["loads"] and t["actual_distance_m"] for t in plan_a["trips"])
    assert plan_a["blocking_count"] == 0, plan_a["violations"]  # médiocre, mais réalisable
    assert len(_served(plan_a)) == 20 and plan_a["unserved"] == []
    # Les stations sont prises dans l'ordre de leur code (seule la station à fenêtre passe devant).
    order = [s["station_code"] for t in sorted(plan_a["trips"], key=lambda t: t["seq"]) for s in t["stops"]]
    assert sorted(order) == [f"DLA{i:02d}" for i in range(1, 13)]
    # Une journée de référence ne se modifie pas et ne se publie pas.
    await api.call("POST", f"/plans/{ab['plan_a']}/publish", "dispatcher", expected=(409,))
    # Les commandes d'une journée de référence sont écartées de la liste par défaut (E6).
    assert await api.get_all("/orders", "manager", day=summary.day.isoformat()) == []
    orders = await api.get_all("/orders", "manager", day=summary.day.isoformat(), include_reference="true")
    assert {o["status"] for o in orders} == {"delivered"} and len(orders) == 20

    # ----- rejeu par le vrai moteur (F8.2)
    plan_b = await _plan(api, ab["plan_b"])
    assert plan_b["kind"] == "replay" and plan_b["status"] == "draft"
    assert plan_b["parent_plan_id"] == ab["plan_a"] and plan_b["approximate"] is True
    assert _served(plan_b) == _served(plan_a)  # mêmes commandes
    assert plan_b["unserved"] == [] and plan_b["blocking_count"] == 0, plan_b["violations"]
    # Le rejeu ne touche pas aux commandes de la journée de référence.
    orders = await api.get_all("/orders", "manager", day=summary.day.isoformat(), include_reference="true")
    assert {o["status"] for o in orders} == {"delivered"}

    # ----- comparaison (F8.4) et verdict (critères 1 et 2)
    comparison = ab["comparison"]
    a, b, verdict = comparison["metrics_a"], comparison["metrics_b"], comparison["verdict"]
    assert (comparison["plan_a"]["kind"], comparison["plan_b"]["kind"]) == ("manual_reference", "replay")
    assert a["distance_estimated_m"] == sum(t["distance_m"] for t in plan_a["trips"])
    assert b["distance_estimated_m"] == sum(t["distance_m"] for t in plan_b["trips"])
    assert a["orders_served"] == b["orders_served"] == a["orders_requested"] == 20
    assert a["stations_served"] == b["stations_served"] == 12
    assert a["volume_planned_l"] == b["volume_planned_l"] == pytest.approx(100_000)
    assert a["volume_delivered_l"] == pytest.approx(100_000) and b["volume_delivered_l"] is None
    assert (a["trips_count"], a["trucks_used"]) == (7, 4)
    assert b["trips_count"] <= a["trips_count"] and b["trucks_used"] <= a["trucks_used"]
    assert a["violations_blocking"] == b["violations_blocking"] == 0
    assert a["prep_time_s"] == 7200 and a["prep_time_source"]
    assert a["distance_actual_m"] and a["distance_actual_trips"] == 7

    assert verdict["threshold_pct"] == 10.0  # paramètre `ab_success_threshold_pct`
    assert verdict["distance_a_m"] == a["distance_estimated_m"]
    assert verdict["distance_b_m"] == b["distance_estimated_m"]
    assert verdict["gain_m"] == a["distance_estimated_m"] - b["distance_estimated_m"] > 0
    assert verdict["gain_pct"] == pytest.approx(100 * verdict["gain_m"] / a["distance_estimated_m"], abs=0.06)
    assert verdict["gain_pct"] >= verdict["threshold_pct"] and verdict["success"] is True
    assert verdict["no_blocking_violation"] is True and verdict["orders_served_ok"] is True
    assert verdict["gain_vs_actual_pct"] > verdict["gain_pct"]  # les km réels de A dépassent ses km estimés
    assert "Objectif atteint" in verdict["message"]

    distance = next(d for d in comparison["deltas"] if d["key"] == "distance_estimated_m")
    assert distance["better"] == "b" and distance["delta"] == -verdict["gain_m"]
    assert len(comparison["routes_a"]) == 7 and len(comparison["routes_b"]) == len(plan_b["trips"])
    for route in comparison["routes_a"] + comparison["routes_b"]:
        assert route["points"][0]["kind"] == "depot" and route["points"][-1]["kind"] == "depot"
        assert len(route["points"]) == len(route["stops"]) + 2

    # ----- rapport PDF (F8.5)
    pdf = await api.call(
        "GET", "/comparison.pdf", "manager", params={"plan_a": ab["plan_a"], "plan_b": ab["plan_b"]}
    )
    assert pdf.headers["content-type"] == "application/pdf" and pdf.content.startswith(b"%PDF")
    assert f"comparaison_AB_{summary.day.isoformat()}.pdf" in pdf.headers["content-disposition"]
    assert len(pdf.content) > 20_000
    if (target := artifacts_dir()) is not None:
        (target / "comparaison_AB_demo_douala.pdf").write_bytes(pdf.content)
        keys = ("distance_estimated_m", "distance_actual_m", "trucks_used", "drivers_used", "trips_count")
        keys += ("orders_served", "service_duration_s", "fill_rate_avg_pct", "violations_blocking")
        measured = {"a": {k: a[k] for k in keys}, "b": {k: b[k] for k in keys}, "verdict": verdict}
        measured["b"]["computed_in_ms"] = plan_b["computed_in_ms"]
        (target / "preuve_ab.json").write_text(json.dumps(measured, ensure_ascii=False, indent=1))


async def test_la_journee_de_reference_cohabite_avec_les_commandes_du_jour(api, db, tasks):
    """Enchaînement des démos J2 puis J5 sur la même base : les 20 commandes confirmées du jour et les
    20 commandes de la journée de référence (créées par son import) ne se mélangent pas."""
    summary = await load(api, "demo_douala")
    day = summary.day.isoformat()
    confirmed = {o["id"] for o in await api.get_all("/orders", "dispatcher", day=day)}

    ab = await run_ab(api, db, tasks)
    reference_orders = _served(await _plan(api, ab["plan_a"]))
    assert len(reference_orders) == 20 and not reference_orders & confirmed
    assert _served(await _plan(api, ab["plan_b"])) == reference_orders

    # Le calcul ordinaire du jour ne reprend que les commandes confirmées.
    computed = await tasks.run(db, await api.start_compute(summary.day, summary.compute_params))
    plan = await _plan(api, str(computed.id))
    assert plan["kind"] == "computed" and _served(plan) == confirmed
    assert plan["unserved"] == [] and plan["blocking_count"] == 0, plan["violations"]

    # Rejeu et plan du jour sont identiques au kilomètre près : mêmes commandes, mêmes ressources.
    again = await api.comparison(ab["plan_b"], plan["id"], "manager")
    assert again["metrics_a"]["distance_estimated_m"] == again["metrics_b"]["distance_estimated_m"]

    # Réimport sans `replace` : refus ; avec `replace` : l'ancien plan est archivé.
    import load_demo

    content = load_demo.reference_day_file("demo_douala")
    with pytest.raises(load_demo.DemoError, match="409"):
        await api.import_reference_day(content, replace=False)
    replaced = await api.import_reference_day(content, replace=True)
    assert replaced["plan_id"] != ab["plan_a"]
    assert (await _plan(api, ab["plan_a"]))["status"] == "archived"
    orders = await api.get_all("/orders", "dispatcher", day=day)
    assert sum(1 for o in orders if o["id"] in confirmed and o["status"] == "confirmed") == 20
