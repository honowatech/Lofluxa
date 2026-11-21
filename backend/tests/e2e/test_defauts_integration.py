"""Défauts d'intégration débusqués par les scénarios de bout en bout (lot L15).

Chaque test décrit le comportement **attendu** et échoue aujourd'hui : il est marqué
`xfail(strict=True)` avec sa raison (fichier et fonction en cause). Le jour où le lot propriétaire
corrige, le test passe, `strict` le signale, et il suffit de retirer la marque. Le détail (entrée,
attendu, constaté, piste de correction) est dans `docs/DEMO.md`, section « Défauts d'intégration ».
"""

from __future__ import annotations

from collections import Counter

import pytest

from app.planning.fixtures import load_problem
from tests.e2e.conftest import compute_day, get_plan, load, loading_payload, published_day


def _by_departure(plan: dict) -> list[dict]:
    return sorted(plan["trips"], key=lambda t: t["planned_depart_at"])


async def _status(api, trip_id: str, status: str) -> dict:
    return (await api.call("PUT", f"/trips/{trip_id}/status", "fleet", json={"status": status})).json()


async def _load_trip(api, trip: dict) -> None:
    """Arrivée au dépôt, chargement enregistré, tournée « chargée »."""
    await _status(api, trip["id"], "at_depot")
    await api.call("POST", f"/trips/{trip['id']}/loading", "fleet", json=loading_payload(trip))
    await _status(api, trip["id"], "loaded")


async def _edit_published(api, plan: dict, skip_trip_id: str) -> dict:
    """Édition manuelle d'un plan publié (inversion de deux arrêts d'une autre tournée) → version 2."""
    trip = next(t for t in _by_departure(plan) if t["id"] != skip_trip_id and len(t["stops"]) > 1)
    edited = (
        await api.call(
            "POST",
            f"/plans/{plan['id']}/trips/{trip['id']}/reorder",
            "dispatcher",
            json={"stop_ids": [s["id"] for s in reversed(trip["stops"])]},
        )
    ).json()
    assert edited["version"] == 2 and edited["status"] == "draft" and edited["id"] != plan["id"]
    return edited


async def _skip_first_trip(api, plan: dict) -> tuple[dict, set[str]]:
    """Exécute la première tournée du plan publié en sautant tous ses arrêts (stations fermées).
    Renvoie la tournée et les commandes concernées, revenues à « confirmed » (à replanifier)."""
    trip = _by_departure(plan)[0]
    await _load_trip(api, trip)
    await _status(api, trip["id"], "in_progress")
    for stop in trip["stops"]:
        done = (
            await api.call(
                "PUT", f"/stops/{stop['id']}/delivery", "fleet", json={"skip_reason": "Station fermée"}
            )
        ).json()
        assert {d["order_status"] for d in done["deliveries"]} == {"confirmed"}
    await _status(api, trip["id"], "completed")
    return trip, {d["order_id"] for s in trip["stops"] for d in s["deliveries"]}


# --------------------------------------------------------------------------- jeux de données (lot L2)


def test_defaut_demo_scale_a_70_stations_distinctes():
    problem = load_problem("demo_scale")
    duplicates = {k: n for k, n in Counter(s.id for s in problem.stations).items() if n > 1}
    assert duplicates == {}
    assert len({s.code for s in problem.stations}) == 70


# --------------------------------------------------------------------------- versions × chargement (L5 × L6)


async def test_defaut_nouvelle_version_d_un_plan_publie_conserve_le_chargement_enregistre(api, db, tasks):
    summary, plan = await published_day(api, db, tasks)
    loaded = _by_departure(plan)[0]
    await _load_trip(api, loaded)

    # Le dispatcher corrige une AUTRE tournée du plan publié → version 2 (RM-18), qu'il publie.
    draft = await _edit_published(api, plan, loaded["id"])
    current = (await api.call("POST", f"/plans/{draft['id']}/publish", "dispatcher")).json()
    same_trip = next(t for t in current["trips"] if t["seq"] == loaded["seq"])
    assert same_trip["status"] == "loaded" and same_trip["id"] != loaded["id"]

    # Attendu : le chargement suit la tournée dans la version en vigueur.
    loading = await api.call("GET", f"/trips/{same_trip['id']}/loading", "fleet", expected=(200, 404))
    assert loading.status_code == 200, loading.text
    sheet = await api.call("GET", f"/trips/{same_trip['id']}/loading-sheet.pdf", "fleet", expected=(200, 409))
    assert sheet.status_code == 200, sheet.text
    listed = await api.get_all("/loadings", "fleet", day=summary.day.isoformat())
    assert next(t for t in listed if t["id"] == same_trip["id"])["loading_recorded"] is True


@pytest.mark.xfail(
    strict=True,
    reason="L5 × L6 — app/planning/versions.py::create_version fige l'état d'exécution au moment de la "
    "copie, alors que la version publiée reste modifiable par Fleet (PUT /trips/{id}/status, "
    "PUT /stops/{id}/delivery) tant que le brouillon n'est pas publié : à la publication du brouillon "
    "(service.publish_plan), l'avancement saisi entre-temps est perdu (tournée revenue à « loaded »).",
)
async def test_defaut_la_publication_d_une_version_ne_perd_pas_l_avancement_saisi_entre_temps(api, db, tasks):
    _, plan = await published_day(api, db, tasks)
    started = _by_departure(plan)[0]
    await _load_trip(api, started)

    draft = await _edit_published(api, plan, started["id"])  # version 2 en préparation
    # Pendant ce temps, le camion quitte le dépôt : Fleet le saisit sur le plan en vigueur (version 1).
    running = await _status(api, started["id"], "in_progress")
    assert running["status"] == "in_progress"

    current = (await api.call("POST", f"/plans/{draft['id']}/publish", "dispatcher")).json()
    same_trip = next(t for t in current["trips"] if t["seq"] == started["seq"])
    assert same_trip["status"] == "in_progress" and same_trip["actual_depart_at"]


# --------------------------------------------------------------------------- arrêt sauté (L5 × L6)


@pytest.mark.xfail(
    strict=True,
    reason="L5 × L6 — app/planning/mapping.py::planned_elsewhere additionne les `stop_deliveries.planned_l` "
    "des plans publiés sans écarter les arrêts `skipped` : le reliquat (service._remainders) d'une "
    "commande remise à « confirmed » par un arrêt sauté vaut 0. POST /plans/compute est accepté (202) "
    "puis la tâche échoue : « Aucune commande confirmée à planifier ».",
)
async def test_defaut_commande_d_un_arret_saute_replanifiable_par_un_nouveau_calcul(api, db, tasks):
    summary, plan = await published_day(api, db, tasks)
    _, skipped = await _skip_first_trip(api, plan)
    orders = await api.get_all("/orders", "dispatcher", day=summary.day.isoformat())
    assert Counter(o["status"] for o in orders)["confirmed"] == len(skipped)

    # Attendu : les commandes « à replanifier » se replanifient.
    second = await compute_day(api, db, tasks, summary)
    served = {d["order_id"] for t in second["trips"] for s in t["stops"] for d in s["deliveries"]}
    assert served == skipped


@pytest.mark.xfail(
    strict=True,
    reason="L5 × L6 — app/planning/service.py::run_recompute fige la tournée terminée avec son arrêt "
    "`skipped`, dont les livraisons comptent comme servies : les commandes ne sont ni replanifiées ni "
    "listées non servies (contraire à F4.4), et la publication de la nouvelle version "
    "(_sync_order_statuses) les repasse « planned » alors que plus aucun arrêt à venir ne les livre.",
)
async def test_defaut_recalcul_du_plan_publie_ne_perd_pas_les_commandes_d_un_arret_saute(api, db, tasks):
    summary, plan = await published_day(api, db, tasks)
    _, skipped = await _skip_first_trip(api, plan)

    task_id = (
        await api.call(
            "POST",
            f"/plans/{plan['id']}/recompute",
            "dispatcher",
            json={"params": summary.compute_params},
            expected=(202,),
        )
    ).json()["task_id"]
    recomputed = await get_plan(api, str((await tasks.run(db, task_id)).id))
    pending = {
        d["order_id"]
        for t in recomputed["trips"]
        for s in t["stops"]
        if s["status"] == "pending"
        for d in s["deliveries"]
    }
    unserved = {u["order_id"] for u in recomputed["unserved"]}
    # Attendu : chaque commande de l'arrêt sauté est reprise par un arrêt à venir, ou listée non servie.
    assert skipped <= pending | unserved

    await api.call("POST", f"/plans/{recomputed['id']}/publish", "dispatcher")
    orders = {
        o["id"]: o["status"] for o in await api.get_all("/orders", "dispatcher", day=summary.day.isoformat())
    }
    assert all(orders[o] == "planned" for o in skipped & pending)
    assert all(orders[o] == "confirmed" for o in skipped - pending)


# --------------------------------------------------------------------------- stock dépôt (L5 × L1)


@pytest.mark.xfail(
    strict=True,
    reason="L5 × L1 — RM-08 porte sur « le volume total planifié d'un produit au départ d'un dépôt pour "
    "J », mais app/planning/mapping.py::assemble_problem transmet le stock saisi sans en retirer les "
    "volumes des autres plans publiés du jour : un second calcul replanifie 13 000 L de gasoil alors "
    "que les 30 000 L disponibles sont déjà engagés par le plan publié, sans violation RM-08.",
)
async def test_defaut_rm_08_stock_depot_cumule_entre_les_plans_publies_du_jour(api, db, tasks):
    summary = await load(api, "demo_shortage")  # 30 000 L de gasoil au dépôt pour 43 000 L demandés
    first = await compute_day(api, db, tasks, summary)
    assert [u["reason_code"] for u in first["unserved"]] == ["depot_stock", "depot_stock"]
    planned_gasoil = sum(
        d["planned_l"]
        for t in first["trips"]
        for s in t["stops"]
        for d in s["deliveries"]
        if d["product_code"] == "GASOIL"
    )
    assert planned_gasoil == 30_000  # tout le stock est engagé
    await api.call("POST", f"/plans/{first['id']}/publish", "dispatcher")

    # Les deux commandes non servies sont restées « confirmed » : le dispatcher relance un calcul.
    second = await compute_day(api, db, tasks, summary)
    replanned = sum(d["planned_l"] for t in second["trips"] for s in t["stops"] for d in s["deliveries"])
    rm08 = [v for v in second["violations"] if v["rule_code"] == "RM-08" and v["severity"] == "blocking"]
    # Attendu : plus de gasoil au dépôt → non servies `depot_stock` (ou, à défaut, RM-08 bloquant).
    assert replanned == 0 or rm08, f"{replanned:.0f} L replanifiés au-delà du stock, sans violation RM-08"
    assert second["unserved"] or rm08


# --------------------------------------------------------------------------- libellés (socle)


async def test_defaut_motif_d_indisponibilite_du_chauffeur_en_francais(api, db, tasks):
    summary = await load(api, "demo_scale")  # un chauffeur du jeu est en congé
    drivers = await api.get_all("/availability/drivers", "dispatcher", day=summary.day.isoformat())
    on_leave = next(d for d in drivers if d["status"] == "leave")
    assert on_leave["assignable"] is False
    assert "leave" not in on_leave["block_reason"] and "congé" in on_leave["block_reason"]
