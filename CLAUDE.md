# Tournéo — conventions de développement

Prototype de planification des tournées carburant pour OLA Energy Cameroun.
**À lire avant tout travail** : `docs/SPEC_MVP_Tourneo.md` (périmètre strict), `docs/PLAN.md` (lots, vagues,
qui possède quels fichiers), `docs/CONTRATS.md` (interfaces entre modules).

## Règles impératives (spec §0)

- Code : identifiants en **anglais** ; commentaires, messages d'interface, messages d'erreur et documentation en **français**.
- Ne rien implémenter de la section 4 de la spec (hors périmètre), même si c'est « facile ».
- Ne jamais inventer une règle métier absente de la spec : poser la question dans `docs/questions/<lot>.md`
  (un fichier par lot pour éviter les conflits de fusion), adopter une valeur par défaut raisonnable, continuer.
- Chaque règle métier RM-xx a un test unitaire qui la cite par son identifiant : `test_RM_07_compartiment_mono_produit`.
- Toute valeur paramétrable (seuils, durées, tolérances) vit dans la table `settings`
  (`app/core/settings_store.py` → `DEFAULTS`, et `Params` si le moteur ou les règles l'utilisent). Jamais en dur.
- Aucun fichier Excel/CSV n'est lu ailleurs que dans `backend/app/imports/` (critère d'acceptation 7).
- Toute la logique de contrainte est dans `backend/app/planning/violations/rules.py` : une seule source de vérité.
- Heures stockées en UTC, affichées en Africa/Douala (RM-20) — utiliser `app/core/time.py`.

## Mise en route

```bash
./scripts/dev_setup.sh          # PostGIS, Redis, bases tourneo / tourneo_test, uv sync, migrations, seed
cd backend && uv run pytest     # tests (base tourneo_test, chaque test annulé en fin de test)
cd backend && uv run ruff check . && uv run ruff format .
```

Pas de démon Docker dans les conteneurs cloud : PostgreSQL et Redis tournent en local ;
`docker-compose.yml` sert aux démos et à la production et ne peut pas y être exécuté.

## Socle à réutiliser (ne pas dupliquer)

| Besoin | Où |
|---|---|
| Modèles SQLAlchemy (tout le schéma de la spec §5) | `app/<module>/models.py`, agrégés dans `app/models.py` |
| Énumérations | `app/core/enums.py` (VARCHAR, pas d'ENUM natif : ajouter une valeur ne demande pas de migration) |
| Session, utilisateur courant, rôles, pagination | `app/core/deps.py` (`SessionDep`, `CurrentUser`, `require_roles`, `PageDep`, `Page[T]`) |
| Erreurs → enveloppe `{code, message, details[]}` | `app/core/errors.py` (`NotFoundError`, `ConflictError`, `RuleViolationError`…) |
| Temps, fenêtres d'ouverture | `app/core/time.py` |
| Géographie (lat/lon ↔ `location`) | `app/core/geo.py` |
| Paramètres | `app/core/settings_store.py` (`load_settings`, `get_setting`, `load_params`) |
| PDF | `app/core/pdf.py` (`render_pdf`) + gabarit `core/templates/pdf_base.html` à étendre |
| Audit + `created_by` | automatiques (`app/audit/listener.py`) : écrire via l'ORM, pas d'`update()` en masse sur les tables auditées |
| Domaine du moteur | `app/planning/domain.py` ; horaires d'une tournée : `app/planning/timing.py` |
| Tests | `tests/conftest.py` (`db`, `client`, `auth_headers`, `make_user`, `products`) |

Routeurs : créer `app/<module>/router.py` exposant `router = APIRouter(tags=[...])` — il est monté
automatiquement sous `/api/v1` (ne pas modifier `app/main.py`). Tâches Celery : `app/<module>/tasks.py`
(découverte automatique). Schémas Pydantic : `app/<module>/schemas.py`. Toutes les listes sont paginées (`Page[T]`).

## Travail en parallèle (lots)

- Chaque lot ne modifie que les fichiers qu'il possède (voir `docs/PLAN.md`). Besoin d'un changement dans le
  socle ou dans le lot d'un autre : faire le minimum, et le signaler clairement dans le compte rendu.
- Schéma de base : figé par la migration `0001`. Si une colonne manque vraiment : nouvelle migration Alembic
  `backend/alembic/versions/<lot>_<objet>.py` avec `down_revision = "0001"`, modèle mis à jour, et mention dans
  le compte rendu (les têtes multiples sont fusionnées à l'intégration).
- Dépendances : toutes celles de la spec sont déjà dans `backend/pyproject.toml`. N'en ajouter qu'en cas de
  nécessité, et le signaler.
- Un module qui dépend d'un autre lot non encore livré passe par les signatures de `docs/CONTRATS.md`
  et simule l'autre côté dans ses tests (monkeypatch).
- Avant de rendre : `uv run pytest` et `uv run ruff check .` au vert, commits clairs en français, branche poussée.
