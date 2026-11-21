"""`ExcelImportSource` : respect du protocole `ImportSource` (spec §8.3) et lecture sans base de données."""

from datetime import date, time

from app.core.enums import OrderPriority, TruckSize
from app.imports.columns import SPECS
from app.imports.schemas import DeliveryOut
from app.imports.source import ExcelImportSource, ImportSource
from app.imports.templates import build_csv_template, build_template


def test_protocole_import_source():
    source = ExcelImportSource(b"", "vide.xlsx")
    assert isinstance(source, ImportSource)
    assert {"fetch_stations", "fetch_trucks", "fetch_drivers", "fetch_orders", "push_deliveries"} <= set(
        dir(ImportSource)
    )
    delivery = DeliveryOut(day=date(2027, 1, 12), station_code="ST1", product_code="SUPER", delivered_l=1000)
    result = source.push_deliveries([delivery])
    assert result.pushed == 0 and result.message  # sans effet dans le MVP


def test_lecture_des_modeles_xlsx_et_csv():
    for build, name in ((build_template, "f.xlsx"), (build_csv_template, "f.csv")):
        stations = ExcelImportSource(build(SPECS["stations"]), name)
        records = stations.fetch_stations()
        assert stations.issues == [] and stations.row_count == 3
        assert [(s.code, s.row, len(s.tanks)) for s in records] == [("ST-AKWA", 2, 2), ("ST-BONAB", 4, 1)]
        assert records[0].max_truck_size == TruckSize.MEDIUM
        assert [(t.row, t.product_code, t.capacity_l) for t in records[0].tanks] == [
            (2, "SUPER", 30000),
            (3, "GASOIL", 40000),
        ]

        trucks = ExcelImportSource(build(SPECS["trucks"]), name).fetch_trucks()
        assert [(t.plate, len(t.compartments)) for t in trucks] == [("LT 123 AB", 3), ("LT 456 CD", 1)]
        assert trucks[0].compartments[0].allowed_product_codes == "all"
        assert trucks[0].compartments[1].allowed_product_codes == ["SUPER", "GASOIL"]

        drivers = ExcelImportSource(build(SPECS["drivers"]), name).fetch_drivers()
        assert (
            drivers[0].license_expiry == date(2028, 6, 30) and drivers[0].default_truck_plate == "LT 123 AB"
        )

        assert [d.code for d in ExcelImportSource(build(SPECS["depots"]), name).fetch_depots()] == [
            "SCDP-DLA",
            "SCDP-YDE",
        ]

        orders = ExcelImportSource(build(SPECS["orders"]), name).fetch_orders(date(2027, 1, 12))
        assert len(orders) == 3
        assert orders[0].window_start == time(8, 0) and orders[1].priority == OrderPriority.URGENT


def test_fetch_orders_filtre_sur_la_journee():
    content = build_csv_template(SPECS["orders"])
    source = ExcelImportSource(content, "orders.csv")
    assert source.fetch_orders(date(2027, 1, 13)) == []
    assert [(i.row, i.column) for i in source.issues] == [(2, "Date"), (3, "Date"), (4, "Date")]


def test_anomalies_ligne_colonne_valeur_message():
    content = (
        "Code station;Nom;Latitude;Longitude;Inconnue;Produit;Capacité cuve (L)\n"
        "ST1;Un;4,05;9,70;x;SUPER;30000\n"
        "ST1;Deux;;;;GASOIL;\n"
        ";Sans code;4;9;;;\n"
        "ST2;Trois;abc;9;;;\n"
    ).encode()
    source = ExcelImportSource(content, "stations.csv")
    assert source.fetch_stations() == []
    assert source.row_count == 4
    found = {(i.row, i.column, i.severity) for i in source.issues}
    assert found == {
        (1, "Inconnue", "warning"),
        (3, "Nom", "error"),
        (3, "Capacité cuve (L)", "error"),
        (4, "Code station", "error"),
        (5, "Latitude", "error"),
    }
    latitude = next(i for i in source.issues if i.column == "Latitude")
    assert latitude.value == "abc" and latitude.message


def test_colonne_obligatoire_absente():
    source = ExcelImportSource(b"Nom;Latitude\nUn;4\n", "stations.csv")
    assert source.fetch_stations() == []
    assert [(i.row, i.column) for i in source.issues] == [(1, "Code station")]
    assert "obligatoire" in source.issues[0].message
