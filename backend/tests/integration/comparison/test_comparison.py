"""F8.4 — tableau comparatif entre deux plans ; F8.5 — export PDF avec les deux cartes."""

import pytest

from app.admin.models import Setting
from app.comparison import report
from app.comparison import service as comparison_service
from app.core.enums import PlanKind, Severity, StopStatus, TripStatus
from app.core.pdf import _fmt_liters, render_html

from . import factory
from .factory import DEPOT, STATIONS


@pytest.fixture
async def plans(db, world):
    """Plan A : journée manuelle (2 camions, 3 commandes sur 4). Plan B : rejeu (1 camion, 4 sur 4)."""
    o1 = await factory.make_order(db, world, "ST-DLA-001", "SUPER", 12000)
    o2 = await factory.make_order(db, world, "ST-DLA-002", "GASOIL", 15000)
    o3 = await factory.make_order(db, world, "ST-DLA-003", "SUPER", 10000)
    o4 = await factory.make_order(db, world, "ST-DLA-004", "PETROLE", 5000)
    done = {"status": StopStatus.DELIVERED}
    plan_a = await factory.make_plan(
        db,
        world,
        [
            {
                "truck": "LT-123-AA",
                "driver": "Jean Mbarga",
                "distance_m": 60_000,
                "duration_s": 4 * 3600,
                "actual_distance_m": 66_000,
                "depart": "08:15",
                "return": "12:15",
                "actual_depart": "07:30",
                "actual_return": "13:10",
                "status": TripStatus.COMPLETED,
                "stops": [
                    {"station": "ST-DLA-001", "arrival": "09:00", "deliveries": [(o1, 12000, 12000)], **done},
                    {"station": "ST-DLA-003", "arrival": "10:30", "deliveries": [(o3, 10000, 10000)], **done},
                ],
            },
            {
                "truck": "LT-456-BB",
                "driver": "Paul Etoa",
                "distance_m": 40_000,
                "duration_s": 3 * 3600,
                "actual_distance_m": 43_000,
                "status": TripStatus.COMPLETED,
                "stops": [{"station": "ST-DLA-002", "deliveries": [(o2, 15000, 15000)], **done}],
            },
        ],
        kind=PlanKind.MANUAL_REFERENCE,
        unserved=[o4],
        violations=[
            ("RM-11", Severity.BLOCKING, "Durée de service dépassée.", 1),
            ("RM-08", Severity.WARNING, "Stock non renseigné.", None),
        ],
        label="Journée A du 12/01",
        prep_time_s=7200,
    )
    plan_b = await factory.make_plan(
        db,
        world,
        [
            {
                "truck": "LT-123-AA",
                "driver": "Jean Mbarga",
                "distance_m": 80_000,
                "duration_s": 6 * 3600,
                "depart": "08:15",
                "return": "14:15",
                "stops": [
                    {"station": "ST-DLA-001", "arrival": "09:00", "deliveries": [(o1, 12000, None)]},
                    {"station": "ST-DLA-003", "arrival": "10:00", "deliveries": [(o3, 10000, None)]},
                    {"station": "ST-DLA-002", "arrival": "11:00", "deliveries": [(o2, 15000, None)]},
                    {"station": "ST-DLA-004", "arrival": "12:00", "deliveries": [(o4, 3000, None)]},
                ],
            }
        ],
        kind=PlanKind.REPLAY,
        parent_plan_id=plan_a.id,
        computed_in_ms=38_400,
        engine_version="1.0.0",
    )
    await db.commit()
    return plan_a.id, plan_b.id


async def test_comparaison_metriques_ecarts_verdict(client, plans, auth_headers):
    plan_a, plan_b = plans
    response = await client.get(
        "/comparison",
        params={"plan_a": str(plan_a), "plan_b": str(plan_b)},
        headers=await auth_headers("manager"),
    )
    assert response.status_code == 200, response.text
    body = response.json()

    assert body["plan_a"]["kind"] == "manual_reference" and body["plan_a"]["title"] == "Journée A du 12/01"
    assert body["plan_b"]["kind"] == "replay" and body["plan_b"]["title"] == "Rejeu calculé v1"
    assert body["plan_b"]["parent_plan_id"] == str(plan_a)
    assert body["plan_a"]["day"] == "2027-01-12"

    assert body["metrics_a"] == {
        "distance_estimated_m": 100_000,
        "distance_actual_m": 109_000,
        "distance_actual_trips": 2,
        "trucks_used": 2,
        "drivers_used": 2,
        "trips_count": 2,
        "stations_requested": 4,
        "stations_served": 3,
        "stations_delivered": 3,
        "orders_requested": 4,
        "orders_served": 3,
        "volume_requested_l": 42000.0,
        "volume_planned_l": 37000.0,
        "volume_delivered_l": 37000.0,
        "service_duration_s": 7 * 3600,
        "service_duration_actual_s": 5 * 3600 + 40 * 60,  # 07:30 → 13:10, seule tournée aux heures connues
        "fill_rate_avg_pct": 65.0,  # (22 000 / 40 000 + 15 000 / 20 000) / 2
        "violations_blocking": 1,
        "violations_warning": 1,
        "violations_total": 2,
        "prep_time_s": 7200,
        "prep_time_source": "manual",
    }
    assert body["metrics_b"] == {
        "distance_estimated_m": 80_000,
        "distance_actual_m": None,
        "distance_actual_trips": 0,
        "trucks_used": 1,
        "drivers_used": 1,
        "trips_count": 1,
        "stations_requested": 4,
        "stations_served": 4,
        "stations_delivered": None,
        "orders_requested": 4,
        "orders_served": 4,
        "volume_requested_l": 42000.0,
        "volume_planned_l": 40000.0,
        "volume_delivered_l": None,
        "service_duration_s": 6 * 3600,
        "service_duration_actual_s": None,
        "fill_rate_avg_pct": 100.0,
        "violations_blocking": 0,
        "violations_warning": 0,
        "violations_total": 0,
        "prep_time_s": 38,
        "prep_time_source": "computed",
    }

    deltas = {d["key"]: d for d in body["deltas"]}
    assert deltas["distance_estimated_m"] == {
        "key": "distance_estimated_m",
        "label": "Kilomètres estimés",
        "unit": "m",
        "a": 100_000,
        "b": 80_000,
        "delta": -20_000,
        "delta_pct": -20.0,
        "better": "b",
    }
    assert deltas["distance_actual_m"]["delta"] is None and deltas["distance_actual_m"]["better"] is None
    assert (deltas["trucks_used"]["delta"], deltas["trucks_used"]["delta_pct"]) == (-1, -50.0)
    assert (deltas["stations_served"]["delta_pct"], deltas["stations_served"]["better"]) == (33.33, "b")
    assert deltas["violations_blocking"]["better"] == "b"
    assert deltas["prep_time_s"]["delta"] == -7162
    assert deltas["stations_requested"]["better"] is None

    assert body["verdict"] == {
        "threshold_pct": 10.0,
        "distance_a_m": 100_000,
        "distance_b_m": 80_000,
        "gain_m": 20_000,
        "gain_pct": 20.0,
        "success": True,
        "gain_vs_actual_pct": 26.61,
        "no_blocking_violation": True,
        "orders_served_ok": True,
        "message": "Objectif atteint : le plan B parcourt 20,0 % de kilomètres en moins que le plan A "
        "(seuil : 10,0 %).",
    }

    # Tracés pour les deux cartes : dépôt → arrêts ordonnés → dépôt, en lat / lon.
    assert [len(r["points"]) for r in body["routes_a"]] == [4, 3]
    (route_b,) = body["routes_b"]
    assert [p["code"] for p in route_b["points"]] == [
        "SCDP-DLA", "ST-DLA-001", "ST-DLA-003", "ST-DLA-002", "ST-DLA-004", "SCDP-DLA",
    ]  # fmt: skip
    assert [p["seq"] for p in route_b["points"]] == [None, 1, 2, 3, 4, None]
    first, second = route_b["points"][:2]
    assert (first["kind"], round(first["lat"], 4), round(first["lon"], 4)) == ("depot", DEPOT[1], DEPOT[2])
    assert (second["kind"], round(second["lat"], 4), round(second["lon"], 4)) == (
        "station",
        *STATIONS["ST-DLA-001"],
    )
    assert route_b["truck_plate"] == "LT-123-AA" and route_b["driver_name"] == "Jean Mbarga"
    assert route_b["depot_code"] == "SCDP-DLA" and route_b["fill_rate_pct"] == 100.0
    assert route_b["planned_depart_at"] == "2027-01-12T07:15:00Z"  # 08:15 à Douala (RM-20)
    assert body["routes_a"][0]["color"] != body["routes_a"][1]["color"]
    assert route_b["stops"][3]["deliveries"] == [
        {
            "order_id": route_b["stops"][3]["deliveries"][0]["order_id"],
            "product_id": route_b["stops"][3]["deliveries"][0]["product_id"],
            "product_code": "PETROLE",
            "planned_l": 3000.0,
            "actual_l": None,
        }
    ]
    (unserved,) = body["unserved_a"]
    assert (unserved["station_code"], unserved["product_code"], unserved["requested_l"]) == (
        "ST-DLA-004",
        "PETROLE",
        5000.0,
    )
    assert body["unserved_b"] == []


async def test_comparaison_seuil_lu_dans_les_parametres(client, db, plans, auth_headers):
    plan_a, plan_b = plans
    db.add(Setting(key="ab_success_threshold_pct", value=25))
    await db.commit()
    response = await client.get(
        "/comparison",
        params={"plan_a": str(plan_a), "plan_b": str(plan_b)},
        headers=await auth_headers("fleet"),
    )
    verdict = response.json()["verdict"]
    assert verdict["threshold_pct"] == 25.0 and verdict["success"] is False and verdict["gain_pct"] == 20.0
    assert verdict["message"].startswith("Objectif non atteint")

    # Deux plans quelconques : dans l'autre sens, B (manuel) est plus long que A.
    response = await client.get(
        "/comparison",
        params={"plan_a": str(plan_b), "plan_b": str(plan_a)},
        headers=await auth_headers("fleet"),
    )
    verdict = response.json()["verdict"]
    assert verdict["gain_pct"] == -25.0 and verdict["success"] is False
    assert verdict["no_blocking_violation"] is False and verdict["orders_served_ok"] is False


async def test_comparaison_erreurs(client, db, plans, auth_headers):
    plan_a, _ = plans
    headers = await auth_headers("manager")
    await db.commit()
    missing = "00000000-0000-0000-0000-000000000001"
    assert (
        await client.get("/comparison", params={"plan_a": str(plan_a), "plan_b": str(plan_a)})
    ).status_code == 401
    response = await client.get(
        "/comparison", params={"plan_a": str(plan_a), "plan_b": missing}, headers=headers
    )
    assert response.status_code == 404 and response.json()["code"] == "not_found"
    response = await client.get("/comparison", params={"plan_a": str(plan_a)}, headers=headers)
    assert response.status_code == 422
    assert (
        await client.get("/comparison.pdf", params={"plan_a": str(plan_a), "plan_b": missing})
    ).status_code == 401


async def test_export_pdf_rend_un_vrai_pdf(client, plans, auth_headers):
    plan_a, plan_b = plans
    response = await client.get(
        "/comparison.pdf",
        params={"plan_a": str(plan_a), "plan_b": str(plan_b)},
        headers=await auth_headers("manager"),
    )
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"] == 'attachment; filename="comparaison_AB_2027-01-12.pdf"'
    assert response.content.startswith(b"%PDF")
    assert len(response.content) > 10_000


async def test_gabarit_du_rapport_synthese_cartes_annexes(db, plans):
    plan_a, plan_b = plans
    comparison = await comparison_service.build_comparison(db, plan_a, plan_b)
    html = render_html(
        report.TEMPLATE, report.build_context(comparison, {"company_name": "OLA Energy Cameroun"})
    )

    assert "Rapport comparatif A / B" in html and "Journée du 12/01/2027" in html
    assert "Objectif atteint" in html and "seuil convenu : 10,0 %" in html
    assert "<td>Kilomètres estimés</td>" in html
    assert "100,0 km" in html and "80,0 km" in html and "−20,0 km" in html and "−20,0 %" in html
    assert "2 h 00" in html and "38 s" in html  # temps de préparation : saisi contre calculé
    # Deux cartes SVG dessinées côté serveur, sans ressource externe.
    assert html.count('viewBox="0 0 480 420"') == 2 and html.count("<polyline") == 3
    # Légende et annexes : un échantillon de trait par tournée, aux couleurs de l'interface.
    assert html.count('viewBox="0 0 22 8"') == 2 * 3
    assert 'stroke="#1d6fb8"' in html and 'stroke="#0f8a7a"' in html
    assert "http://" not in html.replace("http://www.w3.org/2000/svg", "") and "https://" not in html
    # Annexes par tournée et commandes non servies du plan A.
    assert "Annexe A" in html and "Annexe B" in html
    assert "Tournée 2 — camion LT-456-BB, chauffeur Paul Etoa, dépôt SCDP-DLA" in html
    assert f"PETROLE {_fmt_liters(3000)}" in html
    assert "Commandes non servies" in html and "Flotte épuisée." in html
    assert "09:00" in html  # heures affichées en Africa/Douala
