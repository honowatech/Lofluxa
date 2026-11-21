"""Jeux de données fictifs (spec §7.5) : composition, sérialisation, générateur à graine fixe."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

from app.core.enums import OrderPriority, TruckSize
from app.planning.domain import CompartmentLoadD, DeliveryD, StopD, TripD
from app.planning.engine.compartments import product_capacity_l
from app.planning.fixtures import (
    FIXTURES_ENV_VAR,
    dump_problem,
    fixtures_dir,
    load_problem,
    problem_from_dict,
    problem_to_dict,
)

ROOT = Path(__file__).resolve().parents[4]


def test_demo_douala_composition():
    problem = load_problem("demo_douala")
    assert len(problem.depots) == 1
    assert len(problem.stations) == 12
    assert len(problem.trucks) == 4
    assert len({t.size for t in problem.trucks}) == 2
    assert len({tuple(c.capacity_l for c in t.compartments) for t in problem.trucks}) > 1
    assert len(problem.drivers) == 5
    assert len(problem.products) == 3
    assert len(problem.orders) == 20
    assert sum(o.priority == OrderPriority.URGENT for o in problem.orders) == 2
    assert sum(s.max_truck_size != TruckSize.LARGE for s in problem.stations) == 1
    narrow = [o for o in problem.orders if o.window is not None]
    assert len(narrow) == 1 and narrow[0].window[1] - narrow[0].window[0] <= 3600
    # Tous les stocks sont renseignés : aucun avertissement RM-08 attendu.
    assert {(d.id, p.id) for d in problem.depots for p in problem.products} == set(problem.depot_stocks)


def test_demo_shortage_stock_insuffisant_sur_un_produit():
    problem = load_problem("demo_shortage")
    demand: dict[str, float] = {}
    for order in problem.orders:
        demand[order.product_id] = demand.get(order.product_id, 0.0) + order.requested_l
    short = [p for p, volume in demand.items() if problem.depot_stocks[("DEP-DLA", p)] < volume]
    assert short == ["GASOIL"]


def test_demo_scale_composition():
    problem = load_problem("demo_scale")
    assert len(problem.depots) == 2
    assert len(problem.stations) == 70
    assert len(problem.trucks) == 25
    assert len(problem.orders) == 120
    assert {o.station_id for o in problem.orders} == {s.id for s in problem.stations}
    # Faisable par construction : chaque commande tient dans un camion admis par sa station.
    margin = problem.params.compartment_safety_margin_pct
    for order in problem.orders:
        station = problem.station(order.station_id)
        assert any(
            t.size.rank <= station.max_truck_size.rank
            and product_capacity_l(t, order.product_id, margin) >= order.requested_l
            for t in problem.trucks
        )


@pytest.mark.parametrize("name", ["demo_douala", "demo_shortage", "demo_scale"])
def test_aller_retour_json(name, tmp_path):
    problem = load_problem(name)
    path = dump_problem(problem, tmp_path / name)
    assert path == tmp_path / name / "problem.json"
    assert load_problem(path) == problem
    assert json.loads(path.read_text(encoding="utf-8")) == problem_to_dict(problem)


def test_aller_retour_avec_tournees_verrouillees_et_affectations(tmp_path):
    problem = load_problem("demo_douala")
    problem.driver_by_truck = {"CAM02": "CH05"}
    problem.locked_trips = [
        TripD(
            seq=3,
            truck_id="CAM01",
            depot_id="DEP-DLA",
            driver_id="CH01",
            start_s=21600,
            depart_s=29700,
            return_s=36000,
            distance_m=12000,
            duration_s=6300,
            locked=True,
            ref="trip-1",
            stops=[
                StopD(1, "DLA01", 30000, 32400, 800, [DeliveryD("CMD001", "SUPER", 6000.0)], ref="stop-1")
            ],
            loads=[
                CompartmentLoadD("CAM01-C1", "SUPER", 5880.0),
                CompartmentLoadD("CAM01-C2", "SUPER", 120.0),
            ],
        )
    ]
    path = dump_problem(problem, tmp_path / "copie.json")
    assert load_problem(path) == problem
    assert problem_from_dict(problem_to_dict(problem)) == problem


def test_repertoire_des_jeux_surchargeable(monkeypatch, tmp_path):
    assert fixtures_dir() == ROOT / "data" / "fixtures"
    monkeypatch.setenv(FIXTURES_ENV_VAR, str(tmp_path))
    dump_problem(
        load_problem(ROOT / "data" / "fixtures" / "demo_douala" / "problem.json"), tmp_path / "copie"
    )
    assert len(load_problem("copie").orders) == 20


def test_generateur_a_graine_fixe_reproduit_les_jeux_versionnes():
    done = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "gen_fixtures.py"), "--check"],
        capture_output=True,
        text=True,
        cwd=ROOT / "backend",
        check=False,
    )
    assert done.returncode == 0, done.stdout + done.stderr
