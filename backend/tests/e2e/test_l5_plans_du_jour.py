"""Second plan du jour : il tient compte des tournées du premier plan publié (lot L5, question L5-34).

Vrai moteur, vraies règles, par l'API : `demo_douala` publié, première tournée entièrement sautée,
second calcul du jour pour ses commandes.
"""

from __future__ import annotations

from collections import Counter

from tests.e2e.conftest import compute_day, get_plan, published_day
from tests.e2e.test_non_regression import _skip_first_trip


def _span(trip: dict) -> tuple[str, str]:
    return trip["planned_start_at"], trip["planned_return_at"]


def _overlap(a: dict, b: dict) -> bool:
    return _span(a)[0] < _span(b)[1] and _span(b)[0] < _span(a)[1]


async def test_second_plan_du_jour_sans_chevauchement_ni_chargement_en_trop(api, db, tasks):
    summary, plan = await published_day(api, db, tasks)
    _, skipped = await _skip_first_trip(api, plan)
    first = await get_plan(api, plan["id"])

    second = await compute_day(api, db, tasks, summary)
    assert second["root_plan_id"] != first["root_plan_id"]
    served = {d["order_id"] for t in second["trips"] for s in t["stops"] for d in s["deliveries"]}
    unserved = {u["order_id"] for u in second["unserved"]}
    assert served | unserved == skipped and second["trips"]  # rien ne disparaît, et il reste des camions

    # RM-02 : aucun camion ni chauffeur du second plan n'est pris en même temps dans le premier.
    for trip in second["trips"]:
        for other in first["trips"]:
            if other["truck_id"] == trip["truck_id"] or (
                trip["driver_id"] and other["driver_id"] == trip["driver_id"]
            ):
                assert not _overlap(trip, other), (trip["truck_plate"], _span(trip), _span(other))
    # RM-14 : chargements du jour par camion, les deux plans confondus (maximum 2 au dépôt).
    loadings = Counter(t["truck_id"] for p in (first, second) for t in p["trips"])
    assert max(loadings[t["truck_id"]] for t in second["trips"]) <= 2
    assert second["blocking_count"] == 0, second["violations"]

    # Affectation manuelle fautive : la tournée est confiée à un camion qui a déjà fait ses deux
    # chargements du jour dans le premier plan → les règles le signalent (RM-14), publication refusée.
    full = next((truck for truck, count in loadings.items() if count >= 2), None)
    if full is not None and second["trips"][0]["truck_id"] != full:
        trip = second["trips"][0]
        edited = (
            await api.call(
                "POST",
                f"/plans/{second['id']}/trips/{trip['id']}/assign",
                "dispatcher",
                json={"truck_id": full},
            )
        ).json()
        codes = {v["rule_code"] for v in edited["violations"] if v["severity"] == "blocking"}
        assert codes & {"RM-14", "RM-02"}, edited["violations"]
        assert edited["publishable"] is False
        refused = await api.call("POST", f"/plans/{second['id']}/publish", "dispatcher", expected=(409,))
        assert refused.json()["code"] == "rule_violation"
