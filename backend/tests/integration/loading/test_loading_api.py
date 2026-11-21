"""F7.1, F7.2 — enregistrement et lecture du chargement, RM-12 et RM-13 de bout en bout."""

import uuid
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.admin.models import Setting
from app.audit.models import AuditLog
from app.core.enums import EventType, PlanStatus, Severity, TripStatus
from app.events.models import Event
from app.loading.models import Loading, LoadingLine
from app.planning.models import ConstraintViolation
from tests.integration.loading.factory import at, iso, make_trip_scenario


async def _violations(db, trip_id):
    rows = await db.execute(select(ConstraintViolation).where(ConstraintViolation.trip_id == trip_id))
    return rows.scalars().all()


async def test_enregistrer_un_chargement_conforme(client, db, auth_headers, scenario):
    headers = await auth_headers("fleet")
    c1, _, c3 = scenario.compartments
    payload = scenario.loading_payload()
    payload["lines"][0] = scenario.line(c1, "SUPER", 10120, 25, density=0.7391)

    response = await client.post(f"/trips/{scenario.trip.id}/loading", json=payload, headers=headers)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["trip_id"] == str(scenario.trip.id)
    assert body["depot_id"] == str(scenario.depot.id)
    assert body["depot_code"] == "SCDP-DLA"
    assert body["depot_ticket_no"] == "BL-2027-0042"
    assert body["arrived_at"] == "2027-01-12T05:00:00Z"
    assert body["finished_at"] == "2027-01-12T07:15:00Z"
    assert body["entered_by_name"] == "Test fleet"
    assert [line["compartment_position"] for line in body["lines"]] == [1, 2, 3]
    first = body["lines"][0]
    # RM-12 : 10 120 × (1 − 0,00120 × 10) = 9 998,56
    assert first["volume_15_l"] == 9998.56
    assert first["observed_l"] == 10120
    assert first["observed_temp_c"] == 25
    assert first["observed_density"] == 0.7391
    assert first["product_code"] == "SUPER"
    assert first["planned_l"] == 10000
    assert first["gap_l"] == -1.44
    assert first["gap_pct"] == -0.01
    assert first["out_of_tolerance"] is False
    assert body["lines"][2]["observed_density"] == 0.8451
    assert body["observed_total_l"] == 25120
    assert body["volume_15_total_l"] == 24998.56
    assert body["planned_total_l"] == 25000
    assert body["tolerance_pct"] == 2
    assert body["out_of_tolerance"] is False
    assert body["warning_message"] is None
    assert "tables ASTM non appliquées dans le prototype" in body["conversion_note"]

    loading = (await db.execute(select(Loading).where(Loading.trip_id == scenario.trip.id))).scalar_one()
    assert loading.entered_by is not None
    assert {line.volume_15_l for line in loading.lines} == {
        Decimal("9998.56"),
        Decimal("10000.00"),
        Decimal("5000.00"),
    }
    assert await _violations(db, scenario.trip.id) == []
    # L'enregistrement ne change pas le statut de la tournée (passage explicite par PUT /status).
    assert scenario.trip.status == TripStatus.PLANNED

    events = (await db.execute(select(Event).where(Event.trip_id == scenario.trip.id))).scalars().all()
    assert [e.type for e in events] == [EventType.LOADING_RECORDED]
    assert events[0].day == scenario.plan.day
    assert events[0].plan_id == scenario.plan.id
    assert events[0].actor_id == loading.entered_by
    assert events[0].payload["updated"] is False
    assert events[0].payload["volume_15_total_l"] == 24998.56

    audits = (await db.execute(select(AuditLog).where(AuditLog.table_name == "loadings"))).scalars().all()
    assert [a.action for a in audits] == ["insert"]
    assert audits[0].actor_id == loading.entered_by


async def test_RM_12_coefficient_lu_dans_le_referentiel_produit(client, db, auth_headers, scenario):
    scenario.products["SUPER"].thermal_coeff = Decimal("0.002000")
    await db.flush()
    payload = scenario.loading_payload()
    payload["lines"][0] = scenario.line(scenario.compartments[0], "SUPER", 10000, 25)

    response = await client.post(
        f"/trips/{scenario.trip.id}/loading", json=payload, headers=await auth_headers("fleet")
    )

    # 10 000 × (1 − 0,002 × 10) = 9 800 (et non 9 880 avec le coefficient par défaut)
    assert response.json()["lines"][0]["volume_15_l"] == 9800


async def test_RM_12_la_densite_observee_n_entre_pas_dans_le_calcul(client, auth_headers, scenario):
    headers = await auth_headers("fleet")
    results = []
    for density in (None, 0.7000, 0.9000):
        payload = scenario.loading_payload()
        payload["lines"][0] = scenario.line(scenario.compartments[0], "SUPER", 10000, 30, density=density)
        body = (await client.post(f"/trips/{scenario.trip.id}/loading", json=payload, headers=headers)).json()
        assert body["lines"][0]["observed_density"] == density
        results.append(body["lines"][0]["volume_15_l"])
    assert results == [9820, 9820, 9820]


async def test_RM_13_ecart_hors_tolerance_cree_un_avertissement_sur_la_tournee(
    client, db, auth_headers, scenario
):
    payload = scenario.loading_payload()
    # Compartiment 1 : 9 700 L à 15 °C pour 10 000 planifiés → −3 % (> 2 %).
    payload["lines"][0] = scenario.line(scenario.compartments[0], "SUPER", 9700, 15)

    response = await client.post(
        f"/trips/{scenario.trip.id}/loading", json=payload, headers=await auth_headers("fleet")
    )

    body = response.json()
    assert body["out_of_tolerance"] is True
    assert body["lines"][0]["out_of_tolerance"] is True
    assert body["lines"][0]["gap_pct"] == -3
    assert body["lines"][1]["out_of_tolerance"] is False
    assert body["gap_pct"] == -1.2  # le total, lui, reste dans la tolérance
    assert "compartiment 1" in body["warning_message"]

    violations = await _violations(db, scenario.trip.id)
    assert len(violations) == 1
    assert violations[0].rule_code == "RM-13"
    assert violations[0].severity == Severity.WARNING
    assert violations[0].plan_id == scenario.plan.id
    assert violations[0].stop_id is None
    assert violations[0].message == body["warning_message"]


async def test_RM_13_a_la_tolerance_exacte_pas_d_avertissement(client, db, auth_headers, scenario):
    payload = scenario.loading_payload()
    payload["lines"][0] = scenario.line(scenario.compartments[0], "SUPER", 9800, 15)  # −2 % pile

    body = (
        await client.post(
            f"/trips/{scenario.trip.id}/loading", json=payload, headers=await auth_headers("fleet")
        )
    ).json()

    assert body["lines"][0]["gap_pct"] == -2
    assert body["out_of_tolerance"] is False
    assert await _violations(db, scenario.trip.id) == []


async def test_RM_13_tolerance_lue_dans_les_parametres(client, db, auth_headers, scenario):
    db.add(Setting(key="loading_tolerance_pct", value=5.0))
    await db.flush()
    payload = scenario.loading_payload()
    payload["lines"][0] = scenario.line(scenario.compartments[0], "SUPER", 9700, 15)  # −3 % < 5 %

    body = (
        await client.post(
            f"/trips/{scenario.trip.id}/loading", json=payload, headers=await auth_headers("fleet")
        )
    ).json()

    assert body["tolerance_pct"] == 5
    assert body["out_of_tolerance"] is False
    assert await _violations(db, scenario.trip.id) == []


async def test_RM_13_compartiment_planifie_non_charge_ecart_au_total(client, db, auth_headers, scenario):
    payload = scenario.loading_payload()
    payload["lines"] = payload["lines"][:2]  # le compartiment 3 (gasoil 5 000 L) n'est pas chargé

    body = (
        await client.post(
            f"/trips/{scenario.trip.id}/loading", json=payload, headers=await auth_headers("fleet")
        )
    ).json()

    assert body["out_of_tolerance"] is True
    assert body["gap_l"] == -5000
    assert body["gap_pct"] == -20
    assert "compartiment 3" in body["warning_message"]
    assert "total de la tournée" in body["warning_message"]
    assert len(await _violations(db, scenario.trip.id)) == 1


async def test_reenregistrement_met_a_jour_le_chargement_unique(client, db, auth_headers, scenario):
    headers = await auth_headers("fleet")
    url = f"/trips/{scenario.trip.id}/loading"
    bad = scenario.loading_payload()
    bad["lines"][0] = scenario.line(scenario.compartments[0], "SUPER", 9000, 15)
    first = (await client.post(url, json=bad, headers=headers)).json()
    assert len(await _violations(db, scenario.trip.id)) == 1

    second = await client.post(
        url,
        json=scenario.loading_payload(depot_ticket_no="BL-CORRIGE"),
        headers=await auth_headers("dispatcher"),
    )

    assert second.status_code == 200
    body = second.json()
    assert body["id"] == first["id"]
    assert body["depot_ticket_no"] == "BL-CORRIGE"
    assert body["entered_by_name"] == "Test dispatcher"
    assert body["out_of_tolerance"] is False
    assert len((await db.execute(select(Loading))).scalars().all()) == 1
    assert len((await db.execute(select(LoadingLine))).scalars().all()) == 3
    # L'avertissement RM-13 disparaît avec la correction.
    assert await _violations(db, scenario.trip.id) == []
    events = (await db.execute(select(Event).order_by(Event.occurred_at))).scalars().all()
    assert [e.payload["updated"] for e in events] == [False, True]
    audits = (await db.execute(select(AuditLog).where(AuditLog.table_name == "loadings"))).scalars().all()
    assert sorted(a.action for a in audits) == ["insert", "update"]


async def test_compartiment_d_un_autre_camion_refuse(client, db, auth_headers, scenario, products):
    other = await make_trip_scenario(db, products, suffix="-B")
    payload = scenario.loading_payload()
    payload["lines"][0] = scenario.line(other.compartments[0], "SUPER", 10000, 15)

    response = await client.post(
        f"/trips/{scenario.trip.id}/loading", json=payload, headers=await auth_headers("fleet")
    )

    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "invalid_loading"
    assert body["details"][0]["field"] == "lines.0"
    assert "n'appartient pas au camion" in body["details"][0]["message"]
    assert (await db.execute(select(Loading))).scalars().all() == []


async def test_produit_inattendu_refuse(client, auth_headers, scenario):
    payload = scenario.loading_payload()
    payload["lines"][2] = scenario.line(scenario.compartments[2], "PETROLE", 5000, 15)

    response = await client.post(
        f"/trips/{scenario.trip.id}/loading", json=payload, headers=await auth_headers("fleet")
    )

    assert response.status_code == 422
    detail = response.json()["details"][0]
    assert detail["field"] == "lines.2"
    assert "Produit inattendu dans le compartiment 3" in detail["message"]
    assert "Gasoil" in detail["message"]


async def test_compartiment_en_double_refuse(client, auth_headers, scenario):
    payload = scenario.loading_payload()
    payload["lines"][1] = payload["lines"][0]
    response = await client.post(
        f"/trips/{scenario.trip.id}/loading", json=payload, headers=await auth_headers("fleet")
    )
    assert response.status_code == 422
    assert "deux fois" in response.json()["details"][0]["message"]


async def test_compartiment_non_prevu_au_plan_de_chargement_refuse(client, db, auth_headers, scenario):
    # Compartiment du camion, mais sans volume prévu au plan de chargement.
    for load in list(scenario.trip.compartment_loads):
        if load.compartment_id == scenario.compartments[2].id:
            scenario.trip.compartment_loads.remove(load)
    await db.flush()
    response = await client.post(
        f"/trips/{scenario.trip.id}/loading",
        json=scenario.loading_payload(),
        headers=await auth_headers("fleet"),
    )
    assert response.status_code == 422
    detail = response.json()["details"][0]
    assert detail["field"] == "lines.2"
    assert "n'est pas prévu au plan de chargement" in detail["message"]


@pytest.mark.parametrize(
    "times",
    [
        {"arrived_at": iso(at(7)), "started_at": iso(at(6))},
        {"started_at": iso(at(7)), "finished_at": iso(at(6, 59))},
        {"arrived_at": iso(at(8)), "started_at": None, "finished_at": iso(at(7))},
    ],
)
async def test_heures_non_ordonnees_refusees(client, auth_headers, scenario, times):
    response = await client.post(
        f"/trips/{scenario.trip.id}/loading",
        json=scenario.loading_payload(**times),
        headers=await auth_headers("fleet"),
    )
    assert response.status_code == 422
    assert response.json()["code"] == "invalid_times"


async def test_heures_facultatives_et_fuseau_converti_en_utc(client, auth_headers, scenario):
    payload = scenario.loading_payload(
        arrived_at="2027-01-12T06:00:00+01:00", started_at=None, finished_at=None
    )
    body = (
        await client.post(
            f"/trips/{scenario.trip.id}/loading", json=payload, headers=await auth_headers("fleet")
        )
    ).json()
    assert body["arrived_at"] == "2027-01-12T05:00:00Z"  # RM-20 : restitué en UTC
    assert body["started_at"] is None


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p["lines"][0].update(observed_l=0),
        lambda p: p["lines"][0].update(observed_l=-5),
        lambda p: p["lines"][0].update(observed_temp_c=None),
        lambda p: p.update(lines=[]),
        lambda p: p.update(arrived_at="2027-01-12T05:00:00"),  # sans fuseau
    ],
)
async def test_saisie_invalide_refusee(client, auth_headers, scenario, mutate):
    payload = scenario.loading_payload()
    mutate(payload)
    response = await client.post(
        f"/trips/{scenario.trip.id}/loading", json=payload, headers=await auth_headers("fleet")
    )
    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


@pytest.mark.parametrize(("role", "status"), [("fleet", 200), ("dispatcher", 200), ("admin", 200)])
async def test_roles_autorises_en_ecriture(client, auth_headers, scenario, role, status):
    response = await client.post(
        f"/trips/{scenario.trip.id}/loading",
        json=scenario.loading_payload(),
        headers=await auth_headers(role),
    )
    assert response.status_code == status


@pytest.mark.parametrize("role", ["supply", "manager"])
async def test_roles_refuses_en_ecriture_mais_lecture_ouverte(client, db, auth_headers, scenario, role):
    url = f"/trips/{scenario.trip.id}/loading"
    reader, writer = await auth_headers(role), await auth_headers("fleet")
    payload = scenario.loading_payload()
    await db.commit()
    assert (await client.post(url, json=payload, headers=reader)).status_code == 403
    assert (await client.post(url, json=payload, headers=writer)).status_code == 200
    assert (await client.get(url, headers=reader)).status_code == 200


async def test_authentification_requise(client, scenario):
    url = f"/trips/{scenario.trip.id}/loading"
    assert (await client.post(url, json=scenario.loading_payload())).status_code == 401
    assert (await client.get(url)).status_code == 401
    assert (await client.get("/loadings")).status_code == 401


@pytest.mark.parametrize("plan_status", [PlanStatus.DRAFT, PlanStatus.ARCHIVED])
async def test_plan_non_publie_refuse(client, db, auth_headers, products, plan_status):
    draft = await make_trip_scenario(db, products, plan_status=plan_status)
    response = await client.post(
        f"/trips/{draft.trip.id}/loading", json=draft.loading_payload(), headers=await auth_headers("fleet")
    )
    assert response.status_code == 409
    assert response.json()["code"] == "plan_not_published"


@pytest.mark.parametrize("trip_status", [TripStatus.IN_PROGRESS, TripStatus.COMPLETED])
async def test_chargement_fige_apres_le_depart(client, db, auth_headers, products, trip_status):
    gone = await make_trip_scenario(db, products, trip_status=trip_status)
    response = await client.post(
        f"/trips/{gone.trip.id}/loading", json=gone.loading_payload(), headers=await auth_headers("fleet")
    )
    assert response.status_code == 409
    assert response.json()["code"] == "loading_locked"


async def test_relire_le_chargement(client, db, auth_headers, scenario):
    headers, writer = await auth_headers("manager"), await auth_headers("fleet")
    url, payload = f"/trips/{scenario.trip.id}/loading", scenario.loading_payload()
    await db.commit()
    missing = await client.get(url, headers=headers)
    assert missing.status_code == 404
    assert missing.json()["code"] == "loading_not_found"

    posted = (await client.post(url, json=payload, headers=writer)).json()
    read = await client.get(url, headers=headers)
    assert read.status_code == 200
    assert read.json() == posted


async def test_tournee_inconnue(client, db, auth_headers, scenario):
    headers, payload = await auth_headers("fleet"), scenario.loading_payload()
    await db.commit()
    unknown = uuid.uuid4()
    assert (await client.get(f"/trips/{unknown}/loading", headers=headers)).status_code == 404
    response = await client.post(f"/trips/{unknown}/loading", json=payload, headers=headers)
    assert response.status_code == 404
    assert response.json()["code"] == "not_found"
