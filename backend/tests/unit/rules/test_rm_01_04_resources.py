"""RM-01 à RM-04 : ressources d'une tournée, chevauchements, affectabilité."""

from datetime import date

from app.core.enums import Severity, TruckStatus
from app.planning.violations import rules

from .builders import DAY, H, depot, driver, make_problem, severities, simple_trip, trip, truck

# ------------------------------------------------------------------ RM-01


def test_RM_01_tournee_avec_camion_chauffeur_depot_conforme():
    assert rules.rm_01_trip_resources(make_problem(), [simple_trip()]) == []


def test_RM_01_tournee_sans_chauffeur_bloquante():
    violations = rules.rm_01_trip_resources(make_problem(), [simple_trip(3, driver_id=None)])
    assert len(violations) == 1
    v = violations[0]
    assert (v.rule_code, v.severity, v.trip_seq) == ("RM-01", Severity.BLOCKING, 3)
    assert "aucun chauffeur" in v.message and "LT-001-AA" in v.message


def test_RM_01_tournee_sans_camion_ni_depot_bloquante():
    violations = rules.rm_01_trip_resources(make_problem(), [trip(1, truck_id="", depot_id="")])
    assert len(violations) == 2
    assert severities(violations) == ["blocking", "blocking"]
    assert "aucun camion" in violations[0].message
    assert "aucun dépôt" in violations[1].message


def test_RM_01_references_inconnues_du_referentiel_bloquantes():
    violations = rules.rm_01_trip_resources(
        make_problem(), [trip(1, truck_id="T?", driver_id="DR?", depot_id="D?")]
    )
    assert len(violations) == 3
    assert all("inconnu" in v.message for v in violations)


# ------------------------------------------------------------------ RM-02


def test_RM_02_tournees_successives_du_meme_camion_conformes():
    # La seconde tournée commence exactement au retour de la première : pas de chevauchement.
    first = trip(1, start_s=6 * H, depart_s=8 * H, return_s=11 * H)
    second = trip(2, start_s=11 * H, depart_s=13 * H, return_s=16 * H)
    assert rules.rm_02_no_overlap(make_problem(), [first, second]) == []


def test_RM_02_camion_sur_deux_tournees_qui_se_chevauchent():
    problem = make_problem(drivers=[driver("DR1"), driver("DR2", "Paul Etoa")])
    first = trip(1, start_s=6 * H, depart_s=8 * H, return_s=11 * H, driver_id="DR1")
    second = trip(2, start_s=10 * H, depart_s=12 * H, return_s=15 * H, driver_id="DR2")
    violations = rules.rm_02_no_overlap(problem, [second, first])
    assert len(violations) == 1
    v = violations[0]
    assert (v.rule_code, v.severity, v.trip_seq) == ("RM-02", Severity.BLOCKING, 2)
    assert "camion LT-001-AA" in v.message and "10:00" in v.message and "11:00" in v.message


def test_RM_02_chauffeur_sur_deux_tournees_qui_se_chevauchent():
    problem = make_problem(trucks=[truck("T1"), truck("T2", "LT-002-BB")])
    first = trip(1, truck_id="T1", start_s=6 * H, return_s=12 * H)
    second = trip(2, truck_id="T2", start_s=11 * H, depart_s=13 * H, return_s=16 * H)
    violations = rules.rm_02_no_overlap(problem, [first, second])
    assert len(violations) == 1
    assert "chauffeur Jean Mbarga" in violations[0].message


def test_RM_02_camions_et_chauffeurs_differents_en_parallele_conformes():
    problem = make_problem(
        trucks=[truck("T1"), truck("T2", "LT-002-BB")], drivers=[driver("DR1"), driver("DR2", "Paul")]
    )
    trips = [trip(1), trip(2, truck_id="T2", driver_id="DR2")]
    assert rules.rm_02_no_overlap(problem, trips) == []
    assert rules.trips_overlap(*trips)
    assert not rules.intervals_overlap(0, 10, 10, 20)


# ------------------------------------------------------------------ RM-03


def test_RM_03_chauffeur_en_regle_conforme():
    # Permis expirant le jour J : encore valable.
    problem = make_problem(drivers=[driver(license_expiry=DAY, hazmat_expiry=date(2028, 1, 1))])
    assert rules.rm_03_driver_eligible(problem, [simple_trip()]) == []


def test_RM_03_permis_expire_bloquant():
    problem = make_problem(drivers=[driver(license_expiry=date(2027, 1, 11))])
    violations = rules.rm_03_driver_eligible(problem, [simple_trip(2)])
    assert len(violations) == 1
    v = violations[0]
    assert (v.rule_code, v.severity, v.trip_seq) == ("RM-03", Severity.BLOCKING, 2)
    assert "Jean Mbarga" in v.message and "Permis" in v.message and "11/01/2027" in v.message


def test_RM_03_habilitation_matieres_dangereuses_expiree_bloquante():
    problem = make_problem(drivers=[driver(hazmat_expiry=date(2026, 12, 31))])
    violations = rules.rm_03_driver_eligible(problem, [simple_trip()])
    assert len(violations) == 1 and "Habilitation" in violations[0].message


def test_RM_03_chauffeur_indisponible_pour_la_journee_bloquant():
    problem = make_problem(drivers=[driver(available_today=False)])
    assert severities(rules.rm_03_driver_eligible(problem, [simple_trip()])) == ["blocking"]


def test_RM_03_filtre_des_chauffeurs_affectables():
    ok, expired, sick = driver("A"), driver("B", license_expiry=date(2020, 1, 1)), driver("C", status="sick")
    problem = make_problem(drivers=[ok, expired, sick])
    assert rules.assignable_drivers(problem) == [ok]
    assert rules.is_driver_assignable(ok, DAY) and not rules.is_driver_assignable(expired, DAY)


def test_RM_03_tournee_sans_chauffeur_ignoree():
    assert rules.rm_03_driver_eligible(make_problem(), [simple_trip(driver_id=None)]) == []


# ------------------------------------------------------------------ RM-04


def test_RM_04_camion_disponible_conforme():
    assert rules.rm_04_truck_eligible(make_problem(), [simple_trip()]) == []


def test_RM_04_camion_en_maintenance_ou_en_panne_bloquant():
    for status, word in ((TruckStatus.MAINTENANCE, "maintenance"), (TruckStatus.BROKEN, "panne")):
        problem = make_problem(trucks=[truck(status=status)])
        violations = rules.rm_04_truck_eligible(problem, [simple_trip()])
        assert len(violations) == 1
        v = violations[0]
        assert (v.rule_code, v.severity, v.trip_seq) == ("RM-04", Severity.BLOCKING, 1)
        assert "LT-001-AA" in v.message and word in v.message


def test_RM_04_camion_marque_indisponible_pour_la_journee_bloquant():
    problem = make_problem(trucks=[truck(available_today=False)])
    assert severities(rules.rm_04_truck_eligible(problem, [simple_trip()])) == ["blocking"]


def test_RM_04_filtre_des_camions_affectables():
    ok, broken = truck("T1"), truck("T2", "LT-002-BB", status=TruckStatus.BROKEN)
    off = truck("T3", "LT-003-CC", available_today=False)
    problem = make_problem(trucks=[ok, broken, off], depots=[depot()])
    assert rules.assignable_trucks(problem) == [ok]
    assert rules.is_truck_assignable(ok) and not rules.is_truck_assignable(broken)


def test_RM_04_camion_inconnu_ignore():
    assert rules.rm_04_truck_eligible(make_problem(), [simple_trip(truck_id="T?")]) == []
