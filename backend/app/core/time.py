"""Gestion du temps (RM-20) : stockage en UTC, affichage et raisonnement métier en Africa/Douala.

Le moteur et les règles raisonnent en « secondes depuis minuit local du jour J » (entiers).
La conversion vers des horodatages UTC se fait uniquement à la frontière avec la base.
"""

from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

DEFAULT_TZ = "Africa/Douala"

WEEKDAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def tz(name: str = DEFAULT_TZ) -> ZoneInfo:
    return ZoneInfo(name)


def utcnow() -> datetime:
    return datetime.now(UTC)


def local_midnight_utc(day: date, tz_name: str = DEFAULT_TZ) -> datetime:
    """Minuit local du jour J, exprimé en UTC."""
    return datetime.combine(day, time(0, 0), tzinfo=tz(tz_name)).astimezone(UTC)


def seconds_to_utc(day: date, seconds: int, tz_name: str = DEFAULT_TZ) -> datetime:
    """Secondes depuis minuit local du jour J → horodatage UTC (peut dépasser 24 h)."""
    return local_midnight_utc(day, tz_name) + timedelta(seconds=int(seconds))


def utc_to_seconds(day: date, moment: datetime, tz_name: str = DEFAULT_TZ) -> int:
    """Horodatage (avec fuseau) → secondes depuis minuit local du jour J."""
    if moment.tzinfo is None:
        raise ValueError("Horodatage sans fuseau : toutes les heures doivent être en UTC (RM-20).")
    return int((moment.astimezone(UTC) - local_midnight_utc(day, tz_name)).total_seconds())


def to_local(moment: datetime, tz_name: str = DEFAULT_TZ) -> datetime:
    if moment.tzinfo is None:
        raise ValueError("Horodatage sans fuseau : toutes les heures doivent être en UTC (RM-20).")
    return moment.astimezone(tz(tz_name))


def format_local_hm(moment: datetime, tz_name: str = DEFAULT_TZ) -> str:
    """Affichage `HH:mm` en heure locale."""
    return to_local(moment, tz_name).strftime("%H:%M")


def hm_to_seconds(value: str | time) -> int:
    """`"06:30"` ou `time(6, 30)` → 23400."""
    if isinstance(value, time):
        return value.hour * 3600 + value.minute * 60 + value.second
    hours, minutes = value.strip().split(":")[:2]
    return int(hours) * 3600 + int(minutes) * 60


def seconds_to_hm(seconds: int) -> str:
    seconds = int(seconds)
    return f"{seconds // 3600:02d}:{(seconds % 3600) // 60:02d}"


def opening_windows(opening_hours: dict | None, day: date) -> tuple[tuple[int, int], ...]:
    """Fenêtres d'ouverture du jour J, en secondes depuis minuit local.

    Format de `opening_hours` (colonnes jsonb `depots.opening_hours`, `stations.opening_hours`) :
        {"mon": [["06:00", "18:00"]], "tue": [["06:00", "12:00"], ["14:00", "18:00"]], ..., "sun": []}
    Clés : mon, tue, wed, thu, fri, sat, sun. Jour absent ou liste vide = fermé.
    `None` ou `{}` (horaires non renseignés) = ouvert toute la journée.
    """
    if not opening_hours:
        return ((0, 24 * 3600),)
    key = WEEKDAY_KEYS[day.weekday()]
    windows = []
    for start, end in opening_hours.get(key, []) or []:
        windows.append((hm_to_seconds(start), hm_to_seconds(end)))
    return tuple(sorted(windows))
