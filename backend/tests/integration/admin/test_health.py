"""État de santé : `/health` (base, Redis) et `/health/osrm`."""

import httpx
import pytest

from app.admin import health as health_checks
from app.core.config import get_config


async def test_health_tout_va_bien(client):
    response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "checks": {"database": "ok", "redis": "ok"}}


async def test_health_sans_authentification(client):
    assert (await client.get("/health")).status_code == 200
    assert (await client.get("/health/osrm")).status_code == 200


async def test_health_redis_indisponible_mode_degrade(client, fake_redis):
    fake_redis.down = True
    response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "degrade", "checks": {"database": "ok", "redis": "indisponible"}}


async def test_health_base_indisponible_503(client, monkeypatch):
    async def _down(_session) -> bool:
        return False

    monkeypatch.setattr(health_checks, "check_database", _down)
    response = await client.get("/health")
    assert response.status_code == 503
    assert response.json() == {
        "status": "indisponible",
        "checks": {"database": "indisponible", "redis": "ok"},
    }


async def test_controle_de_la_base_reel(db):
    assert await health_checks.check_database(db) is True


def _mock_osrm(monkeypatch: pytest.MonkeyPatch, handler) -> list[httpx.Request]:
    requests: list[httpx.Request] = []

    def _record(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return handler(request)

    monkeypatch.setattr(
        health_checks, "osrm_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(_record))
    )
    return requests


async def test_health_osrm_ok(client, monkeypatch):
    requests = _mock_osrm(
        monkeypatch, lambda request: httpx.Response(200, json={"code": "Ok", "waypoints": []})
    )
    response = await client.get("/health/osrm")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "detail": None}
    # Appel simple au serveur OSRM configuré (service `nearest`, coordonnées longitude,latitude).
    assert str(requests[0].url).startswith(f"{get_config().osrm_url}/nearest/v1/driving/9.7043,4.0483")


@pytest.mark.parametrize(
    "handler",
    [
        lambda request: httpx.Response(500, text="erreur"),
        lambda request: httpx.Response(200, json={"code": "NoSegment"}),
        lambda request: httpx.Response(200, text="<html>pas du JSON</html>"),
    ],
)
async def test_health_osrm_reponse_anormale(client, monkeypatch, handler):
    _mock_osrm(monkeypatch, handler)
    response = await client.get("/health/osrm")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "indisponible" and body["detail"]


async def test_health_osrm_injoignable_ou_trop_lent(client, monkeypatch):
    def _refused(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connexion refusée", request=request)

    def _slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("trop lent", request=request)

    for handler, fragment in ((_refused, "injoignable"), (_slow, "délai")):
        _mock_osrm(monkeypatch, handler)
        body = (await client.get("/health/osrm")).json()
        assert body["status"] == "indisponible" and fragment in body["detail"]


async def test_health_osrm_vrai_appel_reseau_sur_port_ferme(client, monkeypatch):
    """Sans simulation : aucun serveur OSRM n'écoute, l'état est « indisponible » sans erreur 500."""
    monkeypatch.setattr(get_config(), "osrm_url", "http://127.0.0.1:1")
    response = await client.get("/health/osrm")
    assert response.status_code == 200
    assert response.json()["status"] == "indisponible"
