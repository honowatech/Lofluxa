"""F8.6 — une nouvelle version restée en brouillon après un événement est signalée au tableau de bord.

Jeu de données et plan publié : ceux des tests des événements (lot L10), contre la vraie API."""

# ruff: noqa: F811 — les fixtures importées du lot des événements sont reprises en paramètres

from app.planning import service as planning_service
from app.planning.models import Plan
from tests.integration.events.conftest import (  # noqa: F401
    DAY,
    at,
    auth_headers,
    dispatcher,
    fakes,
    iso,
    plan,
    published,
    spare,
    world,
)


async def _dashboard(client, headers) -> dict:
    response = await client.get("/dashboard", params={"day": DAY.isoformat()}, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


async def test_panne_laissant_un_brouillon_bloque(client, auth_headers, world, published, spare):
    headers = await auth_headers("dispatcher")
    before = await _dashboard(client, headers)
    assert before["pending_draft"] is None
    assert [a for a in before["alerts"] if a["source"] == "plan"] == []

    # Panne tardive : stations fermées à l'arrivée (RM-10 bloquant), la version 2 reste en brouillon.
    trip = next(t for t in published.trips if t.seq == 1)
    response = await client.post(
        "/events/truck-breakdown",
        json={
            "trip_id": str(trip.id),
            "replacement_truck_id": str(spare.truck.id),
            "occurred_at": iso(at(15, 30)),
        },
        headers=headers,
    )
    assert response.status_code == 200, response.text
    event = response.json()
    assert event["published"] is False and event["blocking_count"] > 0

    body = await _dashboard(client, await auth_headers("manager"))
    # Le terrain suit toujours la version publiée…
    assert body["plan"]["id"] == str(published.id) and body["plan"]["version"] == 1
    # … et la version en attente est annoncée.
    pending = body["pending_draft"]
    assert pending["plan_id"] == event["plan_id"] and pending["version"] == 2
    assert (pending["published_plan_id"], pending["published_version"]) == (str(published.id), 1)
    assert body["pending_drafts"] == [pending] and [p["id"] for p in body["plans"]] == [str(published.id)]
    assert pending["blocking_count"] == event["blocking_count"]
    assert pending["warning_count"] == event["warning_count"]
    assert pending["created_by_name"] == "Test dispatcher"
    assert pending["created_at"].endswith("Z")
    assert pending["reason"] == event["event"]["summary"] and pending["reason"].startswith("Panne du camion")
    count = pending["blocking_count"]
    noun = "violation bloquante" if count == 1 else "violations bloquantes"
    assert pending["message"] == f"Version 2 en attente de publication : {count} {noun} à corriger."

    first = body["alerts"][0]
    assert (first["source"], first["severity"], first["code"]) == ("plan", "blocking", "pending_draft")
    assert first["message"] == pending["message"]
    assert first["payload"] == {"plan_id": pending["plan_id"], "version": 2}
    assert first["occurred_at"] == pending["created_at"]
    assert body["summary"]["alerts_total"] == len(body["alerts"])
    assert body["summary"]["alerts_blocking"] == before["summary"]["alerts_blocking"] + 1
    # L'événement de panne reste listé parmi les alertes.
    assert "truck_breakdown" in [a["code"] for a in body["alerts"]]


async def test_brouillon_publie_plus_de_version_en_attente(client, db, auth_headers, world, published, spare):
    headers = await auth_headers("dispatcher")
    draft = await planning_service.new_version(db, published.id, reason="Ajustement demandé par le dépôt")
    await db.commit()

    body = await _dashboard(client, headers)
    pending = body["pending_draft"]
    assert pending["plan_id"] == str(draft.id) and pending["version"] == 2 and pending["blocking_count"] == 0
    assert pending["reason"] == (
        "Version 2 créée depuis la version 1 publiée : Ajustement demandé par le dépôt"
    )
    assert pending["message"].startswith("Version 2 en attente de publication : aucune violation")
    assert (body["alerts"][0]["source"], body["alerts"][0]["severity"]) == ("plan", "warning")
    assert body["plan"]["version"] == 1

    response = await client.post(f"/plans/{draft.id}/publish", headers=headers)
    assert response.status_code == 200, response.text

    body = await _dashboard(client, headers)
    assert body["pending_draft"] is None
    assert [a for a in body["alerts"] if a["source"] == "plan"] == []
    assert body["plan"]["id"] == str(draft.id) and body["plan"]["version"] == 2


async def test_chauffeur_indisponible_laissant_un_brouillon_bloque(
    client,
    db,
    auth_headers,
    world,
    published,
    spare,
):
    """La durée max de service du plan devient plus courte que la tournée 1 (RM-11) : le remplacement
    du chauffeur est enregistré, mais la version 2 reste en brouillon."""
    row = await db.get(Plan, published.id)
    row.params_snapshot = {**row.params_snapshot, "max_service_hours": 2.0}
    await db.commit()
    headers = await auth_headers("dispatcher")
    trip = next(t for t in published.trips if t.seq == 1)
    response = await client.post(
        "/events/driver-unavailable",
        json={"trip_id": str(trip.id), "replacement_driver_id": str(world.drivers["Che"].id)},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    event = response.json()
    assert event["published"] is False and event["blocking_count"] > 0

    body = await _dashboard(client, headers)
    pending = body["pending_draft"]
    assert (pending["plan_id"], pending["version"]) == (event["plan_id"], 2)
    assert pending["published_plan_id"] == str(published.id)
    assert pending["blocking_count"] == event["blocking_count"]
    assert pending["reason"] == event["event"]["summary"] and "indisponible" in pending["reason"]
    first = body["alerts"][0]
    assert (first["source"], first["severity"], first["code"]) == ("plan", "blocking", "pending_draft")
    assert first["plan_id"] == event["plan_id"]
    assert "driver_unavailable" in [a["code"] for a in body["alerts"]]
    assert body["plan"]["version"] == 1


async def test_penurie_laissant_un_brouillon_bloque(client, auth_headers, world, published, spare):
    """Pénurie de super traitée en partie : une tournée est reportée, l'autre manque encore de produit
    (RM-08 bloquant) ; la version 2 reste en brouillon, puis est publiée une fois tout traité."""
    declared = await client.post(
        "/events/product-shortage",
        json={
            "depot_id": str(world.depot.id),
            "product_id": str(world.products["SUPER"].id),
            "new_available_l": 12000,
            "day": DAY.isoformat(),
        },
        headers=await auth_headers("supply"),
    )
    assert declared.status_code == 200, declared.text
    shortage = declared.json()
    by_seq = {t["trip_seq"]: t for t in shortage["impacted_trips"]}
    headers = await auth_headers("dispatcher")
    url = f"/events/{shortage['event']['id']}/resolve"

    # Déclarée mais pas encore traitée : aucune version en attente.
    assert (await _dashboard(client, headers))["pending_draft"] is None

    response = await client.post(
        url, json={"resolutions": [{"trip_id": by_seq[2]["trip_id"], "action": "postpone"}]}, headers=headers
    )
    assert response.status_code == 200, response.text
    result = response.json()["results"][0]
    assert result["published"] is False and result["plan_status"] == "draft"

    body = await _dashboard(client, await auth_headers("supply"))
    pending = body["pending_draft"]
    assert (pending["plan_id"], pending["version"]) == (result["plan_id"], 2)
    assert pending["blocking_count"] == result["blocking_count"] > 0
    assert pending["reason"] and "Pénurie" in pending["reason"]
    assert pending["message"].startswith("Version 2 en attente de publication : ")
    assert (body["alerts"][0]["source"], body["alerts"][0]["severity"]) == ("plan", "blocking")
    assert "product_shortage" in [a["code"] for a in body["alerts"]]  # pénurie encore ouverte
    assert body["plan"]["version"] == 1

    # Seconde décision : la tournée restante est réduite, la version 2 est publiée.
    response = await client.post(
        url,
        json={"resolutions": [{"trip_id": by_seq[1]["trip_id"], "action": "reduce"}], "publish": True},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["results"][0]["published"] is True
    body = await _dashboard(client, headers)
    assert body["pending_draft"] is None and body["pending_drafts"] == []
    assert body["plan"]["version"] == 2
