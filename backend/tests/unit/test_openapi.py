"""Contrat de l'API : noms de schémas uniques (les types de l'interface en sont générés)."""

from app.main import app_instance


def test_aucun_nom_de_schema_en_double_dans_l_openapi():
    """Deux schémas Pydantic de même nom dans deux modules sont renommés par FastAPI en
    `app__<module>__schemas__<Nom>` : ces noms instables cassent les types générés de l'interface."""
    names = app_instance.openapi()["components"]["schemas"]
    duplicated = sorted(name for name in names if name.startswith("app__"))
    assert duplicated == [], f"schémas de même nom dans plusieurs modules : {duplicated}"
