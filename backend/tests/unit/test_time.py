"""RM-20 : heures stockées en UTC, affichées en Africa/Douala."""

from datetime import UTC, date, datetime

import pytest

from app.core.time import (
    format_local_hm,
    hm_to_seconds,
    opening_windows,
    seconds_to_hm,
    seconds_to_utc,
    utc_to_seconds,
)


def test_RM_20_stockage_utc_affichage_douala():
    day = date(2027, 1, 12)
    # 07:30 à Douala (UTC+1) = 06:30 UTC
    stored = seconds_to_utc(day, hm_to_seconds("07:30"))
    assert stored == datetime(2027, 1, 12, 6, 30, tzinfo=UTC)
    assert stored.tzinfo is UTC
    assert format_local_hm(stored) == "07:30"
    assert utc_to_seconds(day, stored) == 7 * 3600 + 30 * 60


def test_RM_20_horodatage_sans_fuseau_refuse():
    with pytest.raises(ValueError):
        format_local_hm(datetime(2027, 1, 12, 6, 30))


def test_fenetres_d_ouverture():
    hours = {"tue": [["06:00", "12:00"], ["14:00", "18:00"]], "sun": []}
    assert opening_windows(hours, date(2027, 1, 12)) == ((21600, 43200), (50400, 64800))  # mardi
    assert opening_windows(hours, date(2027, 1, 17)) == ()  # dimanche : fermé
    assert opening_windows(None, date(2027, 1, 12)) == ((0, 86400),)  # non renseigné : ouvert
    assert seconds_to_hm(50400) == "14:00"


def test_transaction_validee_avant_l_envoi_de_la_reponse():
    """La session d'une requête est validée avant l'envoi de la réponse (portée « function ») :
    un client qui relit aussitôt après une écriture voit la donnée."""
    from typing import get_args

    from app.core.deps import SessionDep

    assert get_args(SessionDep)[1].scope == "function"
