"""Envoi de la fiche de chargement par e-mail (F7.3) — SMTP de la bibliothèque standard.

Paramètres d'infrastructure `TOURNEO_SMTP_*` (voir `app/core/config.py`). Pas de SMS (hors périmètre).
"""

import smtplib
from email.message import EmailMessage

from app.core.config import get_config


def build_message(
    recipients: list[str], subject: str, body: str, attachment: bytes, filename: str, sender: str
) -> EmailMessage:
    message = EmailMessage()
    message["From"] = sender
    message["To"] = ", ".join(recipients)
    message["Subject"] = subject
    message.set_content(body)
    message.add_attachment(attachment, maintype="application", subtype="pdf", filename=filename)
    return message


def send_pdf(recipients: list[str], subject: str, body: str, attachment: bytes, filename: str) -> None:
    """Envoi synchrone, à appeler hors de la boucle d'événements. Lève `SMTPException` ou `OSError`."""
    config = get_config()
    message = build_message(recipients, subject, body, attachment, filename, config.smtp_from)
    with smtplib.SMTP(config.smtp_host, config.smtp_port, timeout=20) as smtp:
        if config.smtp_tls:
            smtp.starttls()
        if config.smtp_user:
            smtp.login(config.smtp_user, config.smtp_password)
        smtp.send_message(message)
