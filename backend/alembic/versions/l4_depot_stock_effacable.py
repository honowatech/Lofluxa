"""stocks dépôt : une saisie peut être effacée (available_l nul = non renseigné)

Revision ID: l4_depot_stock_effacable
Revises: 0001
"""

import sqlalchemy as sa

from alembic import op

revision = "l4_depot_stock_effacable"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "daily_depot_stocks", "available_l", existing_type=sa.Numeric(precision=12, scale=2), nullable=True
    )


def downgrade() -> None:
    op.execute("DELETE FROM daily_depot_stocks WHERE available_l IS NULL")
    op.alter_column(
        "daily_depot_stocks", "available_l", existing_type=sa.Numeric(precision=12, scale=2), nullable=False
    )
