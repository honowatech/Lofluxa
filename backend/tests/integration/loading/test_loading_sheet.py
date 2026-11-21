"""F7.3, §11 — fiche de chargement PDF et envoi par e-mail (SMTP simulé)."""

import smtplib

import pytest

from app.core.config import get_config
from app.core.pdf import render_html
from app.loading import mailer, service, sheet
from app.loading.conversion import ASTM_NOTE
from tests.integration.loading.factory import make_trip_scenario


class FakeSMTP:
    """Faux transport SMTP : enregistre les messages au lieu de les envoyer."""

    instances: list["FakeSMTP"] = []
    fail_with: Exception | None = None

    def __init__(self, host, port, timeout=None):
        if FakeSMTP.fail_with is not None:
            raise FakeSMTP.fail_with
        self.host, self.port = host, port
        self.tls = False
        self.credentials = None
        self.messages = []
        FakeSMTP.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def starttls(self):
        self.tls = True

    def login(self, user, password):
        self.credentials = (user, password)

    def send_message(self, message):
        self.messages.append(message)


@pytest.fixture
def smtp(monkeypatch):
    FakeSMTP.instances = []
    FakeSMTP.fail_with = None
    monkeypatch.setattr(mailer.smtplib, "SMTP", FakeSMTP)
    return FakeSMTP


async def _load(client, auth_headers, scenario, **overrides):
    headers = await auth_headers("fleet")
    response = await client.post(
        f"/trips/{scenario.trip.id}/loading", json=scenario.loading_payload(**overrides), headers=headers
    )
    assert response.status_code == 200, response.text
    return headers


async def test_fiche_pdf_reellement_rendue(client, auth_headers, scenario):
    await _load(client, auth_headers, scenario)

    response = await client.get(
        f"/trips/{scenario.trip.id}/loading-sheet.pdf", headers=await auth_headers("manager")
    )

    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/pdf"
    assert "fiche-chargement-2027-01-12-LT-123-AB-T1.pdf" in response.headers["content-disposition"]
    assert response.content.startswith(b"%PDF")
    assert len(response.content) > 5000


async def test_contenu_de_la_fiche(client, db, auth_headers, scenario):
    lines = scenario.loading_payload()["lines"]
    # Compartiment 1 : 9 800 L à 28 °C → 9 800 × (1 − 0,0012 × 13) = 9 647,12 L → −3,53 % (RM-13).
    lines[0] = scenario.line(scenario.compartments[0], "SUPER", 9800, 28, density=0.7312)
    await _load(client, auth_headers, scenario, lines=lines)
    ctx = await service.load_trip_context(db, scenario.trip.id)

    context = await sheet.build_sheet_context(db, ctx)
    html = render_html(sheet.TEMPLATE, context)

    assert "Fiche de chargement" in html
    assert "OLA Energy Cameroun" in html
    for expected in (
        "LT-123-AB",  # camion
        "Jean Mbarga",  # chauffeur
        "SCDP-DLA — SCDP Douala",  # dépôt
        "BL-2027-0042",  # numéro de bon dépôt
        "12/01/2027",
        "Super",
        "Gasoil",
        "9 800,00 L",  # volume observé
        "28,0 °C",  # température
        "0,7312",  # densité
        "9 647,12 L",  # volume à 15 °C
        "−352,88 L",  # écart vs planifié
        "−3,53 %",
        "Avertissement RM-13",
        "ST-001 — OLA Akwa",  # séquence d'arrêts
        "ST-002 — OLA Bonabéri",
        "Mme Ngo",
        "09:30",  # heure estimée du premier arrêt (08:30 UTC → Africa/Douala)
        "Plan de chargement par compartiment",
        "10 500 L",  # capacité d'un compartiment
        "Heure de départ prévue",
        "08:15",  # départ prévu 07:15 UTC
        "Chauffeur",
        "Agent Fleet",
        "Gérant de station",
    ):
        assert expected in html, expected
    # Mention exacte de la spec §11.
    assert ASTM_NOTE in html
    assert context["rm_13_message"] is not None


async def test_fiche_sans_avertissement_quand_le_chargement_est_conforme(client, db, auth_headers, scenario):
    await _load(client, auth_headers, scenario)
    ctx = await service.load_trip_context(db, scenario.trip.id)
    html = render_html(sheet.TEMPLATE, await sheet.build_sheet_context(db, ctx))
    assert "Avertissement RM-13" not in html
    assert ASTM_NOTE in html


async def test_fiche_indisponible_sans_chargement_409(client, auth_headers, scenario):
    response = await client.get(
        f"/trips/{scenario.trip.id}/loading-sheet.pdf", headers=await auth_headers("fleet")
    )
    assert response.status_code == 409
    assert response.json()["code"] == "loading_missing"


async def test_fiche_tournee_inconnue_404_et_authentification(client, db, auth_headers, scenario):
    headers = await auth_headers("fleet")
    url = f"/trips/{scenario.trip.id}/loading-sheet.pdf"
    await db.commit()
    assert (await client.get(url)).status_code == 401
    unknown = "/trips/00000000-0000-0000-0000-000000000001/loading-sheet.pdf"
    assert (await client.get(unknown, headers=headers)).status_code == 404


async def test_envoi_aux_gerants_des_stations(client, auth_headers, scenario, smtp):
    headers = await _load(client, auth_headers, scenario)

    response = await client.post(f"/trips/{scenario.trip.id}/loading-sheet/email", headers=headers)

    assert response.status_code == 200, response.text
    assert response.json() == {
        "sent_to": ["gerant.akwa@example.cm", "gerant.bonaberi@example.cm"],
        "stations_without_email": [],
    }
    assert len(smtp.instances) == 1
    transport = smtp.instances[0]
    config = get_config()
    assert (transport.host, transport.port) == (config.smtp_host, config.smtp_port)
    assert transport.tls is False and transport.credentials is None
    (message,) = transport.messages
    assert message["From"] == config.smtp_from
    assert message["To"] == "gerant.akwa@example.cm, gerant.bonaberi@example.cm"
    assert message["Subject"] == "Fiche de chargement — LT-123-AB — 12/01/2027"
    (attachment,) = list(message.iter_attachments())
    assert attachment.get_content_type() == "application/pdf"
    assert attachment.get_filename() == "fiche-chargement-2027-01-12-LT-123-AB-T1.pdf"
    assert attachment.get_payload(decode=True).startswith(b"%PDF")
    assert "LT-123-AB" in message.get_body().get_content()


async def test_envoi_a_des_destinataires_fournis(client, auth_headers, scenario, smtp):
    headers = await _load(client, auth_headers, scenario)

    response = await client.post(
        f"/trips/{scenario.trip.id}/loading-sheet/email",
        json={"recipients": ["Direction@OLA.example", "direction@ola.example", "fleet@ola.example"]},
        headers=headers,
    )

    assert response.status_code == 200, response.text
    assert response.json()["sent_to"] == ["direction@ola.example", "fleet@ola.example"]
    assert smtp.instances[0].messages[0]["To"] == "direction@ola.example, fleet@ola.example"


async def test_station_sans_adresse_signalee(client, db, auth_headers, products, smtp):
    scenario = await make_trip_scenario(db, products, station_emails=("gerant.akwa@example.cm", None))
    headers = await _load(client, auth_headers, scenario)

    body = (await client.post(f"/trips/{scenario.trip.id}/loading-sheet/email", headers=headers)).json()

    assert body == {"sent_to": ["gerant.akwa@example.cm"], "stations_without_email": ["ST-002"]}


async def test_aucun_destinataire_422(client, db, auth_headers, products, smtp):
    scenario = await make_trip_scenario(db, products, station_emails=(None, "  "))
    headers = await _load(client, auth_headers, scenario)

    response = await client.post(f"/trips/{scenario.trip.id}/loading-sheet/email", headers=headers)

    assert response.status_code == 422
    assert response.json()["code"] == "no_recipient"
    assert smtp.instances == []


async def test_adresse_invalide_422(client, auth_headers, scenario, smtp):
    headers = await _load(client, auth_headers, scenario)
    response = await client.post(
        f"/trips/{scenario.trip.id}/loading-sheet/email",
        json={"recipients": ["pas-une-adresse"]},
        headers=headers,
    )
    assert response.status_code == 422
    assert smtp.instances == []


async def test_echec_smtp_502(client, auth_headers, scenario, smtp):
    headers = await _load(client, auth_headers, scenario)
    smtp.fail_with = ConnectionRefusedError("connexion refusée")

    response = await client.post(f"/trips/{scenario.trip.id}/loading-sheet/email", headers=headers)

    assert response.status_code == 502
    assert response.json()["code"] == "smtp_error"


async def test_envoi_sans_chargement_409(client, auth_headers, scenario, smtp):
    response = await client.post(
        f"/trips/{scenario.trip.id}/loading-sheet/email", headers=await auth_headers("fleet")
    )
    assert response.status_code == 409
    assert smtp.instances == []


@pytest.mark.parametrize(
    ("role", "expected"), [("dispatcher", 200), ("admin", 200), ("manager", 403), ("supply", 403)]
)
async def test_roles_sur_l_envoi(client, db, auth_headers, scenario, smtp, role, expected):
    await _load(client, auth_headers, scenario)
    headers = await auth_headers(role)
    url = f"/trips/{scenario.trip.id}/loading-sheet/email"
    await db.commit()
    assert (await client.post(url, headers=headers)).status_code == expected


def test_transport_smtp_tls_et_authentification(monkeypatch, smtp):
    config = get_config().model_copy(
        update={"smtp_tls": True, "smtp_user": "tourneo", "smtp_password": "secret", "smtp_host": "smtp.test"}
    )
    monkeypatch.setattr(mailer, "get_config", lambda: config)

    mailer.send_pdf(["a@example.cm"], "Sujet", "Corps", b"%PDF-1.7 test", "fiche.pdf")

    transport = smtp.instances[0]
    assert transport.host == "smtp.test"
    assert transport.tls is True
    assert transport.credentials == ("tourneo", "secret")
    assert transport.messages[0]["Subject"] == "Sujet"


def test_erreur_smtp_remontee_par_le_transport(smtp):
    smtp.fail_with = smtplib.SMTPConnectError(421, "indisponible")
    with pytest.raises(smtplib.SMTPException):
        mailer.send_pdf(["a@example.cm"], "Sujet", "Corps", b"%PDF", "fiche.pdf")
