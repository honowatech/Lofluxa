"""F8.6 — une nouvelle version restée en brouillon après un événement est signalée au tableau de bord.

Jeu de données et plan publié : ceux des tests des événements (lot L10), contre la vraie API."""

from app.planning import service as planning_service
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


async def test_panne_laissant_un_brouillon_bloque(client, auth_headers, world, published, spare):  # noqa: F811
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


async def test_brouillon_publie_plus_de_version_en_attente(client, db, auth_headers, world, published, spare):  # noqa: F811
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
