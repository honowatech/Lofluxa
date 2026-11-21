"""Affectabilité des ressources (RM-03, RM-04)."""

from datetime import date

from app.core.enums import TruckSize, TruckStatus
from app.planning.domain import CompartmentD, DriverD, TruckD
from app.planning.violations.eligibility import (
    driver_block_reason,
    driver_unavailable_reason,
    truck_block_reason,
)

DAY = date(2027, 1, 12)


def test_RM_03_permis_ou_habilitation_expires_non_affectable():
    ok = DriverD("d1", "Jean", license_expiry=date(2027, 1, 12), hazmat_expiry=date(2028, 1, 1))
    assert driver_block_reason(ok, DAY) is None  # expire le jour J : encore valable

    assert "Permis" in driver_block_reason(DriverD("d2", "Paul", license_expiry=date(2027, 1, 11)), DAY)
    assert "Habilitation" in driver_block_reason(DriverD("d3", "Luc", hazmat_expiry=date(2026, 12, 31)), DAY)
    assert "absente" in driver_block_reason(DriverD("d4", "Marc", hazmat_cert=False), DAY)
    assert driver_block_reason(DriverD("d5", "Date non renseignée"), DAY) is None


def test_chauffeur_indisponible_par_statut_ou_pour_la_journee():
    assert driver_unavailable_reason(DriverD("d1", "Jean", status="sick"), DAY)
    assert driver_unavailable_reason(DriverD("d2", "Paul", available_today=False), DAY)
    assert driver_unavailable_reason(DriverD("d3", "Luc"), DAY) is None


def test_RM_04_camion_en_maintenance_en_panne_ou_indisponible_non_affectable():
    compartments = (CompartmentD("c1", 1, 10000),)
    assert truck_block_reason(TruckD("t1", "LT-1", TruckSize.MEDIUM, compartments)) is None
    for status in (TruckStatus.MAINTENANCE, TruckStatus.BROKEN):
        assert truck_block_reason(TruckD("t", "LT-2", TruckSize.MEDIUM, compartments, status=status))
    assert truck_block_reason(TruckD("t3", "LT-3", TruckSize.MEDIUM, compartments, available_today=False))
