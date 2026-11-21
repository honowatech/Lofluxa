"""F8.1 — lecteur du fichier « journée de référence » (fonction pure, dans `app/imports/`)."""

from datetime import date, time
from pathlib import Path

from app.imports.reference_day import (
    build_template,
    build_workbook,
    normalize_key,
    read_reference_day,
)
from tests.integration.comparison.factory import example_workbook

TEMPLATE = Path(__file__).resolve().parents[4] / "data" / "templates" / "reference_day.xlsx"


def _issues(issues) -> set[tuple]:
    return {(i.sheet, i.row, i.column) for i in issues}


def test_classeur_complet_lu_sans_erreur():
    data = read_reference_day(example_workbook())

    assert data.errors == [] and data.warnings == []
    assert data.day == date(2027, 1, 12)
    assert data.prep_time_min == 120
    assert data.label == "Journée A — exemple"
    assert data.row_count == 9

    assert [(o.station_code, o.product_code, o.requested_l, o.priority) for o in data.orders] == [
        ("ST-DLA-001", "SUPER", 12000, "normal"),
        ("ST-DLA-001", "GASOIL", 8000, "normal"),
        ("ST-DLA-002", "GASOIL", 15000, "urgent"),
        ("ST-DLA-003", "SUPER", 10000, "normal"),
        ("ST-DLA-004", "PETROLE", 5000, "normal"),
    ]
    urgent = data.orders[2]
    assert (urgent.window_start, urgent.window_end, urgent.comment) == ("08:00", "12:00", "Rupture annoncée")

    first, second = data.trips
    assert (first.key, first.truck_plate, first.driver, first.depot_code) == (
        "1",
        "LT-123-AA",
        "Jean Mbarga",
        "SCDP-DLA",
    )
    assert (first.actual_km, first.depart_s, first.return_s) == (86, 7 * 3600 + 1800, 13 * 3600 + 600)
    assert [(s.order, s.station_code, len(s.deliveries)) for s in first.stops] == [
        (1, "ST-DLA-001", 2),
        (2, "ST-DLA-003", 1),
    ]
    assert (first.stops[0].arrival_s, first.stops[0].departure_s) == (8 * 3600 + 900, 9 * 3600)
    assert [(d.product_code, d.volume_l, d.row) for d in first.stops[0].deliveries] == [
        ("SUPER", 12000, 2),
        ("GASOIL", 8000, 3),
    ]
    assert (second.truck_plate, second.actual_km, len(second.stops)) == ("LT-456-BB", 54, 1)

    serialized = data.to_dict()
    assert serialized["day"] == "2027-01-12" and len(serialized["trips"]) == 2


def test_modele_du_depot_identique_au_generateur():
    """Le fichier livré dans data/templates/ est bien celui que produit `build_template`."""
    assert (
        read_reference_day(build_template()).to_dict() == read_reference_day(TEMPLATE.read_bytes()).to_dict()
    )


def test_tout_ce_qui_est_reel_est_facultatif_Q6():
    trips = [
        ("A", "LT-1", None, "DEP", 2, "S2", "GASOIL", 4000, None, None, None, None, None),
        ("A", None, None, None, 1, "S1", "GASOIL", "6 000,5", None, None, None, None, None),
    ]
    data = read_reference_day(build_workbook(day=date(2027, 1, 12), trips=trips))

    assert data.errors == []
    assert data.prep_time_min is None and data.label is None
    (trip,) = data.trips
    assert (trip.actual_km, trip.depart_s, trip.return_s, trip.driver) == (None, None, None, None)
    assert [s.station_code for s in trip.stops] == ["S1", "S2"]  # triés par ordre de passage
    assert trip.stops[0].deliveries[0].volume_l == 6000.5
    # Commandes déduites des tournées (demandé = livré), chauffeur manquant signalé.
    assert [(o.station_code, o.requested_l, o.row) for o in data.orders] == [
        ("S1", 6000.5, None),
        ("S2", 4000, None),
    ]
    assert _issues(data.warnings) == {("Tournées", 2, "Chauffeur"), ("Commandes", None, None)}


def test_heures_et_dates_dans_tous_les_formats():
    trips = [
        (1, "LT-1", "X", "DEP", 1, "S1", "SUPER", 1000, 12.5, time(7, 30), "13h05", "8:15", 0.375),
    ]
    data = read_reference_day(build_workbook(day="12/01/2027", prep_time_min="90", trips=trips))
    assert data.errors == []
    assert data.day == date(2027, 1, 12) and data.prep_time_min == 90
    (trip,) = data.trips
    assert (trip.depart_s, trip.return_s, trip.actual_km) == (27000, 13 * 3600 + 300, 12.5)
    assert (trip.stops[0].arrival_s, trip.stops[0].departure_s) == (8 * 3600 + 900, 9 * 3600)


def test_rapport_d_erreurs_ligne_par_ligne():
    orders = [
        ("S1", "SUPER", 12000, "normal", None, None, None),
        ("S1", "Super", 500, None, None, None, None),  # doublon (station, produit)
        ("S2", None, "beaucoup", "prioritaire", "08:00", None, None),
        (None, "GASOIL", -5, None, "10:00", "09:00", None),
    ]
    trips = [
        (1, "LT-1", "Jean", "DEP", 1, "S1", "SUPER", 12000, 80, "07:30", None, None, None),
        (
            1,
            "LT-2",
            None,
            None,
            1,
            "S1",
            "SUPER",
            100,
            85,
            "07:45",
            None,
            None,
            None,
        ),  # contradictions + doublon
        (
            1,
            None,
            None,
            None,
            1,
            "S9",
            "GASOIL",
            100,
            None,
            None,
            None,
            None,
            None,
        ),  # ordre 1 = autre station
        (1, None, None, None, 1.5, "S1", "GASOIL", 100, None, None, None, None, None),
        (None, "LT-3", None, "DEP", 1, "S1", "SUPER", 100, None, None, None, None, None),
        (2, None, "Paul", None, None, None, None, 0, "x", "25:00", None, None, None),
    ]
    data = read_reference_day(
        build_workbook(day="pas une date", prep_time_min="longtemps", orders=orders, trips=trips)
    )

    assert data.day is None
    assert _issues(data.errors) == {
        ("Journée", 1, "Date"),
        ("Journée", 2, "Temps de préparation (min)"),
        ("Commandes", 3, "Code station"),  # doublon
        ("Commandes", 4, "Produit"),
        ("Commandes", 4, "Volume demandé (L)"),
        ("Commandes", 4, "Priorité"),
        ("Commandes", 4, "Fenêtre début"),  # fenêtre incomplète
        ("Commandes", 5, "Code station"),
        ("Commandes", 5, "Volume demandé (L)"),
        ("Commandes", 5, "Fenêtre fin"),  # fin avant début
        ("Tournées", 3, "Camion"),
        ("Tournées", 3, "Km réels"),
        ("Tournées", 3, "Heure départ dépôt"),
        ("Tournées", 3, "Produit"),  # doublon de livraison
        ("Tournées", 4, "Ordre"),  # l'ordre 1 désigne déjà S1
        ("Tournées", 5, "Ordre"),  # non entier
        ("Tournées", 6, "Tournée"),
        ("Tournées", 7, "Km réels"),
        ("Tournées", 7, "Heure départ dépôt"),
        ("Tournées", 7, "Code station"),
        ("Tournées", 7, "Produit"),
        ("Tournées", 7, "Ordre"),
        ("Tournées", 7, "Volume livré (L)"),
        ("Tournées", 7, "Camion"),  # tournée 2 sans camion ni dépôt
        ("Tournées", 7, "Dépôt"),
    }
    messages = {(i.sheet, i.row, i.column): i.message for i in data.errors}
    assert messages[("Tournées", 3, "Camion")] == "Tournée 1 : « LT-2 » contredit « LT-1 » saisi plus haut."
    assert messages[("Commandes", 3, "Code station")].startswith(
        "Doublon : la station S1 a déjà une commande"
    )
    assert "Nombre attendu" in messages[("Commandes", 4, "Volume demandé (L)")]
    assert "HH:MM" in messages[("Tournées", 7, "Heure départ dépôt")]


def test_livraison_sans_commande_et_volume_superieur_au_demande():
    orders = [("S1", "SUPER", 10000, None, None, None, None)]
    trips = [
        (1, "LT-1", "Jean", "DEP", 1, "S1", "SUPER", 7000, None, None, None, None, None),
        (
            2,
            "LT-1",
            "Jean",
            "DEP",
            1,
            "S1",
            "SUPER",
            4000,
            None,
            None,
            None,
            None,
            None,
        ),  # cumul 11 000 > 10 000
        (2, None, None, None, 2, "S2", "GASOIL", 3000, None, None, None, None, None),  # pas de commande
    ]
    data = read_reference_day(build_workbook(day="2027-01-12", orders=orders, trips=trips))
    assert data.errors == []
    assert _issues(data.warnings) == {("Tournées", 2, "Volume livré (L)"), ("Tournées", 4, "Code station")}
    assert [(o.station_code, o.requested_l, o.row) for o in data.orders] == [
        ("S1", 10000, 2),
        ("S2", 3000, None),
    ]


def test_classeur_illisible_ou_incomplet():
    data = read_reference_day(b"pas un classeur")
    assert [i.message for i in data.errors] == ["Fichier illisible : un classeur Excel (.xlsx) est attendu."]

    from io import BytesIO

    from openpyxl import Workbook

    workbook = Workbook()
    workbook.active.title = "Autre"
    buffer = BytesIO()
    workbook.save(buffer)
    data = read_reference_day(buffer.getvalue())
    assert [i.message for i in data.errors] == ["Feuille « Tournées » absente du classeur."]

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "TOURNEES"  # nom de feuille reconnu sans accent ni casse
    sheet.append(["Tournée", "Camion", "Ordre"])
    sheet.append([1, "LT-1", 1])
    buffer = BytesIO()
    workbook.save(buffer)
    data = read_reference_day(buffer.getvalue())
    assert [i.message for i in data.errors] == [
        "Colonnes obligatoires absentes : depot, code_station, produit, volume_livre_l."
    ]

    empty = read_reference_day(build_workbook(day="2027-01-12"))
    assert [i.message for i in empty.errors] == ["Aucune tournée : la feuille est vide."]


def test_normalisation_des_en_tetes():
    assert normalize_key("Volume livré (L)") == "volume_livre_l"
    assert normalize_key("  Dépôt ") == "depot"
    assert normalize_key("lt-123-aa") == normalize_key("LT 123 AA")
