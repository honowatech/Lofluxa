"""Lots d'import (F1.6, F3.2, F8.1) : prévisualiser puis appliquer."""

from sqlalchemy import Integer, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, IdMixin, TimestampMixin
from app.core.enums import ImportKind, ImportStatus, enum_col


class ImportBatch(Base, IdMixin, TimestampMixin):
    __tablename__ = "import_batches"

    kind: Mapped[ImportKind] = mapped_column(enum_col(ImportKind))
    filename: Mapped[str] = mapped_column(String(255))
    status: Mapped[ImportStatus] = mapped_column(enum_col(ImportStatus), default=ImportStatus.PREVIEWED)
    row_count: Mapped[int] = mapped_column(Integer, default=0)
    error_count: Mapped[int] = mapped_column(Integer, default=0)
    # Rapport ligne par ligne + données normalisées à appliquer.
    report: Mapped[dict] = mapped_column(JSONB, default=dict)
