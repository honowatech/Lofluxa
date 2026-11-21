"""Matrice de distances : cache, client OSRM (transport httpx simulé), repli haversine (spec §7.2)."""

import httpx
import pytest

from app.core.geo import haversine_m
from app.planning.domain import Params
from app.planning.engine.distance_matrix import (
    InMemoryDistanceCache,
    build_matrix,
    coord_hash,
    haversine_matrix,
    problem_nodes,
)
from app.planning.engine.osrm_client import OsrmClient, OsrmError

from .helpers import make_problem, order, station, truck

NODES = [("DEP", 4.05, 9.70), ("S1", 4.10, 9.75), ("S2", 4.00, 9.80)]


def _osrm_handler(calls: list[httpx.Request]):
    """Faux serveur OSRM : distance = 1000 × (i + 2j + 1), durée = distance / 10."""

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        coords = request.url.path.rsplit("/", 1)[1].split(";")
        count = len(coords)
        sources = request.url.params.get("sources")
        rows = [int(i) for i in sources.split(";")] if sources else list(range(count))
        distances = [[0 if i == j else 1000.0 * (i + 2 * j + 1) + 0.4 for j in range(count)] for i in rows]
        durations = [[value / 10 for value in row] for row in distances]
        return httpx.Response(200, json={"code": "Ok", "distances": distances, "durations": durations})

    return handler


def _client(handler) -> OsrmClient:
    return OsrmClient("http://osrm.test:5000/", transport=httpx.MockTransport(handler))


def test_coord_hash_arrondi_a_5_decimales():
    assert coord_hash(4.050001, 9.700004) == coord_hash(4.05, 9.7)
    assert coord_hash(4.05001, 9.7) != coord_hash(4.05, 9.7)
    assert coord_hash(-0.000001, 0.0) == coord_hash(0.0, 0.0)
    assert len(coord_hash(4.05, 9.7)) == 40  # tient dans distance_cache.origin_hash


def test_repli_haversine_sans_osrm():
    params = Params(haversine_factor=1.3, default_avg_speed_kmh=40.0)
    matrix = build_matrix(NODES, params)
    assert matrix.approximate is True
    assert matrix.node_ids == ("DEP", "S1", "S2")
    expected = haversine_m(4.05, 9.70, 4.10, 9.75) * 1.3
    assert matrix.distance("DEP", "S1") == round(expected)
    assert matrix.duration("DEP", "S1") == round(expected / (40 / 3.6))
    assert matrix.distance("S1", "S1") == 0
    assert matrix.distance("S1", "DEP") == matrix.distance("DEP", "S1")


def test_client_osrm_table():
    calls: list[httpx.Request] = []
    distances, durations = _client(_osrm_handler(calls)).table([(4.05, 9.70), (4.10, 9.75)])
    assert distances == [[0, 3000], [2000, 0]]
    assert durations == [[0, 300], [200, 0]]
    request = calls[0]
    # OSRM attend « lon,lat » ; on demande distances et durées.
    assert request.url.path == "/table/v1/driving/9.700000,4.050000;9.750000,4.100000"
    assert request.url.params["annotations"] == "distance,duration"
    assert _client(_osrm_handler(calls)).table([]) == ([], [])


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(500, text="erreur"),
        httpx.Response(200, text="pas du json"),
        httpx.Response(200, json={"code": "NoTable"}),
        httpx.Response(200, json={"code": "Ok", "distances": [[0, 1]], "durations": [[0, 1], [1, 0]]}),
        httpx.Response(
            200, json={"code": "Ok", "distances": [[0, None], [1, 0]], "durations": [[0, 1], [1, 0]]}
        ),
    ],
)
def test_client_osrm_reponse_inexploitable(response):
    client = _client(lambda request: response)
    with pytest.raises(OsrmError):
        client.table([(4.05, 9.70), (4.10, 9.75)])


def test_client_osrm_injoignable():
    def handler(request):
        raise httpx.ConnectError("connexion refusée")

    with pytest.raises(OsrmError):
        _client(handler).table([(4.05, 9.70), (4.10, 9.75)])


def test_matrice_osrm_et_mise_en_cache():
    calls: list[httpx.Request] = []
    cache = InMemoryDistanceCache()
    client = _client(_osrm_handler(calls))
    matrix = build_matrix(NODES, Params(), client=client, cache=cache)
    assert matrix.approximate is False
    assert matrix.distance("DEP", "S2") == 5000 and matrix.duration("DEP", "S2") == 500
    assert matrix.distance("S2", "S1") == 5000
    assert len(calls) == 1 and len(cache) == 6

    # Deuxième calcul : tout vient du cache, OSRM n'est pas rappelé.
    again = build_matrix(NODES, Params(), client=client, cache=cache)
    assert len(calls) == 1
    assert again.distance_m == matrix.distance_m and again.duration_s == matrix.duration_s

    # Un nœud de plus : un seul appel, limité aux lignes manquantes (toutes ici : nouvelle colonne).
    build_matrix([*NODES, ("S3", 4.2, 9.9)], Params(), client=client, cache=cache)
    assert len(calls) == 2 and len(cache) == 12
    # Seule la ligne du nouveau nœud manque si le reste est déjà connu vers lui.
    hashes = {name: coord_hash(lat, lon) for name, lat, lon in [*NODES, ("S4", 4.3, 9.9)]}
    cache.put_many({(hashes[n], hashes["S4"]): (1, 1) for n in ("DEP", "S1", "S2")})
    build_matrix([*NODES, ("S4", 4.3, 9.9)], Params(), client=client, cache=cache)
    assert calls[-1].url.params["sources"] == "3"


def test_matrice_osrm_par_url(monkeypatch):
    calls: list[httpx.Request] = []
    transport = httpx.MockTransport(_osrm_handler(calls))
    original = httpx.Client

    def fake_client(**kwargs):
        kwargs["transport"] = transport
        return original(**kwargs)

    monkeypatch.setattr(httpx, "Client", fake_client)
    matrix = build_matrix(NODES, Params(), osrm_url="http://osrm.test:5000")
    assert matrix.approximate is False and len(calls) == 1


def test_repli_haversine_si_osrm_indisponible():
    cache = InMemoryDistanceCache()
    client = _client(lambda request: httpx.Response(503))
    matrix = build_matrix(NODES, Params(), client=client, cache=cache)
    assert matrix.approximate is True
    assert matrix.distance_m == haversine_matrix(NODES, Params()).distance_m
    assert len(cache) == 0  # les valeurs approchées ne polluent pas le cache


def test_matrice_jamais_d_exception_si_osrm_lent_ou_url_invalide():
    def slow(request):
        raise httpx.ReadTimeout("délai dépassé")

    assert build_matrix(NODES, Params(), client=_client(slow)).approximate is True
    # Appel tel que le fait le service de plans : URL de la configuration, hôte injoignable.
    assert build_matrix(NODES, Params(), osrm_url="http://127.0.0.1:1").approximate is True
    assert build_matrix(NODES, Params(), osrm_url="http://[invalide").approximate is True
    assert build_matrix([], Params(), osrm_url="http://127.0.0.1:1").node_ids == ()


def test_noeuds_d_un_probleme():
    problem, matrix = make_problem(
        stations=[station("S1", 4.10, 9.75), station("S2", 4.00, 9.80)],
        orders=[order("O1", "S1", 3000)],
        trucks=[truck("T")],
    )
    # Dépôts + stations concernées par les commandes du jour seulement.
    assert [n[0] for n in problem_nodes(problem)] == ["DEP", "S1"]
    assert matrix.node_ids == ("DEP", "S1")
