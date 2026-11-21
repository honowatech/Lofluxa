#!/usr/bin/env python3
"""Charge un jeu de démonstration dans Tournéo, **uniquement par l'API HTTP** (démos des jalons J1 / J2).

    cd backend && uv run python ../scripts/demo/load_demo.py demo_douala
    cd backend && uv run python ../scripts/demo/load_demo.py demo_douala --compute
    cd backend && uv run python ../scripts/demo/load_demo.py demo_scale --base-url https://tourneo.example.cm
    cd backend && uv run python ../scripts/demo/load_demo.py demo_douala --day 2027-02-02

Étapes, par les mêmes portes qu'un utilisateur :

1. connexion de l'administrateur (`--admin-email` / `--admin-password`, ou `TOURNEO_ADMIN_EMAIL` /
   `TOURNEO_ADMIN_PASSWORD`), création des comptes de démonstration (dispatcher, supply, fleet, manager) ;
2. import des cinq fichiers de `data/fixtures/<nom>/import/` : prévisualiser → appliquer, dans l'ordre
   dépôts, stations, camions, chauffeurs, commandes ;
3. saisie des stocks dépôt du jour (`depot_stocks.json`) par le compte Supply ;
4. affectations camion → chauffeur du jour s'il y en a (`compute.json`) ;
5. confirmation des commandes du jour par le dispatcher ;
6. avec `--compute` : `POST /plans/compute` puis suivi de la tâche (il faut un worker Celery, ou
   `TOURNEO_CELERY_ALWAYS_EAGER=true` côté API).

Rejouable sans doublons : un second passage n'annonce que des lignes « inchangées », ne ressaisit pas un
stock identique et ne confirme que les commandes encore en brouillon.

`--day` : les commandes et les stocks sont datés du jour voulu (le fichier de commandes est alors
reconstruit à partir du jeu au lieu d'être lu sur le disque ; le format est le même).

Ce module ne lit aucun fichier Excel : il transmet les octets des fichiers à l'API, qui est seule à
les interpréter (critère d'acceptation 7).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))

import export_fixture  # noqa: E402
from app.core.enums import ImportKind  # noqa: E402  (chemin `backend/` ajouté par export_fixture)
from app.planning.fixtures import load_problem  # noqa: E402

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
PAGE = 500

# Comptes créés par le chargeur (mots de passe de démonstration, à changer hors démo).
DEMO_PASSWORD = "demo-tourneo-2027"
DEMO_USERS = {
    "dispatcher": ("dispatcher@demo.tourneo.cm", "Dispatcher Démo"),
    "supply": ("supply@demo.tourneo.cm", "Supply Démo"),
    "fleet": ("fleet@demo.tourneo.cm", "Fleet Démo"),
    "manager": ("manager@demo.tourneo.cm", "Direction Démo"),
}
LOADER_ROLES = ("dispatcher", "supply")
LOGIN_RETRIES = 6
LOGIN_RETRY_S = 15.0
DEFAULT_ADMIN = ("admin@honowa.tech", "admin-dev-only")  # compte créé par `python -m app.cli seed`


class DemoError(RuntimeError):
    """Étape de chargement refusée par l'API : le message reprend la réponse reçue."""


@dataclass
class LoadSummary:
    name: str
    day: date
    imports: dict[str, dict[str, int]] = field(default_factory=dict)
    timings: dict[str, float] = field(default_factory=dict)
    users_created: list[str] = field(default_factory=list)
    stocks_entered: int = 0
    assignments: int = 0
    orders_confirmed: int = 0
    orders_total: int = 0
    orders_by_status: dict[str, int] = field(default_factory=dict)
    confirm_warnings: int = 0
    plan: dict[str, Any] | None = None
    compute_params: dict[str, Any] = field(default_factory=dict)


class DemoApi:
    """Petit client de l'API Tournéo : jetons par rôle, pagination, erreurs lisibles."""

    def __init__(self, client: httpx.AsyncClient, log: Callable[[str], None] = print) -> None:
        self.client = client
        self.log = log
        self.tokens: dict[str, str] = {}

    # ----- appels

    async def call(
        self, method: str, path: str, role: str | None, *, expected: tuple[int, ...] = (200,), **kwargs: Any
    ) -> httpx.Response:
        headers = {"Authorization": f"Bearer {self.tokens[role]}"} if role else {}
        response = await self.client.request(method, path, headers=headers, **kwargs)
        if response.status_code not in expected:
            raise DemoError(f"{method} {path} → {response.status_code} : {response.text[:2000]}")
        return response

    async def get_all(self, path: str, role: str, **params: Any) -> list[dict[str, Any]]:
        """Toutes les pages d'une liste `Page[T]`."""
        items: list[dict[str, Any]] = []
        while True:
            page = (
                await self.call("GET", path, role, params={**params, "limit": PAGE, "offset": len(items)})
            ).json()
            items.extend(page["items"])
            if len(items) >= page["total"] or not page["items"]:
                return items

    # ----- comptes

    async def login(self, role: str, email: str, password: str) -> None:
        """Connexion. La limitation de débit de `/auth/login` (429) est attendue puis la demande rejouée."""
        payload = {"email": email, "password": password}
        for _ in range(LOGIN_RETRIES):
            response = await self.call("POST", "/auth/login", None, json=payload, expected=(200, 429))
            if response.status_code == 200:
                self.tokens[role] = response.json()["access_token"]
                return
            self.log(f"   … trop de connexions récentes : nouvelle tentative dans {LOGIN_RETRY_S:.0f} s")
            await asyncio.sleep(LOGIN_RETRY_S)
        raise DemoError("Connexion refusée par la limitation de débit : réessayer dans une minute.")

    async def ensure_demo_users(self) -> list[str]:
        """Crée les comptes de démonstration manquants (admin) et connecte ceux dont le chargeur a
        besoin (dispatcher, supply). Renvoie les comptes créés."""
        existing = {user["email"] for user in await self.get_all("/users", "admin")}
        created = []
        for role, (email, full_name) in DEMO_USERS.items():
            if email not in existing:
                payload = {"email": email, "full_name": full_name, "role": role, "password": DEMO_PASSWORD}
                await self.call("POST", "/users", "admin", json=payload, expected=(201,))
                created.append(email)
            if role in LOADER_ROLES:
                await self.login(role, email, DEMO_PASSWORD)
        return created

    # ----- imports (F1.6, F3.2)

    async def import_file(
        self, kind: str, filename: str, content: bytes, role: str, **params: Any
    ) -> dict[str, Any]:
        """Prévisualiser puis appliquer. Renvoie le lot appliqué (résumé dans `summary`)."""
        preview = (
            await self.call(
                "POST",
                f"/imports/{kind}/preview",
                role,
                files={"file": (filename, content, XLSX_MIME)},
                params=params,
                expected=(201,),
            )
        ).json()
        if preview["status"] != "previewed":
            errors = [i for i in preview["report"]["issues"] if i.get("severity") == "error"]
            lines = "\n".join(f"  ligne {i.get('row')} — {i.get('message')}" for i in errors[:20])
            raise DemoError(f"Import {kind} rejeté ({preview['error_count']} erreur(s)) :\n{lines}")
        return (await self.call("POST", f"/imports/{preview['id']}/apply", role)).json()

    # ----- disponibilité du jour (F2.1, F2.4)

    async def put_depot_stocks(self, day: date, items: list[dict[str, Any]]) -> int:
        depots = {d["code"]: d["id"] for d in await self.get_all("/depots", "supply")}
        products = {p["code"]: p["id"] for p in await self.get_all("/products", "supply")}
        payload = {
            "items": [
                {
                    "depot_id": depots[item["depot_code"]],
                    "product_id": products[item["product_code"]],
                    "available_l": item["available_l"],
                }
                for item in items
            ]
        }
        if not payload["items"]:
            return 0
        await self.call(
            "PUT", "/availability/depot-stocks", "supply", params={"day": day.isoformat()}, json=payload
        )
        return len(payload["items"])

    async def put_driver_assignments(self, day: date, assignments: list[dict[str, str]]) -> int:
        """Affectations du jour camion → chauffeur ; celles déjà en place ne sont pas renvoyées."""
        if not assignments:
            return 0
        trucks = {t["plate"]: t["id"] for t in await self.get_all("/trucks", "dispatcher")}
        drivers = {d["license_no"]: d["id"] for d in await self.get_all("/drivers", "dispatcher")}
        current = {
            d["driver_id"]: d["truck_id"]
            for d in await self.get_all("/availability/drivers", "dispatcher", day=day.isoformat())
        }
        items = []
        for assignment in assignments:
            driver_id = drivers[assignment["driver_license_no"]]
            truck_id = trucks[assignment["truck_plate"]]
            if current.get(driver_id) != truck_id:
                items.append({"driver_id": driver_id, "truck_id": truck_id})
        if items:
            await self.call(
                "PUT",
                "/availability/drivers",
                "dispatcher",
                params={"day": day.isoformat()},
                json={"items": items},
            )
        return len(items)

    # ----- commandes (F3)

    async def confirm_draft_orders(self, day: date) -> tuple[int, int]:
        """Confirme en masse les brouillons du jour. Renvoie (confirmées, avertissements F3.4)."""
        drafts = await self.get_all("/orders", "dispatcher", day=day.isoformat(), status="draft")
        confirmed = warnings = 0
        for start in range(0, len(drafts), PAGE):
            ids = [order["id"] for order in drafts[start : start + PAGE]]
            result = (
                await self.call("POST", "/orders/confirm", "dispatcher", json={"order_ids": ids})
            ).json()
            failed = [r for r in result["results"] if not r["ok"]]
            if failed:
                lines = "\n".join(f"  {r['order_id']} — {r['error']['message']}" for r in failed[:20])
                raise DemoError(f"{len(failed)} commande(s) refusée(s) à la confirmation :\n{lines}")
            confirmed += result["confirmed"]
            warnings += sum(len(r["warnings"]) for r in result["results"])
        return confirmed, warnings

    # ----- calcul (F4)

    async def start_compute(self, day: date, params: dict[str, Any] | None = None) -> str:
        body = {"day": day.isoformat(), "params": params or None}
        return (await self.call("POST", "/plans/compute", "dispatcher", json=body, expected=(202,))).json()[
            "task_id"
        ]

    async def wait_task(self, task_id: str, timeout_s: float = 300.0) -> str:
        """Suit `GET /tasks/{id}` jusqu'à la fin ; renvoie l'identifiant du plan."""
        deadline = time.monotonic() + timeout_s
        shown = -1
        while True:
            task = (await self.call("GET", f"/tasks/{task_id}", "dispatcher")).json()
            if task["state"] == "succeeded":
                return task["plan_id"]
            if task["state"] == "failed":
                raise DemoError(f"Calcul en échec : {task['error']}")
            if task["progress"] != shown:
                shown = task["progress"]
                self.log(f"   … {shown:3d} % {task.get('message') or ''}")
            if time.monotonic() > deadline:
                raise DemoError(
                    f"Calcul non terminé après {timeout_s:.0f} s (état « {task['state']} ») : "
                    "un worker Celery tourne-t-il ?"
                )
            await asyncio.sleep(1.0)

    async def plan_digest(self, plan_id: str) -> dict[str, Any]:
        plan = (await self.call("GET", f"/plans/{plan_id}", "dispatcher")).json()
        return {
            "id": plan["id"],
            "status": plan["status"],
            "approximate": plan["approximate"],
            "trips": len(plan["trips"]),
            "trucks": len({t["truck_id"] for t in plan["trips"]}),
            "distance_km": round(sum(t["distance_m"] for t in plan["trips"]) / 1000, 1),
            "served": len(
                {d["order_id"] for t in plan["trips"] for s in t["stops"] for d in s["deliveries"]}
            ),
            "unserved": len(plan["unserved"]),
            "blocking": plan["blocking_count"],
            "warnings": plan["warning_count"],
            "computed_in_ms": plan["computed_in_ms"],
        }


def fixture_files(name: str, day: date | None = None) -> tuple[date, dict[str, bytes]]:
    """Fichiers à charger : ceux versionnés dans `<jeu>/import/`, ou reconstruits pour un autre jour."""
    problem = load_problem(name)
    if day is not None and day != problem.day:
        return day, export_fixture.build_files(problem, day)
    folder = export_fixture.import_dir(name)
    names = [*export_fixture.XLSX_FILES.values(), export_fixture.STOCKS_FILE, export_fixture.COMPUTE_FILE]
    missing = [n for n in names if not (folder / n).is_file()]
    if missing:
        raise DemoError(
            f"Fichiers absents de {folder} : {', '.join(missing)}. "
            f"Lancer d'abord : uv run python ../scripts/demo/export_fixture.py {name}"
        )
    return problem.day, {n: (folder / n).read_bytes() for n in names}


async def load_demo(
    api: DemoApi,
    name: str,
    *,
    day: date | None = None,
    admin: tuple[str, str] = DEFAULT_ADMIN,
    compute: bool = False,
) -> LoadSummary:
    """Charge le jeu `name` par l'API. `api.client` pointe sur `…/api/v1`."""
    log = api.log
    day, files = fixture_files(name, day)
    summary = LoadSummary(name=name, day=day)
    compute_info = json.loads(files[export_fixture.COMPUTE_FILE])
    stocks = json.loads(files[export_fixture.STOCKS_FILE])
    summary.compute_params = compute_info["params"]

    log(f"→ Connexion ({admin[0]}) et comptes de démonstration")
    await api.login("admin", *admin)
    summary.users_created = await api.ensure_demo_users()

    for kind in export_fixture.IMPORT_ORDER:
        filename = export_fixture.XLSX_FILES[kind]
        role = "dispatcher" if kind == ImportKind.ORDERS else "admin"
        params = {"day": day.isoformat()} if kind == ImportKind.ORDERS else {}
        started = time.perf_counter()
        batch = await api.import_file(kind.value, filename, files[filename], role, **params)
        summary.timings[f"import_{kind.value}"] = time.perf_counter() - started
        counts = batch["report"]["summary"]
        summary.imports[kind.value] = {k: counts[k] for k in ("created", "updated", "unchanged", "warnings")}
        log(
            f"→ Import {filename} : {counts['created']} créé(s), {counts['updated']} mis à jour, "
            f"{counts['unchanged']} inchangé(s), {counts['warnings']} avertissement(s)"
        )

    summary.stocks_entered = await api.put_depot_stocks(day, stocks["items"])
    log(f"→ Stocks dépôt du {day:%d/%m/%Y} : {summary.stocks_entered} couple(s) (dépôt, produit) saisis")
    summary.assignments = await api.put_driver_assignments(day, compute_info["driver_assignments"])
    if compute_info["driver_assignments"]:
        log(f"→ Affectations du jour camion → chauffeur : {summary.assignments} posée(s)")

    started = time.perf_counter()
    summary.orders_confirmed, summary.confirm_warnings = await api.confirm_draft_orders(day)
    summary.timings["confirm_orders"] = time.perf_counter() - started
    orders = await api.get_all("/orders", "dispatcher", day=day.isoformat())
    summary.orders_total = len(orders)
    for order in orders:
        summary.orders_by_status[order["status"]] = summary.orders_by_status.get(order["status"], 0) + 1
    log(
        f"→ Commandes du jour : {summary.orders_confirmed} confirmée(s) à l'instant "
        f"({summary.confirm_warnings} avertissement(s)) ; {summary.orders_total} au total "
        f"{summary.orders_by_status}"
    )

    if compute:
        log(f"→ Calcul du plan (paramètres du jeu : {summary.compute_params or 'défauts'})")
        started = time.perf_counter()
        task_id = await api.start_compute(day, summary.compute_params)
        plan_id = await api.wait_task(task_id)
        summary.timings["compute"] = time.perf_counter() - started
        summary.plan = await api.plan_digest(plan_id)
    return summary


def print_summary(summary: LoadSummary, log: Callable[[str], None] = print) -> None:
    log("")
    log(f"Jeu « {summary.name} » chargé pour le {summary.day:%d/%m/%Y}")
    for kind, counts in summary.imports.items():
        log(
            f"  {kind:<9} {counts['created']:>4} créé(s) {counts['updated']:>4} mis à jour "
            f"{counts['unchanged']:>4} inchangé(s)"
        )
    log(f"  stocks dépôt : {summary.stocks_entered} ; commandes : {summary.orders_by_status}")
    if summary.users_created:
        log(f"  comptes créés (mot de passe « {DEMO_PASSWORD} ») : {', '.join(summary.users_created)}")
    else:
        log(f"  comptes de démonstration déjà présents (mot de passe « {DEMO_PASSWORD} »)")
    if summary.plan:
        plan = summary.plan
        log(
            f"  plan {plan['id']} : {plan['trips']} tournée(s), {plan['trucks']} camion(s), "
            f"{plan['distance_km']} km, {plan['served']} commande(s) servie(s), {plan['unserved']} non "
            f"servie(s), {plan['blocking']} violation(s) bloquante(s), {plan['warnings']} avertissement(s)"
            + (" — distances approximatives (OSRM indisponible)" if plan["approximate"] else "")
        )
    else:
        log("  Étape suivante : POST /plans/compute (ou relancer avec --compute).")


async def _main(args: argparse.Namespace) -> None:
    base_url = args.base_url.rstrip("/")
    if not base_url.endswith("/api/v1"):
        base_url += "/api/v1"
    async with httpx.AsyncClient(base_url=base_url, timeout=120.0) as client:
        api = DemoApi(client)
        summary = await load_demo(
            api,
            args.name,
            day=args.day,
            admin=(args.admin_email, args.admin_password),
            compute=args.compute,
        )
    print_summary(summary)


def main() -> None:
    parser = argparse.ArgumentParser(description="Charge un jeu de démonstration par l'API de Tournéo.")
    parser.add_argument("name", choices=export_fixture.FIXTURES, help="jeu à charger")
    parser.add_argument("--base-url", default="http://localhost:8000", help="adresse de l'API")
    parser.add_argument("--day", type=date.fromisoformat, help="date des commandes et des stocks")
    parser.add_argument("--compute", action="store_true", help="lancer aussi le calcul du plan")
    parser.add_argument("--admin-email", default=os.environ.get("TOURNEO_ADMIN_EMAIL", DEFAULT_ADMIN[0]))
    parser.add_argument(
        "--admin-password", default=os.environ.get("TOURNEO_ADMIN_PASSWORD", DEFAULT_ADMIN[1])
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
