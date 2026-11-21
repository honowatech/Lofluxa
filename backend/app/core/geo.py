"""Aides géographiques : conversion lat/lon ↔ colonne `geography(Point, 4326)`."""

import math

from geoalchemy2.elements import WKBElement, WKTElement
from geoalchemy2.shape import to_shape


def point(lat: float, lon: float) -> WKTElement:
    """Valeur à affecter à une colonne `location` (attention : WKT = lon lat)."""
    return WKTElement(f"POINT({lon} {lat})", srid=4326)


def latlon(location: WKBElement | WKTElement | None) -> tuple[float, float] | None:
    """Colonne `location` → (lat, lon)."""
    if location is None:
        return None
    shape = to_shape(location)
    return (shape.y, shape.x)


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distance à vol d'oiseau en mètres."""
    radius = 6_371_000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))
