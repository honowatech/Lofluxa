"""Contexte de requête : utilisateur courant (pour `created_by` et le journal d'audit)."""

import uuid
from contextvars import ContextVar

current_user_id: ContextVar[uuid.UUID | None] = ContextVar("current_user_id", default=None)
