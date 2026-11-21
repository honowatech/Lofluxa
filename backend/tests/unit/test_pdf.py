"""Socle PDF : résolution des gabarits et rendu."""

from app.core.pdf import build_env, render_pdf


def test_gabarit_resolu_par_chemin_complet_raccourci_de_module_et_nom_seul():
    env = build_env()
    full = env.get_template("core/templates/pdf_base.html")
    short = env.get_template("core/pdf_base.html")
    bare = env.get_template("pdf_base.html")
    assert full.filename == short.filename == bare.filename


def test_rendu_pdf_du_gabarit_de_base():
    pdf = render_pdf("core/pdf_base.html", {"company_name": "OLA Energy Cameroun"})
    assert pdf.startswith(b"%PDF")
