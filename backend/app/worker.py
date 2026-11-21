"""Worker Celery (calcul des plans, génération PDF).

Les tâches sont découvertes automatiquement dans `app/<module>/tasks.py`.
Lancement : `celery -A app.worker.celery_app worker --loglevel=info`
"""

import pkgutil

from celery import Celery

import app
import app.audit.listener  # noqa: F401
import app.models  # noqa: F401
from app.core.config import get_config

_config = get_config()

celery_app = Celery("tourneo", broker=_config.redis_url, backend=_config.redis_url)
celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    result_expires=24 * 3600,
    task_always_eager=_config.celery_always_eager,
    task_eager_propagates=True,
    task_store_eager_result=True,
)
celery_app.autodiscover_tasks([f"app.{m.name}" for m in pkgutil.iter_modules(app.__path__) if m.ispkg])
