#!/usr/bin/env python3
"""Déroule une journée par l'API, pas à pas, en racontant ce qui se passe (démos des jalons J3 et J4).

    cd backend && uv run python ../scripts/demo/run_day.py demo_douala --until publish    # J3
    cd backend && uv run python ../scripts/demo/run_day.py demo_douala                    # J4
    cd backend && uv run python ../scripts/demo/run_day.py demo_douala --pdf-dir /tmp/pdf

Le jeu doit avoir été chargé (`load_demo.py <nom>`). Tant que les écrans ne sont pas livrés, ce script
tient lieu de dispatcher et d'agent Fleet : il n'appelle que l'API, avec les comptes de démonstration.

Étapes :

1. dispatcher — calcul du plan du jour (`POST /plans/compute`) s'il n'y a pas déjà un brouillon ;
2. dispatcher — déplacement d'un arrêt d'une tournée à une autre (le premier qui ne crée aucune
   violation bloquante ; les essais refusés par les règles sont annulés et comptés) ;
3. dispatcher — verrouillage de la tournée modifiée, puis « recalculer en conservant » ;
4. dispatcher — publication ; feuilles de route PDF                               ← fin de J3
5. fleet — pour chaque tournée : arrivée au dépôt, chargement (27 °C ; 36 °C sur la deuxième pour
   montrer l'avertissement RM-13), fiche de chargement PDF, « chargée », départ ;
6. fleet — livraisons ; le dernier arrêt de la dernière tournée est sauté (station fermée) ;
7. fleet — tournées terminées ; tableau de bord du jour (direction).              ← fin de J4

Il faut un worker Celery (ou `TOURNEO_CELERY_ALWAYS_EAGER=true` côté API) pour les calculs.
Le script n'est pas rejouable sur un plan déjà publié : recharger une base vide ou changer de `--day`.
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


async def draft_plan(api: DemoApi, day: date, params: dict[str, Any]) -> dict[str, Any]:
    """Brouillon calculé du jour ; à défaut, lance le calcul."""
    plans = await api.get_all("/plans", "dispatcher", day=day.isoformat())
    if any(p["kind"] == "computed" and p["status"] == "published" for p in plans):
        raise DemoError(f"Un plan est déjà publié pour le {day:%d/%m/%Y} : la journée a déjà été déroulée.")
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


async def execute(api: DemoApi, plan: dict[str, Any], pdf_dir: Path | None) -> None:
    """Étapes 5 à 7 : dépôt, chargement, livraisons, clôture, tableau de bord."""
    trips = sorted(plan["trips"], key=lambda t: t["planned_depart_at"])
    for index, trip in enumerate(trips):
        trip_id, status = trip["id"], f"/trips/{trip['id']}/status"
        start, depart = _ts(trip["planned_start_at"]), _ts(trip["planned_depart_at"])
        temperature = HOT_TEMPERATURE_C if index == 1 else TEMPERATURE_C
        await api.call("PUT", status, "fleet", json={"status": "at_depot"})
        loading = (
            await api.call(
                "POST",
                f"/trips/{trip_id}/loading",
                "fleet",
                json={
                    "arrived_at": _iso(start),
                    "started_at": _iso(start + timedelta(minutes=80)),
                    "finished_at": _iso(depart - timedelta(minutes=5)),
                    "depot_ticket_no": f"BC-{index + 1:04d}",
                    "lines": [
                        {
                            "compartment_id": line["compartment_id"],
                            "product_id": line["product_id"],
                            "observed_l": line["planned_l"],
                            "observed_temp_c": temperature,
                        }
                        for line in trip["loads"]
                    ],
                },
            )
        ).json()
        api.log(
            f"→ Tournée {trip['seq']} ({trip['truck_plate']}) chargée à {temperature:g} °C : "
            f"{_l(loading['observed_total_l'])} observés, {_l(loading['volume_15_total_l'])} à 15 °C "
            f"(écart {loading['gap_pct']:+.2f} %)"
            + (f" ⚠ {loading['warning_message']}" if loading["out_of_tolerance"] else "")
        )
        if pdf_dir is not None:
            sheet = await api.call("GET", f"/trips/{trip_id}/loading-sheet.pdf", "fleet")
            (pdf_dir / f"fiche_chargement_tournee_{trip['seq']}.pdf").write_bytes(sheet.content)
        await api.call("PUT", status, "fleet", json={"status": "loaded"})
        body = {"status": "in_progress", "actual_depart_at": _iso(depart + timedelta(minutes=10))}
        await api.call("PUT", status, "fleet", json=body)

        for stop in trip["stops"]:
            arrival = _ts(stop["planned_arrival_at"]) + timedelta(minutes=20)
            if index == len(trips) - 1 and stop is trip["stops"][-1]:
                body = {"skip_reason": "Station fermée à l'arrivée", "actual_arrival_at": _iso(arrival)}
                await api.call("PUT", f"/stops/{stop['id']}/delivery", "fleet", json=body)
                api.log(f"   arrêt {stop['station_code']} sauté (station fermée) : commandes à replanifier")
                continue
            body = {
                "actual_arrival_at": _iso(arrival),
                "actual_departure_at": _iso(arrival + timedelta(minutes=40)),
                "deliveries": [
                    {"order_id": d["order_id"], "actual_l": d["planned_l"]} for d in stop["deliveries"]
                ],
            }
            await api.call("PUT", f"/stops/{stop['id']}/delivery", "fleet", json=body)
        body = {
            "status": "completed",
            "actual_return_at": _iso(_ts(trip["planned_return_at"]) + timedelta(minutes=25)),
            "actual_distance_m": trip["distance_m"] + 1500,
        }
        await api.call("PUT", status, "fleet", json=body)
        api.log(f"   tournée {trip['seq']} terminée ({len(trip['stops'])} arrêt(s))")

    day = plan["day"]
    board = (await api.call("GET", "/dashboard", "manager", params={"day": day})).json()["summary"]
    orders = await api.get_all("/orders", "manager", day=day)
    statuses: dict[str, int] = {}
    for order in orders:
        statuses[order["status"]] = statuses.get(order["status"], 0) + 1
    api.log("")
    api.log(f"Tableau de bord du {day} :")
    api.log(f"  tournées : {json.dumps(board['trips_by_status'], ensure_ascii=False)}")
    api.log(
        f"  arrêts : {board['stops_delivered']} livré(s), {board['stops_skipped']} sauté(s), "
        f"{board['stops_pending']} en attente"
    )
    api.log(
        f"  volumes : {_l(board['volume_delivered_l'])} livrés sur {_l(board['volume_planned_l'])} planifiés"
    )
    api.log(f"  retards : {board['trips_late']} tournée(s), au plus {board['max_delay_s'] // 60} min")
    api.log(f"  alertes : {board['alerts_total']} (dont {board['alerts_blocking']} bloquante(s))")
    api.log(f"  commandes : {statuses}")


async def run_day(
    api: DemoApi, name: str, *, day: date | None = None, until: str = "delivered", pdf_dir: Path | None = None
) -> None:
    problem = load_problem(name)
    day = day or problem.day
    params = export_fixture.compute_payload(problem)["params"]
    for role in ("dispatcher", "fleet", "manager"):
        await api.login(role, load_demo.DEMO_USERS[role][0], load_demo.DEMO_PASSWORD)
    plan = await draft_plan(api, day, params)
    describe(plan, api.log)
    published = await correct_and_publish(api, plan, params, pdf_dir)
    if until == "publish":
        return
    await execute(api, published, pdf_dir)


async def _main(args: argparse.Namespace) -> None:
    base_url = args.base_url.rstrip("/")
    if not base_url.endswith("/api/v1"):
        base_url += "/api/v1"
    if args.pdf_dir is not None:
        args.pdf_dir.mkdir(parents=True, exist_ok=True)
    async with httpx.AsyncClient(base_url=base_url, timeout=120.0) as client:
        await run_day(DemoApi(client), args.name, day=args.day, until=args.until, pdf_dir=args.pdf_dir)


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
