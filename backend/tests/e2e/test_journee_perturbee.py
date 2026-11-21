"""Journée perturbée de bout en bout (jalon J4, F6) sur `demo_douala` importé par les fichiers.

plan publié → pénurie de gasoil déclarée par Supply puis traitée par le dispatcher (report) → tournées du
matin → panne d'un camion après son premier arrêt (remplaçant choisi parmi ceux que l'assistant juge
éligibles, seuls les arrêts en attente transférés, tournée de remplacement chargée puis livrée) → dernier
arrêt de la journée sauté → second calcul du jour qui reprend ses commandes, dans la limite du stock
restant → second plan publié et livré → journal, tableau de bord, statuts de toutes les commandes.

Les gestes sont ceux de la démonstration scriptée (`scripts/demo/run_day.py`, options `--shortage` et
`--breakdown`) ; les vérifications sont ici. Vrai moteur, vraies règles, tout par l'API.
"""

from __future__ import annotations

from collections import Counter

import pytest
import run_day

from tests.e2e.conftest import compute_day, get_plan, published_day

SHORTAGE_L = run_day.SHORTAGE_L


async def _statuses(api, day: str) -> Counter:
    return Counter(o["status"] for o in await api.get_all("/orders", "manager", day=day))


def _orders_of(trip: dict, product_code: str | None = None) -> set[str]:
    return {
        d["order_id"]
        for s in trip["stops"]
        for d in s["deliveries"]
        if product_code is None or d["product_code"] == product_code
    }


async def test_journee_perturbee_penurie_panne_arret_saute_et_second_plan(api, db, tasks):
    summary, plan = await published_day(api, db, tasks)
    day = summary.day.isoformat()
    await api.login("supply", "supply@demo.tourneo.cm", "demo-tourneo-2027")
    first_plan_id = plan["id"]
    assert plan["version"] == 1 and await _statuses(api, day) == {"planned": 20}
    gasoil_planned = run_day.planned_volume(plan, "GASOIL")
    assert gasoil_planned == 43_000

    # ================================================================== pénurie produit (F6.3)
    # Le dispatcher ne déclare pas une pénurie : c'est le rôle de Supply.
    stock = next(
        s
        for s in await api.get_all("/availability/depot-stocks", "supply", day=day)
        if s["product_code"] == "GASOIL"
    )
    body = {
        "depot_id": stock["depot_id"],
        "product_id": stock["product_id"],
        "new_available_l": 1,
        "day": day,
    }
    await api.call("POST", "/events/product-shortage", "dispatcher", json=body, expected=(403,))

    shortage = await run_day.declare_shortage(api, plan)
    assert shortage["status"] == "open" and shortage["product_code"] == "GASOIL"
    assert shortage["previous_available_l"] == 64_000
    assert shortage["new_available_l"] == gasoil_planned - SHORTAGE_L == 38_000
    assert shortage["loaded_l"] == 0 and shortage["shortfall_l"] == SHORTAGE_L
    impacted = shortage["impacted_trips"]
    assert len(impacted) == 1  # la tournée qui part la dernière avec du gasoil
    hit = impacted[0]
    last_gasoil_trip = [t for t in run_day.by_departure(plan["trips"]) if _orders_of(t, "GASOIL")][-1]
    assert hit["trip_id"] == last_gasoil_trip["id"] and hit["status"] == "planned"
    assert hit["shortfall_l"] == SHORTAGE_L and hit["covered_l"] == hit["planned_l"] - SHORTAGE_L
    assert {"reduce", "postpone"} <= set(hit["options"])
    postponed = {o["order_id"] for o in hit["orders"]}
    assert postponed == _orders_of(last_gasoil_trip, "GASOIL")
    # Tant que rien n'est décidé : le plan publié reste la version 1, l'alerte est ouverte.
    impact = (await api.call("GET", f"/events/{shortage['event']['id']}/impact", "fleet")).json()
    assert impact["status"] == "open" and len(impact["impacted_trips"]) == 1
    stocks = await api.get_all("/availability/depot-stocks", "manager", day=day)
    assert next(s["available_l"] for s in stocks if s["product_code"] == "GASOIL") == 38_000

    resolved, plan = await run_day.resolve_shortage(api, shortage, "postpone")
    assert resolved["status"] == "resolved" and resolved["impacted_trips"] == []
    result = resolved["results"][-1]
    assert (result["plan_version"], result["plan_status"], result["published"]) == (2, "published", True)
    assert result["version_created"] is True and result["previous_plan_status"] == "archived"
    assert result["blocking_count"] == 0 and plan["id"] != first_plan_id
    assert (
        run_day.planned_volume(plan, "GASOIL")
        == 38_000 - sum(o["planned_l"] for o in hit["orders"]) + SHORTAGE_L
    )  # ce qui reste planifié tient dans le stock
    assert run_day.planned_volume(plan, "GASOIL") <= 38_000
    assert {u["order_id"] for u in plan["unserved"]} == postponed  # jamais de disparition silencieuse
    assert {u["order_status"] for u in plan["unserved"]} == {"postponed"}
    assert await _statuses(api, day) == {"planned": 18, "postponed": 2}
    impact = (await api.call("GET", f"/events/{shortage['event']['id']}/impact", "fleet")).json()
    assert impact["status"] == "resolved"
    # L'ancienne version est archivée : Fleet ne peut plus y saisir quoi que ce soit.
    stale = await api.call(
        "PUT",
        f"/trips/{last_gasoil_trip['id']}/status",
        "fleet",
        json={"status": "at_depot"},
        expected=(409,),
    )
    assert stale.json()["code"] == "plan_not_published"

    # ================================================================== matinée, puis panne (F6.1, RM-19)
    victim = run_day.breakdown_candidate(plan)
    assert victim is not None and len(victim["stops"]) >= 2
    for trip in run_day.by_departure(plan["trips"]):
        if trip["id"] == victim["id"]:
            break
        await run_day.run_trip(api, trip)
    done_before = {t["seq"] for t in (await get_plan(api, plan["id"]))["trips"] if t["status"] == "completed"}

    breakdown = await run_day.break_down(api, victim)
    assert (breakdown["plan_version"], breakdown["plan_status"], breakdown["published"]) == (
        3,
        "published",
        True,
    )
    assert breakdown["previous_plan_version"] == 2 and breakdown["previous_plan_status"] == "archived"
    assert breakdown["blocking_count"] == 0, breakdown["violations"]
    assert breakdown["other_impacted_trips"] == []
    assert len(breakdown["kept_stop_ids"]) == 1  # l'arrêt déjà livré reste sur la tournée d'origine
    assert len(breakdown["transferred_stop_ids"]) == len(victim["stops"]) - 1
    plan = breakdown["plan"]
    origin = next(t for t in plan["trips"] if t["id"] == breakdown["origin_trip_id"])
    replacement = next(t for t in plan["trips"] if t["id"] == breakdown["new_trip_id"])
    # RM-19 : seuls les arrêts `pending` sont transférés ; le livré reste, avec ses réalisations.
    assert origin["truck_id"] == victim["truck_id"] and origin["status"] == "completed"
    assert [(s["station_code"], s["status"]) for s in origin["stops"]] == [
        (victim["stops"][0]["station_code"], "delivered")
    ]
    assert all(d["actual_l"] == d["planned_l"] for d in origin["stops"][0]["deliveries"])
    assert replacement["truck_id"] != victim["truck_id"] and replacement["status"] == "planned"
    assert replacement["driver_id"] and replacement["compartments"]
    assert [s["station_code"] for s in replacement["stops"]] == [
        s["station_code"] for s in victim["stops"][1:]
    ]
    assert {s["status"] for s in replacement["stops"]} == {"pending"}
    assert _orders_of(replacement) == _orders_of(victim) - _orders_of(origin)
    assert replacement["planned_depart_at"] > breakdown["event"]["occurred_at"]  # rechargement au dépôt
    # Les tournées déjà terminées le restent ; leur chargement suit la nouvelle version (ex-défaut D2).
    assert {t["seq"] for t in plan["trips"] if t["status"] == "completed"} == done_before | {origin["seq"]}
    listed = {t["id"]: t for t in await api.get_all("/loadings", "fleet", day=day)}
    assert {t["plan_version"] for t in listed.values()} == {3}
    assert listed[origin["id"]]["loading_recorded"] is True  # chargement réel conservé
    assert listed[replacement["id"]]["loading_recorded"] is False  # à charger
    kept_loading = await api.call("GET", f"/trips/{origin['id']}/loading", "fleet")
    assert kept_loading.json()["depot_ticket_no"] == f"BC-{victim['seq']:04d}"
    # Le camion en panne n'est plus affectable pour la journée (RM-04).
    trucks = {t["truck_id"]: t for t in await api.get_all("/availability/trucks", "dispatcher", day=day)}
    assert trucks[victim["truck_id"]]["assignable"] is False
    assert trucks[victim["truck_id"]]["rule_code"] == "RM-04"
    # Commandes : livrées pour l'arrêt fait ; celles du reste de la tournée attendent le rechargement.
    orders = {o["id"]: o["status"] for o in await api.get_all("/orders", "manager", day=day)}
    assert {orders[o] for o in _orders_of(origin)} == {"delivered"}
    assert {orders[o] for o in _orders_of(replacement)} <= {"planned", "loaded"}

    # ================================================================== fin de journée, un arrêt sauté
    plan = await run_day.execute(api, plan, None, skip_last=True)
    assert {t["status"] for t in plan["trips"]} == {"completed"}
    skipped_stops = [s for t in plan["trips"] for s in t["stops"] if s["status"] == "skipped"]
    assert len(skipped_stops) == 1
    skipped = {d["order_id"] for d in skipped_stops[0]["deliveries"]}
    statuses = await _statuses(api, day)
    assert statuses == {"delivered": 18 - len(skipped), "postponed": 2, "confirmed": len(skipped)}

    # ================================================================== second calcul du jour
    second = await compute_day(api, db, tasks, summary)
    assert second["kind"] == "computed" and second["root_plan_id"] != plan["root_plan_id"]
    served = {d["order_id"] for t in second["trips"] for s in t["stops"] for d in s["deliveries"]}
    assert served == skipped  # les commandes de l'arrêt sauté, et elles seules (pas les reportées)
    assert second["unserved"] == [] and second["blocking_count"] == 0, second["violations"]
    published = (await api.call("POST", f"/plans/{second['id']}/publish", "dispatcher")).json()
    # Le premier plan reste publié : le second est une lignée distincte, pas une nouvelle version.
    plans = await api.get_all("/plans", "manager", day=day)
    assert Counter((p["status"], p["version"]) for p in plans) == {
        ("published", 3): 1,
        ("published", 1): 1,
        ("archived", 1): 1,
        ("archived", 2): 1,
    }
    # Stock dépôt : ce que les deux plans publiés font sortir du dépôt tient dans le stock saisi
    # (arrêt sauté compris : le produit a quitté le dépôt — question L5-33).
    stocks = {
        s["product_code"]: s["available_l"]
        for s in await api.get_all("/availability/depot-stocks", "manager", day=day)
    }
    for product, available in stocks.items():
        out = sum(
            d["planned_l"]
            for p in (plan, published)
            for t in p["trips"]
            for s in t["stops"]
            for d in s["deliveries"]
            if d["product_code"] == product
        )
        assert out <= available, f"{product} : {out} L planifiés pour {available} L en stock"
    await run_day.execute(api, published, None, skip_last=False)
    assert await _statuses(api, day) == {"delivered": 18, "postponed": 2}

    # ================================================================== journal de la journée (F6.4)
    events = await api.get_all("/events", "manager", day=day)
    types = Counter(e["type"] for e in events)
    assert types["truck_breakdown"] == 1 and types["product_shortage"] == 1
    assert types["publish"] == 4  # v1, v2 (pénurie), v3 (panne), second plan
    trips_run = len(plan["trips"]) + len(published["trips"])
    assert types["loading_recorded"] == trips_run
    assert types["delivery_recorded"] == sum(len(t["stops"]) for p in (plan, published) for t in p["trips"])
    assert [e["occurred_at"] for e in events] == sorted((e["occurred_at"] for e in events), reverse=True)
    assert all(e["summary"] and e["type_label"] for e in events)
    panne = next(e for e in events if e["type"] == "truck_breakdown")
    assert panne["plan_version"] == 3 and victim["truck_plate"] in panne["summary"]
    assert panne["actor_name"] == "Dispatcher Démo"
    penurie = next(e for e in events if e["type"] == "product_shortage")
    assert penurie["actor_name"] == "Supply Démo" and penurie["payload"]["status"] == "resolved"
    decision = next(e for e in events if e["action"] == "shortage_resolution")
    assert decision["type"] == "manual_edit" and decision["plan_version"] == 2
    only = await api.get_all("/events", "fleet", day=day, type="truck_breakdown")
    assert [e["id"] for e in only] == [panne["id"]]
    one = (await api.call("GET", f"/events/{panne['id']}", "fleet")).json()
    assert one["summary"] == panne["summary"]

    # ================================================================== tableau de bord (F8.6)
    board = (await api.call("GET", "/dashboard", "manager", params={"day": day})).json()
    assert board["plan"]["id"] == plan["id"] and board["plan"]["version"] == 3
    totals = board["summary"]
    assert totals["trips_by_status"]["completed"] == totals["trips_total"] == len(plan["trips"])
    assert (totals["stops_skipped"], totals["stops_pending"]) == (1, 0)
    assert totals["stops_delivered"] == sum(len(t["stops"]) for t in plan["trips"]) - 1
    planned_l = sum(t["planned_l"] for t in plan["trips"])
    assert totals["volume_planned_l"] == pytest.approx(planned_l)
    assert totals["volume_delivered_l"] == pytest.approx(planned_l - skipped_stops[0]["planned_l"])
    assert totals["alerts_blocking"] == 0
    codes = {a["code"] for a in board["alerts"]}
    assert "truck_breakdown" in codes
