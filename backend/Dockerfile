# Image du back-end Tournéo — la même pour les services `api` et `worker`.
# Contexte de construction : la racine du dépôt (voir docker-compose.yml et .dockerignore), car l'image
# embarque aussi data/ (fichiers modèles et jeux de démonstration), à côté de backend/ comme dans le dépôt.

FROM python:3.12-slim-bookworm AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TZ=UTC

# Bibliothèques système de WeasyPrint (Pango, HarfBuzz) et polices pour les PDF.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 \
        fonts-dejavu-core fonts-liberation2 \
        tzdata \
    && rm -rf /var/lib/apt/lists/*

# --- Dépendances Python (couche mise en cache tant que pyproject.toml et uv.lock ne changent pas) ---
FROM base AS deps

COPY --from=ghcr.io/astral-sh/uv:0.11.32 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/srv/tourneo/backend/.venv

WORKDIR /srv/tourneo/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# --- Sources (data/ est facultatif : le dossier est créé s'il n'existe pas encore dans le dépôt) ---
FROM base AS sources

COPY . /src
RUN mkdir -p /src/data

# --- Image finale ---
FROM base AS runtime

RUN groupadd --system --gid 10001 tourneo \
    && useradd --system --uid 10001 --gid tourneo --create-home --home-dir /home/tourneo tourneo

WORKDIR /srv/tourneo/backend
COPY --from=deps /srv/tourneo/backend/.venv ./.venv
COPY --from=sources /src/backend/pyproject.toml /src/backend/alembic.ini ./
COPY --from=sources /src/backend/alembic ./alembic
COPY --from=sources /src/backend/app ./app
COPY --from=sources /src/data /srv/tourneo/data
COPY --from=sources --chmod=755 /src/infra/api/start.sh /usr/local/bin/tourneo-api

ENV PATH="/srv/tourneo/backend/.venv/bin:$PATH" \
    HOME=/home/tourneo

USER tourneo
EXPOSE 8000

# Par défaut : l'API. Le service `worker` remplace la commande (voir docker-compose.yml).
CMD ["tourneo-api"]
