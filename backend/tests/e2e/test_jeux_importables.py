"""Jeux importables (`data/fixtures/<jeu>/import/`) et chargeur de démonstration.

- les fichiers versionnés sont ceux que produisent `export_fixture.py` et `make_reference_day.py` ;
- ils sont au format exact des modèles du lot L3 (mêmes feuilles, mêmes en-têtes) ;
- le chargeur est rejouable sans doublons, à tout moment de la journée ;
- `demo_shortage` importé par les fichiers donne bien des non-servies `depot_stock` (§7.5).
"""

from __future__ import annotations

from collections import Counter

import export_fixture
import load_demo
import make_reference_day
import pytest

from app.core.enums import ImportKind
from app.imports import columns
from app.imports.tabular import read_table
from app.planning.fixtures import load_problem
from tests.e2e.conftest import ADMIN, compute_day, load, published_day

REGENERATE = "régénérer : cd backend && uv run python ../scripts/demo/export_fixture.py --all"


@pytest.mark.parametrize("name", export_fixture.FIXTURES)
def test_fichiers_importables_versionnes_a_jour(name):
    """Les classeurs sont reproductibles à l'octet près : le fichier versionné = le fichier régénéré."""
    folder = export_fixture.import_dir(name)
    for filename, content in export_fixture.build_files(load_problem(name)).items():
        assert (folder / filename).read_bytes() == content, f"{name}/import/{filename} périmé — {REGENERATE}"


def test_journee_de_reference_versionnee_a_jour():
    content, summary = make_reference_day.build("demo_douala")
    path = export_fixture.import_dir("demo_douala") / make_reference_day.REFERENCE_FILE
    assert path.read_bytes() == content, "reference_day.xlsx périmé — relancer make_reference_day.py"
    assert summary["orders_served"] == summary["orders_total"] == 20 and summary["blocking"] == []


@pytest.mark.parametrize("name", export_fixture.FIXTURES)
@pytest.mark.parametrize("kind", export_fixture.IMPORT_ORDER)
def test_fichiers_au_format_exact_des_modeles(name, kind):
    """Même feuille et mêmes en-têtes, dans le même ordre, que le modèle `data/templates/<kind>.xlsx`
    (lecture par `app.imports.tabular`, seul lecteur de fichiers du projet)."""
    filename = export_fixture.XLSX_FILES[kind]
    spec = columns.SPECS[kind]
    table = read_table((export_fixture.import_dir(name) / filename).read_bytes(), filename, spec.sheet)
    template = read_table(
        (export_fixture.fixtures_dir().parent / "templates" / filename).read_bytes(), filename, spec.sheet
    )
    assert table.sheet == template.sheet == spec.sheet
    assert list(table.headers.values()) == list(template.headers.values()) == [c.header for c in spec.columns]
    problem = load_problem(name)
    expected = {
        ImportKind.DEPOTS: len(problem.depots),
        ImportKind.STATIONS: sum(len(t) for t in export_fixture.station_tanks(problem).values()),
        ImportKind.TRUCKS: sum(len(t.compartments) for t in problem.trucks),
        ImportKind.DRIVERS: len(problem.drivers),
        ImportKind.ORDERS: len(problem.orders),
    }[kind]
    assert len(table.rows) == expected


async def test_referentiels_importes_fideles_au_jeu(api):
    """Ce que l'API restitue après import est ce que contient `problem.json`."""
    await load(api, "demo_douala")
    problem = load_problem("demo_douala")

    depot = (await api.get_all("/depots", "manager"))[0]
    source = problem.depots[0]
    assert (depot["code"], depot["name"], depot["operator"]) == (source.code, source.name, "scdp")
    assert (depot["lat"], depot["lon"]) == pytest.approx((source.lat, source.lon), abs=1e-5)
    assert depot["avg_wait_min"] == 90 and depot["max_loadings_per_truck_day"] == 2
    assert depot["opening_hours"]["tue"] == [["06:00", "18:00"]]

    stations = {s["code"]: s for s in await api.get_all("/stations", "manager")}
    assert set(stations) == {s.code for s in problem.stations}
    for source in problem.stations:
        station = stations[source.code]
        assert (station["lat"], station["lon"]) == pytest.approx((source.lat, source.lon), abs=1e-5)
        assert station["max_truck_size"] == source.max_truck_size.value
        assert station["unload_time_min"] == source.unload_time_min
        assert (station["city"], station["region"]) == ("Douala", "Littoral")
        assert {t["product_code"] for t in station["tanks"]} >= {"SUPER", "GASOIL"}
    assert [s["code"] for s in stations.values() if s["max_truck_size"] == "small"] == ["DLA12"]

    trucks = {t["plate"]: t for t in await api.get_all("/trucks", "manager")}
    for source in problem.trucks:
        truck = trucks[source.plate]
        assert truck["size"] == source.size.value and truck["status"] == "available"
        assert [c["capacity_l"] for c in sorted(truck["compartments"], key=lambda c: c["position"])] == [
            c.capacity_l for c in source.compartments
        ]
        assert truck["total_capacity_l"] == source.total_capacity_l
    restricted = [c for t in trucks.values() for c in t["compartments"] if c["allowed_product_ids"]]
    assert len(restricted) == sum(1 for t in problem.trucks for c in t.compartments if c.allowed_product_ids)
    carriers = {c["name"]: c["type"] for c in await api.get_all("/carriers", "manager")}
    assert carriers == {"OLA Flotte": "own", "Sotracam": "third_party"}

    drivers = {d["license_no"]: d for d in await api.get_all("/drivers", "manager")}
    plates = {t.id: t.plate for t in problem.trucks}
    for source in problem.drivers:
        driver = drivers[export_fixture.license_no(source.id)]
        assert driver["full_name"] == source.full_name and driver["hazmat_cert"] is True
        assert driver["license_expiry"] == source.license_expiry.isoformat()
        assert driver.get("default_truck_plate") == plates.get(source.default_truck_id)

    orders = await api.get_all("/orders", "manager", day=problem.day.isoformat())
    by_ref = {o["comment"]: o for o in orders}
    station_codes = {s.id: s.code for s in problem.stations}
    for source in problem.orders:
        order = by_ref[source.id]
        assert order["station_code"] == station_codes[source.station_id]
        assert order["product_code"] == source.product_id and order["requested_l"] == source.requested_l
        assert order["priority"] == source.priority.value and order["source"] == "import"
    windowed = [o for o in orders if o["window_start"]]
    assert [(o["comment"], o["window_start"], o["window_end"]) for o in windowed] == [
        ("CMD012", "10:00", "11:00")
    ]
    assert Counter(o["priority"] for o in orders) == {"normal": 18, "urgent": 2}

    stocks = await api.get_all("/availability/depot-stocks", "manager", day=problem.day.isoformat())
    assert {s["product_code"]: s["available_l"] for s in stocks} == {
        "GASOIL": 64000,
        "PETROLE": 9000,
        "SUPER": 76000,
    }
    assert {s["entered_by_name"] for s in stocks} == {"Supply Démo"}  # saisi par le compte Supply


async def test_chargeur_rejouable_sans_doublons(api, db, tasks):
    """Rejoué avant le calcul, après la publication : rien n'est créé, modifié ni reconfirmé."""
    first, plan = await published_day(api, db, tasks)
    assert first.users_created and sum(v["created"] for v in first.imports.values()) == 42

    again = await load_demo.load_demo(api, "demo_douala", admin=ADMIN)
    assert again.users_created == []
    assert all(v["created"] == v["updated"] == 0 for v in again.imports.values()), again.imports
    assert again.imports["orders"]["unchanged"] == 20 and again.orders_confirmed == 0
    assert again.orders_total == 20 and again.orders_by_status == {"planned": 20}
    day = first.day.isoformat()
    history = await api.get_all("/availability/depot-stocks/history", "manager", day=day)
    assert len(history) == 3  # pas de nouvelle ligne d'historique pour une valeur identique
    assert len(await api.get_all("/stations", "manager")) == 12
    assert len(await api.get_all("/users", "admin")) == 5
    assert [p["id"] for p in await api.get_all("/plans", "manager", day=day)] == [plan["id"]]


async def test_chargeur_a_une_autre_date(api):
    """`--day` : commandes et stocks datés du jour voulu, référentiels inchangés."""
    from datetime import date

    other = date(2027, 2, 6)  # un samedi : les horaires exportés couvrent tous les jours
    await load(api, "demo_douala")
    summary = await load_demo.load_demo(api, "demo_douala", admin=ADMIN, day=other)
    assert summary.day == other and summary.imports["orders"]["created"] == 20
    assert summary.imports["stations"]["unchanged"] == 12 and summary.orders_confirmed == 20
    assert len(await api.get_all("/orders", "dispatcher", day=other.isoformat())) == 20
    assert len(await api.get_all("/orders", "dispatcher")) == 40


async def test_demo_shortage_par_les_fichiers_non_servies_depot_stock(api, db, tasks):
    """§7.5 : stock dépôt insuffisant sur le gasoil → `unserved` avec `reason_code = depot_stock`."""
    summary = await load(api, "demo_shortage")
    plan = await compute_day(api, db, tasks, summary)
    assert [(u["product_code"], u["reason_code"]) for u in plan["unserved"]] == [
        ("GASOIL", "depot_stock"),
        ("GASOIL", "depot_stock"),
    ]
    assert all(u["reason_text"] and u["priority"] == "normal" for u in plan["unserved"])
    gasoil = sum(
        d["planned_l"]
        for t in plan["trips"]
        for s in t["stops"]
        for d in s["deliveries"]
        if d["product_code"] == "GASOIL"
    )
    assert gasoil <= 30_000  # RM-08 : jamais plus que le stock saisi
    assert plan["blocking_count"] == 0 and plan["publishable"] is True  # aucune urgente laissée de côté

    published = (await api.call("POST", f"/plans/{plan['id']}/publish", "dispatcher")).json()
    assert published["status"] == "published"
    orders = await api.get_all("/orders", "dispatcher", day=summary.day.isoformat())
    assert Counter(o["status"] for o in orders) == {"planned": 18, "confirmed": 2}
    waiting = {o["id"] for o in orders if o["status"] == "confirmed"}
    assert waiting == {u["order_id"] for u in plan["unserved"]}  # elles attendent un prochain calcul
