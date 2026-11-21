#!/usr/bin/env python3
"""Déroule une journée par l'API, pas à pas, en racontant ce qui se passe (démos des jalons J3 et J4).

    cd backend && uv run python ../scripts/demo/run_day.py demo_douala --until publish    # J3
    cd backend && uv run python ../scripts/demo/run_day.py demo_douala                    # J4
    cd backend && uv run python ../scripts/demo/run_day.py demo_douala --shortage --breakdown
    cd backend && uv run python ../scripts/demo/run_day.py demo_douala --pdf-dir /tmp/pdf

Le jeu doit avoir été chargé (`load_demo.py <nom>`). Ce script tient lieu de dispatcher, d'agent
Supply et d'agent Fleet : il n'appelle que l'API, avec les comptes de démonstration. Les mêmes gestes
se font à l'écran (voir `docs/DEMO.md`).

Étapes :

1. dispatcher — calcul du plan du jour (`POST /plans/compute`) s'il n'y a pas déjà un brouillon ;
2. dispatcher — déplacement d'un arrêt d'une tournée à une autre (les essais refusés par les règles
   sont annulés et affichés) ;
3. dispatcher — verrouillage de la tournée modifiée, puis « recalculer en conservant » ;
4. dispatcher — publication ; feuilles de route PDF                               ← fin de J3
5. `--shortage` : Supply déclare une pénurie de gasoil (5 000 L de moins que le plan), le dispatcher
   reporte les commandes de la tournée impactée → nouvelle version publiée (F6.3) ;
6. fleet — pour chaque tournée, dans l'ordre des départs : arrivée au dépôt, chargement (27 °C ;
   36 °C sur la deuxième pour montrer l'avertissement RM-13), fiche PDF, « chargée », départ,
   livraisons, clôture ; le dernier arrêt de la dernière tournée est sauté (station fermée) ;
   `--breakdown` : un camion tombe en panne après son premier arrêt ; le dispatcher choisit un
   remplaçant éligible → nouvelle version publiée, seuls les arrêts en attente sont transférés
   (RM-19), la tournée de remplacement est chargée puis livrée (F6.1) ;
7. dispatcher — second calcul du jour pour les commandes de l'arrêt sauté : second plan publié,
   exécuté à son tour ;
8. direction — tableau de bord du jour, journal des événements, statuts des commandes. ← fin de J4

Il faut un worker Celery (ou `TOURNEO_CELERY_ALWAYS_EAGER=true` côté API) pour les calculs.
Après `--until publish`, relancer le script reprend à l'exécution du plan publié. Une journée
entièrement déroulée ne se rejoue pas : recharger une base vide ou changer de `--day`.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))

import export_fixture  # noqa: E402
import load_demo  # noqa: E402
from load_demo import DemoApi, DemoError  # noqa: E402

from app.core.time import format_local_hm  # noqa: E402
from app.planning.fixtures import load_problem  # noqa: E402

HOT_TEMPERATURE_C = 36.0
TEMPERATURE_C = 27.0
SKIP_REASON = "Station fermée à l'arrivée"
SHORTAGE_PRODUCT = "GASOIL"
SHORTAGE_L = 5000.0  # litres manquants par rapport au plan publié


def _ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _local(value: str) -> str:
    """Heure UTC de l'API → HH:MM en Africa/Douala pour l'affichage du récit (RM-20)."""
    return format_local_hm(_ts(value))


def _l(volume: float) -> str:
    """12 345 L (espace comme séparateur de milliers)."""
    return f"{volume:,.0f} L".replace(",", " ")


def describe(plan: dict[str, Any], log: Any) -> None:
    for trip in sorted(plan["trips"], key=lambda t: t["seq"]):
        stops = " → ".join(s["station_code"] for s in trip["stops"])
        log(
            f"   tournée {trip['seq']} — {trip['truck_plate']} ({trip['driver_name']}), départ "
            f"{_local(trip['planned_depart_at'])}, {trip['distance_m'] / 1000:.1f} km"
            f"{' 🔒' if trip['locked'] else ''} : {stops}"
        )
    log(
        f"   {len(plan['trips'])} tournée(s), {sum(t['distance_m'] for t in plan['trips']) / 1000:.1f} km, "
        f"{len(plan['unserved'])} non servie(s), {plan['blocking_count']} violation(s) bloquante(s), "
        f"{plan['warning_count']} avertissement(s)"
    )


async def get_plan(api: DemoApi, plan_id: str, role: str = "dispatcher") -> dict[str, Any]:
    return (await api.call("GET", f"/plans/{plan_id}", role)).json()


async def published_plan(api: DemoApi, day: date) -> dict[str, Any] | None:
    """Plan calculé publié du jour qui a encore des tournées à faire (le script est alors repris à
    l'exécution) ; None s'il n'y en a pas."""
    plans = await api.get_all("/plans", "dispatcher", day=day.isoformat())
    for summary in plans:
        if summary["kind"] == "computed" and summary["status"] == "published":
            plan = await get_plan(api, summary["id"])
            if any(t["status"] != "completed" for t in plan["trips"]):
                return plan
    return None


async def draft_plan(api: DemoApi, day: date, params: dict[str, Any]) -> dict[str, Any]:
    """Brouillon calculé du jour ; à défaut, lance le calcul."""
    plans = await api.get_all("/plans", "dispatcher", day=day.isoformat())
    if any(p["kind"] == "computed" and p["status"] == "published" for p in plans):
        raise DemoError(
            f"La journée du {day:%d/%m/%Y} a déjà été déroulée : toutes les tournées sont terminées."
        )
    drafts = [p for p in plans if p["kind"] == "computed" and p["status"] == "draft"]
    if drafts:
        api.log("→ Plan brouillon du jour déjà calculé")
        return await get_plan(api, drafts[0]["id"])
    api.log("→ Calcul du plan du jour")
    return await get_plan(api, await api.wait_task(await api.start_compute(day, params)))


def _free_l(trip: dict[str, Any]) -> float:
    return (trip["truck_capacity_l"] or 0.0) - trip["planned_l"]


async def move_one_stop(api: DemoApi, plan: dict[str, Any]) -> tuple[dict[str, Any], str]:
    """Déplace un arrêt vers une autre tournée en gardant le plan publiable (F5.1, F5.2).

    Comme un dispatcher, on ne tente que les déplacements plausibles — l'arrêt tient dans la place
    libre du camion d'arrivée —, du plus à l'aise au plus juste. Le serveur recontrôle chaque essai :
    s'il signale une violation bloquante (compartiments, gabarit, fenêtre…), l'arrêt est remis à sa
    place et l'essai suivant est tenté. Renvoie le plan et l'identifiant de la tournée d'arrivée."""
    candidates = [
        (_free_l(target) - stop["planned_l"], source, stop, target)
        for source in plan["trips"]
        if len(source["stops"]) >= 2  # déplacer l'unique arrêt supprimerait la tournée
        for stop in source["stops"]
        for target in plan["trips"]
        if target["id"] != source["id"] and _free_l(target) >= stop["planned_l"]
    ]
    candidates.sort(key=lambda c: (-c[0], c[1]["seq"], c[2]["seq"], c[3]["seq"]))
    for rejected, (_, source, stop, target) in enumerate(candidates):
        path = f"/plans/{plan['id']}/trips/{source['id']}/move-stop"
        body = {"stop_id": stop["id"], "to_trip_id": target["id"], "to_seq": 1}
        moved = (await api.call("POST", path, "dispatcher", json=body)).json()
        if moved["blocking_count"] == 0:
            api.log(
                f"→ Arrêt {stop['station_code']} déplacé de la tournée {source['seq']} vers la "
                f"tournée {target['seq']} ({rejected} essai(s) refusé(s) par les règles auparavant)"
            )
            return moved, target["id"]
        rules = sorted({v["rule_code"] for v in moved["violations"] if v["severity"] == "blocking"})
        api.log(
            f"   essai : {stop['station_code']} → tournée {target['seq']} : violation bloquante "
            f"{', '.join(rules)} — annulé"
        )
        path = f"/plans/{plan['id']}/trips/{target['id']}/move-stop"
        body = {"stop_id": stop["id"], "to_trip_id": source["id"], "to_seq": stop["seq"]}
        await api.call("POST", path, "dispatcher", json=body)
    raise DemoError("Aucun déplacement d'arrêt ne laisse le plan sans violation bloquante.")


async def correct_and_publish(
    api: DemoApi, plan: dict[str, Any], params: dict[str, Any], pdf_dir: Path | None
) -> dict[str, Any]:
    """Étapes 2 à 4 : déplacement, verrouillage, recalcul, publication, feuilles de route."""
    plan, target_id = await move_one_stop(api, plan)
    await api.call("POST", f"/plans/{plan['id']}/trips/{target_id}/lock", "dispatcher")
    api.log("→ Tournée modifiée verrouillée ; recalcul en conservant les tournées verrouillées")
    body = {"params": params or None}
    task = await api.call("POST", f"/plans/{plan['id']}/recompute", "dispatcher", json=body, expected=(202,))
    plan = await get_plan(api, await api.wait_task(task.json()["task_id"]))
    describe(plan, api.log)
    published = (await api.call("POST", f"/plans/{plan['id']}/publish", "dispatcher")).json()
    orders = await api.get_all("/orders", "dispatcher", day=published["day"])
    planned = sum(1 for o in orders if o["status"] == "planned")
    api.log(f"→ Plan publié (version {published['version']}) : {planned} commande(s) « planned »")
    if pdf_dir is not None:
        sheets = await api.call("GET", f"/plans/{published['id']}/route-sheets.pdf", "dispatcher")
        (pdf_dir / "feuilles_de_route.pdf").write_bytes(sheets.content)
        api.log(f"→ Feuilles de route : {pdf_dir / 'feuilles_de_route.pdf'}")
    return published


def by_departure(trips: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(trips, key=lambda t: (t["planned_depart_at"], t["seq"]))


def loading_body(trip: dict[str, Any], temperature: float, ticket: str) -> dict[str, Any]:
    """Chargement conforme au plan de chargement : une ligne par compartiment chargé de
    `trips[].compartments` (les compartiments vides, `planned_l = 0`, ne sont pas saisis)."""
    start, depart = _ts(trip["planned_start_at"]), _ts(trip["planned_depart_at"])
    return {
        "arrived_at": _iso(start),
        "started_at": _iso(start + timedelta(minutes=80)),
        "finished_at": _iso(depart - timedelta(minutes=5)),
        "depot_ticket_no": ticket,
        "lines": [
            {
                "compartment_id": c["compartment_id"],
                "product_id": c["product_id"],
                "observed_l": c["planned_l"],
                "observed_temp_c": temperature,
            }
            for c in trip["compartments"]
            if c["planned_l"] > 0
        ],
    }


async def load_and_depart(
    api: DemoApi, trip: dict[str, Any], *, temperature: float = TEMPERATURE_C, pdf_dir: Path | None = None
) -> dict[str, Any]:
    """Fleet : arrivée au dépôt, chargement, fiche PDF, « chargée », départ. Renvoie le chargement."""
    status = f"/trips/{trip['id']}/status"
    await api.call("PUT", status, "fleet", json={"status": "at_depot"})
    body = loading_body(trip, temperature, f"BC-{trip['seq']:04d}")
    loading = (await api.call("POST", f"/trips/{trip['id']}/loading", "fleet", json=body)).json()
    api.log(
        f"→ Tournée {trip['seq']} ({trip['truck_plate']}) chargée à {temperature:g} °C : "
        f"{_l(loading['observed_total_l'])} observés, {_l(loading['volume_15_total_l'])} à 15 °C "
        f"(écart {loading['gap_pct']:+.2f} %)"
        + (f" ⚠ {loading['warning_message']}" if loading["out_of_tolerance"] else "")
    )
    if pdf_dir is not None:
        sheet = await api.call("GET", f"/trips/{trip['id']}/loading-sheet.pdf", "fleet")
        (pdf_dir / f"fiche_chargement_tournee_{trip['seq']}.pdf").write_bytes(sheet.content)
    await api.call("PUT", status, "fleet", json={"status": "loaded"})
    depart = _ts(trip["planned_depart_at"]) + timedelta(minutes=10)
    await api.call("PUT", status, "fleet", json={"status": "in_progress", "actual_depart_at": _iso(depart)})
    return loading


async def deliver_stop(api: DemoApi, stop: dict[str, Any]) -> dict[str, Any]:
    """Livraison complète d'un arrêt, 20 minutes après l'heure prévue."""
    arrival = _ts(stop["planned_arrival_at"]) + timedelta(minutes=20)
    body = {
        "actual_arrival_at": _iso(arrival),
        "actual_departure_at": _iso(arrival + timedelta(minutes=40)),
        "deliveries": [{"order_id": d["order_id"], "actual_l": d["planned_l"]} for d in stop["deliveries"]],
    }
    return (await api.call("PUT", f"/stops/{stop['id']}/delivery", "fleet", json=body)).json()


async def skip_stop(api: DemoApi, stop: dict[str, Any], reason: str = SKIP_REASON) -> dict[str, Any]:
    arrival = _ts(stop["planned_arrival_at"]) + timedelta(minutes=20)
    body = {"skip_reason": reason, "actual_arrival_at": _iso(arrival)}
    done = (await api.call("PUT", f"/stops/{stop['id']}/delivery", "fleet", json=body)).json()
    api.log(f"   arrêt {stop['station_code']} sauté ({reason.lower()}) : commandes à replanifier")
    return done


async def close_trip(api: DemoApi, trip: dict[str, Any]) -> dict[str, Any]:
    body = {
        "status": "completed",
        "actual_return_at": _iso(_ts(trip["planned_return_at"]) + timedelta(minutes=25)),
        "actual_distance_m": trip["distance_m"] + 1500,
    }
    closed = (await api.call("PUT", f"/trips/{trip['id']}/status", "fleet", json=body)).json()
    api.log(f"   tournée {trip['seq']} terminée ({len(trip['stops'])} arrêt(s))")
    return closed


async def run_trip(
    api: DemoApi,
    trip: dict[str, Any],
    *,
    temperature: float = TEMPERATURE_C,
    skip_last: bool = False,
    pdf_dir: Path | None = None,
) -> None:
    """Une tournée de bout en bout ; `skip_last` : son dernier arrêt est sauté (station fermée)."""
    await load_and_depart(api, trip, temperature=temperature, pdf_dir=pdf_dir)
    for stop in trip["stops"]:
        if skip_last and stop is trip["stops"][-1]:
            await skip_stop(api, stop)
        else:
            await deliver_stop(api, stop)
    await close_trip(api, trip)


# --------------------------------------------------------------------------- événements du jour (F6)


def planned_volume(plan: dict[str, Any], product_code: str, depot_id: str | None = None) -> float:
    """Volume du produit planifié sur les arrêts non sautés du plan (au départ d'un dépôt donné)."""
    return sum(
        d["planned_l"]
        for t in plan["trips"]
        if depot_id is None or t["depot_id"] == depot_id
        for s in t["stops"]
        if s["status"] != "skipped"
        for d in s["deliveries"]
        if d["product_code"] == product_code
    )


async def declare_shortage(
    api: DemoApi, plan: dict[str, Any], *, product_code: str = SHORTAGE_PRODUCT, missing_l: float = SHORTAGE_L
) -> dict[str, Any]:
    """Supply : le stock du produit au dépôt tombe `missing_l` litres sous ce que le plan publié
    prévoit (`POST /events/product-shortage`). Renvoie l'alerte, avec les tournées impactées."""
    depot_id = by_departure(plan["trips"])[0]["depot_id"]
    stocks = await api.get_all("/availability/depot-stocks", "supply", day=plan["day"])
    stock = next(s for s in stocks if s["depot_id"] == depot_id and s["product_code"] == product_code)
    body = {
        "depot_id": depot_id,
        "product_id": stock["product_id"],
        "new_available_l": planned_volume(plan, product_code, depot_id) - missing_l,
        "day": plan["day"],
        "comment": "Bac indisponible (démonstration)",
    }
    shortage = (await api.call("POST", "/events/product-shortage", "supply", json=body)).json()
    api.log(f"→ Pénurie déclarée par Supply : {shortage['event']['summary']}")
    for trip in shortage["impacted_trips"]:
        orders = ", ".join(f"{o['station_code']} {_l(o['planned_l'])}" for o in trip["orders"])
        api.log(
            f"   tournée {trip['trip_seq']} impactée : {_l(trip['planned_l'])} prévus, "
            f"{_l(trip['covered_l'])} couverts, options {trip['options']} — {orders}"
        )
    return shortage


async def resolve_shortage(
    api: DemoApi, shortage: dict[str, Any], action: str = "postpone"
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Dispatcher : même décision pour chaque tournée impactée (`POST /events/{id}/resolve`).
    Renvoie la réponse et le plan en vigueur après la décision (None si rien n'était impacté)."""
    if not shortage["impacted_trips"]:
        return shortage, None
    body = {"resolutions": [{"trip_id": t["trip_id"], "action": action} for t in shortage["impacted_trips"]]}
    resolved = (
        await api.call("POST", f"/events/{shortage['event']['id']}/resolve", "dispatcher", json=body)
    ).json()
    result = resolved["results"][-1]
    api.log(
        f"→ Pénurie traitée par le dispatcher ({action}) : alerte « {resolved['status']} », "
        f"version {result['plan_version']} {'publiée' if result['published'] else 'en brouillon'}"
    )
    return resolved, result["plan"]


def breakdown_candidate(plan: dict[str, Any]) -> dict[str, Any] | None:
    """Tournée sur laquelle simuler la panne : la première, dans l'ordre des départs, qui n'a pas
    commencé, a au moins deux arrêts et est la dernière de son camion ce jour-là (sinon les autres
    tournées du camion en panne laisseraient la nouvelle version en brouillon, question L10-6)."""
    trips = by_departure(plan["trips"])
    last_of_truck = {t["truck_id"]: t["id"] for t in trips}
    return next(
        (
            t
            for t in trips
            if t["status"] == "planned" and len(t["stops"]) >= 2 and last_of_truck[t["truck_id"]] == t["id"]
        ),
        None,
    )


async def break_down(api: DemoApi, trip: dict[str, Any], pdf_dir: Path | None = None) -> dict[str, Any]:
    """La tournée part, livre son premier arrêt, puis le camion tombe en panne : le dispatcher
    choisit le premier camion de remplacement éligible proposé par l'assistant et déclare la panne
    (`POST /events/truck-breakdown`). Renvoie la réponse (nouvelle version du plan dans `plan`)."""
    await load_and_depart(api, trip, pdf_dir=pdf_dir)
    first = trip["stops"][0]
    delivered = await deliver_stop(api, first)
    occurred = _iso(_ts(delivered["actual_departure_at"]) + timedelta(minutes=10))
    options = (
        await api.call(
            "GET",
            "/events/replacement-options",
            "dispatcher",
            params={"trip_id": trip["id"], "occurred_at": occurred},
        )
    ).json()
    for truck in options["trucks"]:
        reasons = ", ".join(r["rule_code"] or r["message"] for r in truck["reasons"])
        verdict = "oui" if truck["eligible"] else f"non — {reasons}"
        api.log(f"   remplaçant possible ? {truck['plate']} : {verdict}")
    eligible = next((t for t in options["trucks"] if t["eligible"]), None)
    if eligible is None:
        raise DemoError(f"Aucun camion de remplacement éligible pour la tournée {trip['seq']}.")
    body = {
        "trip_id": trip["id"],
        "replacement_truck_id": eligible["truck_id"],
        "occurred_at": occurred,
        "reason": "Panne mécanique (démonstration)",
    }
    result = (await api.call("POST", "/events/truck-breakdown", "dispatcher", json=body)).json()
    api.log(f"→ {result['event']['summary']}")
    return result


# --------------------------------------------------------------------------- journée


async def execute(
    api: DemoApi,
    plan: dict[str, Any],
    pdf_dir: Path | None,
    *,
    breakdown: bool = False,
    skip_last: bool = True,
) -> dict[str, Any]:
    """Étapes 5 à 7 : toutes les tournées du plan publié, dans l'ordre des départs. Renvoie le plan
    en vigueur à la fin (une panne crée une nouvelle version)."""
    victim = breakdown_candidate(plan) if breakdown else None
    if breakdown and victim is None:
        api.log("   (aucune tournée ne se prête à la panne : étape ignorée)")
    hot = by_departure(plan["trips"])[1]["seq"] if len(plan["trips"]) > 1 else None
    while True:
        todo = [t for t in by_departure(plan["trips"]) if t["status"] == "planned"]
        if not todo:
            return plan
        trip = todo[0]
        if victim is not None and trip["seq"] == victim["seq"]:
            victim = None
            plan = (await break_down(api, trip, pdf_dir))["plan"]
            continue
        temperature = HOT_TEMPERATURE_C if trip["seq"] == hot else TEMPERATURE_C
        await run_trip(
            api, trip, temperature=temperature, skip_last=skip_last and len(todo) == 1, pdf_dir=pdf_dir
        )
        plan = await get_plan(api, plan["id"], "fleet")


async def replan_skipped(api: DemoApi, day: str, params: dict[str, Any]) -> dict[str, Any] | None:
    """Second calcul du jour pour les commandes revenues à « confirmed » (arrêt sauté) : second plan
    publié, de lignée distincte, puis exécuté. Renvoie ce plan (None s'il n'y a rien à replanifier)."""
    waiting = await api.get_all("/orders", "dispatcher", day=day, status="confirmed")
    if not waiting:
        return None
    api.log(f"→ Second calcul du jour : {len(waiting)} commande(s) à replanifier")
    plan = await get_plan(api, await api.wait_task(await api.start_compute(date.fromisoformat(day), params)))
    describe(plan, api.log)
    for unserved in plan["unserved"]:
        api.log(
            f"   non servie : {unserved['station_code']} {unserved['product_code']} "
            f"({unserved['reason_code']}) — {unserved['reason_text']}"
        )
    if not plan["trips"]:
        return plan
    published = (await api.call("POST", f"/plans/{plan['id']}/publish", "dispatcher")).json()
    return await execute(api, published, None, skip_last=False)


async def report(api: DemoApi, day: str) -> None:
    """Tableau de bord du jour, journal des événements et statuts des commandes."""
    board = (await api.call("GET", "/dashboard", "manager", params={"day": day})).json()
    summary = board["summary"]
    orders = await api.get_all("/orders", "manager", day=day)
    statuses: dict[str, int] = {}
    for order in orders:
        statuses[order["status"]] = statuses.get(order["status"], 0) + 1
    events: dict[str, int] = {}
    for event in await api.get_all("/events", "manager", day=day):
        events[event["type_label"]] = events.get(event["type_label"], 0) + 1
    api.log("")
    api.log(f"Tableau de bord du {day} (plan publié version {board['plan']['version']}) :")
    api.log(f"  tournées : {json.dumps(summary['trips_by_status'], ensure_ascii=False)}")
    api.log(
        f"  arrêts : {summary['stops_delivered']} livré(s), {summary['stops_skipped']} sauté(s), "
        f"{summary['stops_pending']} en attente"
    )
    delivered, planned = _l(summary["volume_delivered_l"]), _l(summary["volume_planned_l"])
    api.log(f"  volumes : {delivered} livrés sur {planned} planifiés")
    api.log(f"  retards : {summary['trips_late']} tournée(s), au plus {summary['max_delay_s'] // 60} min")
    api.log(f"  alertes : {summary['alerts_total']} (dont {summary['alerts_blocking']} bloquante(s))")
    api.log(f"  journal : {json.dumps(events, ensure_ascii=False)}")
    api.log(f"  commandes : {statuses}")


async def run_day(
    api: DemoApi,
    name: str,
    *,
    day: date | None = None,
    until: str = "delivered",
    pdf_dir: Path | None = None,
    breakdown: bool = False,
    shortage: bool = False,
) -> None:
    problem = load_problem(name)
    day = day or problem.day
    params = export_fixture.compute_payload(problem)["params"]
    for role in ("dispatcher", "fleet", "manager", "supply"):
        await api.login(role, load_demo.DEMO_USERS[role][0], load_demo.DEMO_PASSWORD)
    published = await published_plan(api, day)
    if published is not None:
        api.log(f"→ Plan déjà publié (version {published['version']}) : reprise de l'exécution")
        describe(published, api.log)
    else:
        plan = await draft_plan(api, day, params)
        describe(plan, api.log)
        published = await correct_and_publish(api, plan, params, pdf_dir)
    if until == "publish":
        return
    if shortage:
        _, after = await resolve_shortage(api, await declare_shortage(api, published))
        published = after or published
    await execute(api, published, pdf_dir, breakdown=breakdown)
    await replan_skipped(api, day.isoformat(), params)
    await report(api, day.isoformat())


async def _main(args: argparse.Namespace) -> None:
    base_url = args.base_url.rstrip("/")
    if not base_url.endswith("/api/v1"):
        base_url += "/api/v1"
    if args.pdf_dir is not None:
        args.pdf_dir.mkdir(parents=True, exist_ok=True)
    async with httpx.AsyncClient(base_url=base_url, timeout=120.0) as client:
        await run_day(
            DemoApi(client),
            args.name,
            day=args.day,
            until=args.until,
            pdf_dir=args.pdf_dir,
            breakdown=args.breakdown,
            shortage=args.shortage,
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Déroule une journée de démonstration par l'API.")
    parser.add_argument("name", choices=export_fixture.FIXTURES, help="jeu chargé par load_demo.py")
    parser.add_argument("--base-url", default="http://localhost:8000", help="adresse de l'API")
    parser.add_argument("--day", type=date.fromisoformat, help="jour à dérouler (défaut : celui du jeu)")
    parser.add_argument(
        "--until",
        choices=("publish", "delivered"),
        default="delivered",
        help="s'arrêter après la publication (J3) ou aller jusqu'aux livraisons (J4, défaut)",
    )
    parser.add_argument(
        "--shortage",
        action="store_true",
        help="après la publication : pénurie de gasoil déclarée par Supply, traitée par un report (F6.3)",
    )
    parser.add_argument(
        "--breakdown",
        action="store_true",
        help="en cours de journée : panne d'un camion après son premier arrêt, remplacement (F6.1)",
    )
    parser.add_argument(
        "--pdf-dir", type=Path, help="enregistrer ici feuilles de route et fiches de chargement"
    )
    args = parser.parse_args()
    try:
        asyncio.run(_main(args))
    except DemoError as exc:
        print(f"✘ {exc}", file=sys.stderr)
        sys.exit(1)
    except httpx.HTTPError as exc:
        print(f"✘ API injoignable ({args.base_url}) : {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
