"""Génération PDF commune (WeasyPrint + gabarits HTML/Jinja2).

Chaque module place ses gabarits dans `app/<module>/templates/` et étend `pdf_base.html`
(en-tête OLA avec logo paramétrable, pied de page, styles communs).

    pdf_bytes = render_pdf("loading/loading_sheet.html", {"trip": ...})
"""

from datetime import datetime
from pathlib import Path
from typing import Any

from jinja2 import (
    BaseLoader,
    ChoiceLoader,
    Environment,
    FileSystemLoader,
    TemplateNotFound,
    select_autoescape,
)

from app.core.time import format_local_hm, seconds_to_hm, to_local

APP_DIR = Path(__file__).resolve().parent.parent


def _fmt_liters(value: Any) -> str:
    if value is None:
        return "—"
    return f"{float(value):,.0f}".replace(",", " ") + " L"


def _fmt_km(meters: Any) -> str:
    if meters is None:
        return "—"
    return f"{float(meters) / 1000:,.1f}".replace(",", " ").replace(".", ",") + " km"


def _fmt_hm(value: Any) -> str:
    if value is None:
        return "—"
    if isinstance(value, datetime):
        return format_local_hm(value)
    return seconds_to_hm(int(value))


def _fmt_date(value: Any) -> str:
    if value is None:
        return "—"
    if isinstance(value, datetime):
        value = to_local(value)
    return value.strftime("%d/%m/%Y")


def _fmt_duration(seconds: Any) -> str:
    if seconds is None:
        return "—"
    seconds = int(seconds)
    return f"{seconds // 3600} h {(seconds % 3600) // 60:02d}"


class ModuleTemplateLoader(BaseLoader):
    """Raccourci "<module>/x.html" → app/<module>/templates/x.html."""

    def get_source(self, environment: Environment, template: str):
        module, _, name = template.partition("/")
        path = APP_DIR / module / "templates" / name
        if not name or not path.is_file():
            raise TemplateNotFound(template)
        mtime = path.stat().st_mtime
        return path.read_text(encoding="utf-8"), str(path), lambda: path.stat().st_mtime == mtime


def build_env() -> Environment:
    """Résolution des gabarits, dans l'ordre :
    1. chemin complet depuis `app/` : "loading/templates/loading_sheet.html" ;
    2. raccourci par module : "loading/loading_sheet.html" ;
    3. nom seul, cherché dans tous les dossiers `templates/` : "pdf_base.html".
    """
    template_dirs = sorted(p for p in APP_DIR.glob("*/templates") if p.is_dir())
    loader = ChoiceLoader(
        [FileSystemLoader(APP_DIR), ModuleTemplateLoader(), FileSystemLoader(template_dirs)]
    )
    env = Environment(loader=loader, autoescape=select_autoescape(["html"]))
    env.filters.update(liters=_fmt_liters, km=_fmt_km, hm=_fmt_hm, date_fr=_fmt_date, duration=_fmt_duration)
    return env


_env: Environment | None = None


def render_html(template: str, context: dict[str, Any]) -> str:
    global _env
    if _env is None:
        _env = build_env()
    return _env.get_template(template).render(**context)


def render_pdf(template: str, context: dict[str, Any]) -> bytes:
    """Rend un gabarit en PDF. `context` peut fournir `company_name` et `logo_url` (paramètres)."""
    from weasyprint import HTML  # import tardif : chargement lourd

    html = render_html(template, context)
    return HTML(string=html, base_url=str(APP_DIR)).write_pdf()
