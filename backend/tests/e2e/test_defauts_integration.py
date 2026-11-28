"""Défauts d'intégration encore ouverts, débusqués par les scénarios de bout en bout (lot L15).

Chaque test décrit le comportement **attendu** et échoue aujourd'hui : il est marqué
`xfail(strict=True)` avec sa raison (fichier et fonction en cause). Le jour où le lot propriétaire
corrige, le test passe, `strict` le signale : retirer la marque et déplacer le test dans
`test_non_regression.py`. Le détail (entrée, attendu, constaté, piste) est dans `docs/DEMO.md` §5.
"""

from __future__ import annotations

import pytest
import run_day

from tests.e2e.conftest import published_day


@pytest.mark.xfail(
    strict=True,
    reason="L4 × L5 × L6 — une commande planifiée en partie reste « confirmed » à la publication "
    "(RM-16, question L5-6), mais app/loading/service.py::record_delivery appelle "
    "orders_service.mark_delivered pour toute commande suivie, et app/orders/service.py::"
    "ALLOWED_TRANSITIONS interdit « confirmed → delivered » : PUT /stops/{id}/delivery répond 409 "
    "`invalid_order_transition`. L'arrêt d'une commande réduite (pénurie traitée par « réduire », "
    "F6.3) ne peut donc pas être saisi comme livré.",
)
async def test_defaut_livraison_d_une_commande_planifiee_en_partie(api, db, tasks):
    summary, plan = await published_day(api, db, tasks)
    day = summary.day.isoformat()
    await api.login("supply", "supply@demo.tourneo.cm", "demo-tourneo-2027")

    # Pénurie de gasoil (5 000 L de moins que le plan), traitée par « réduire » : nouvelle version publiée.
    shortage = await run_day.declare_shortage(api, plan)
    reduced_orders = {o["order_id"] for t in shortage["impacted_trips"] for o in t["orders"]}
    resolved, plan = await run_day.resolve_shortage(api, shortage, "reduce")
    assert resolved["status"] == "resolved" and resolved["results"][-1]["published"] is True
    orders = {o["id"]: o for o in await api.get_all("/orders", "dispatcher", day=day)}
    # RM-16 : les commandes réduites ne sont planifiées qu'en partie, elles restent « confirmed ».
    assert {orders[o]["status"] for o in reduced_orders} == {"confirmed"}
    trip = next(
        t
        for t in plan["trips"]
        if any(d["order_id"] in reduced_orders for s in t["stops"] for d in s["deliveries"])
    )
    partial = [d for s in trip["stops"] for d in s["deliveries"] if d["order_id"] in reduced_orders]
    assert all(0 < d["planned_l"] < d["requested_l"] for d in partial)

    # Fleet charge la tournée, part, et saisit les livraisons aux volumes planifiés.
    await run_day.load_and_depart(api, trip)
    for stop in trip["stops"]:
        arrival = stop["planned_arrival_at"]
        body = {
            "actual_arrival_at": arrival,
            "deliveries": [
                {"order_id": d["order_id"], "actual_l": d["planned_l"]} for d in stop["deliveries"]
            ],
        }
        response = await api.call(
            "PUT", f"/stops/{stop['id']}/delivery", "fleet", json=body, expected=(200, 409)
        )
        # Attendu : la livraison partielle est enregistrée (le reliquat reste à replanifier).
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "delivered"
