"""Environnement Alembic (URL lue depuis TOURNEO_DATABASE_URL)."""

from logging.config import fileConfig

from geoalchemy2 import alembic_helpers
from sqlalchemy import create_engine

import app.models  # noqa: F401
from alembic import context
from app.core.config import get_config
from app.core.db import Base

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_online() -> None:
    engine = create_engine(get_config().database_url)
    with engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            include_object=alembic_helpers.include_object,
            process_revision_directives=alembic_helpers.writer,
            render_item=alembic_helpers.render_item,
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()


run_migrations_online()
