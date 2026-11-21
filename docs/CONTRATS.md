# Contrats entre modules

Ces interfaces permettent aux lots de travailler en parallèle. Les signatures existent déjà dans le code
(gabarits levant `NotImplementedError` tant que le lot propriétaire n'a pas livré). Un lot qui consomme une
interface non encore livrée la simule dans ses tests (monkeypatch). Toute évolution d'une signature se fait
ici d'abord.

## 1. Domaine du moteur — `backend/app/planning/domain.py` (socle, figé)

Structures pures : `Params`, `ProductD`, `CompartmentD`, `TruckD`, `DriverD`, `DepotD`, `StationD`, `OrderD`,
`Matrix`, `PlanningProblem` (entrées) ; `DeliveryD`, `StopD`, `CompartmentLoadD`, `TripD`, `UnservedD`,
`ViolationD`, `PlanningResult` (sorties).

- Identifiants : `str`. Temps : secondes entières depuis minuit local du jour J. Volumes : litres (`float`).
  Distances : mètres. Durées : secondes.
- Chronologie d'une tournée : `start_s` (arrivée au dépôt) → attente + chargement → `depart_s` → arrêts →
  `return_s`. Durée de service (RM-11) = `return_s − depart_s`.
- `arrival_s` d'un arrêt = début de service (après attente éventuelle de l'ouverture) ; `departure_s` =
  `arrival_s` + temps de dépotage.

## 2. Horaires — `backend/app/planning/timing.py` (socle, livré)

`schedule_trip(trip, problem, matrix, *, start_s=None) -> TripD` recalcule en place distances et heures d'une
tournée à partir de sa séquence d'arrêts. **Le moteur et l'édition manuelle passent tous deux par cette
fonction** : mêmes heures pour une même séquence. Aides : `stop_windows`, `lateness_s`.

## 3. Règles — `backend/app/planning/violations/` (lot L1)

Déjà livré par le socle dans `eligibility.py` (à réutiliser tel quel, y compris par le lot L4 pour F2.2/F2.3) :
`driver_block_reason(driver, day)` (RM-03), `driver_unavailable_reason(driver, day)`, `truck_block_reason(truck)` (RM-04)
— renvoient le motif en français ou `None`.

À livrer par le lot L1 dans `rules.py` :

```python
def check_plan(problem, trips, unserved=None, matrix=None) -> list[ViolationD]
def has_blocking(violations) -> bool
```

Une fonction publique par règle (`rm_01_…` à `rm_17_…`), pure, sur les structures du domaine. `check_plan` les
agrège. Messages en français, destinés au dispatcher. RM-12/RM-13 (chargement) sont dans `app/loading`,
RM-18 dans le service de plans, RM-19 dans `app/events`, RM-20 dans `app/core/time.py`.

## 4. Moteur — `backend/app/planning/engine/` (lot L2)

```python
ENGINE_VERSION: str
def solve(problem: PlanningProblem, matrix: Matrix, progress=None) -> PlanningResult
def assign_compartments(truck, volumes_by_product, safety_margin_pct) -> list[CompartmentLoadD] | None   # compartments.py
def build_matrix(nodes, params, *, osrm_url=None, cache=None, client=None) -> Matrix                    # distance_matrix.py
def problem_nodes(problem) -> list[tuple[str, float, float]]                                            # distance_matrix.py
def coord_hash(lat, lon) -> str
```

Jeux de données : `data/fixtures/<nom>/problem.json` (sérialisation de `PlanningProblem`) chargés par
`app/planning/fixtures.py` → `load_problem(name) -> PlanningProblem`, `dump_problem(problem, path)`.

## 5. Service de plans — `backend/app/planning/service.py` (lot L5)

`build_problem`, `persist_result`, `load_plan_trips`, `launch_compute`, `new_version`, `recheck_plan`
(signatures et docstrings dans le fichier). Les lots événements et comparaison passent par ces fonctions et
n'appellent jamais le moteur directement.

Ajouts du lot L5 (mêmes conventions) : `run_compute` / `run_recompute` (logique des tâches, avec session),
`launch_recompute`, `publish_plan`, `new_version_with_ids` (nouvelle version + correspondance ancien → nouvel
identifiant de tournée et d'arrêt, pour F6.1/F6.2), `order_remainders` (reliquat RM-16) ; `checking.load_plan`
et `checking.log_event` ; `views.plan_out` (plan complet de l'API). Modèle de versions : `planning/versions.py`.

## 6. Imports — `backend/app/imports/` (lot L3)

`ImportSource` (protocole de la spec §8.3) et `ExcelImportSource`, seule implémentation du MVP. Tout lot qui a
besoin de lire un fichier (ex. journée de référence, lot L7) ajoute son lecteur **dans `app/imports/`**.
Cycle d'un import : `POST /imports/{kind}/preview` → `import_batches` (rapport ligne par ligne + données
normalisées dans `report`) → `POST /imports/{batch_id}/apply`.

## 7. Conventions de l'API (tous les lots)

- Préfixe `/api/v1`, chemins et verbes de la spec §9, à la lettre.
- Noms de champs JSON en `snake_case`, identiques aux colonnes de la base.
- Identifiants : UUID. Volumes : nombres (`float` dans les schémas Pydantic, jamais de `Decimal` sérialisé en
  chaîne). Distances en mètres, durées en secondes (le front met en forme).
- Horodatages : ISO 8601 en UTC (`2027-01-12T06:30:00Z`). Heures seules (fenêtres de commande) : `"HH:MM"`,
  heure locale. Dates : `YYYY-MM-DD`.
- Position géographique : deux champs `lat` et `lon` (jamais de WKT/WKB dans l'API).
- Horaires d'ouverture : `{"mon": [["06:00","18:00"]], …, "sun": []}` (voir `app/core/time.py`).
- Listes : `Page[T]` = `{items, total, limit, offset}`, paramètres `limit` / `offset`, filtre `day=YYYY-MM-DD`
  quand pertinent. Référentiels : `deleted_at IS NULL` par défaut.
- Erreurs : `{code, message, details[]}` ; violations de règle : `details[].rule_code = "RM-xx"`.
- Rôles : lecture ouverte à tous les rôles authentifiés ; écriture selon le tableau de la spec §2
  (`admin` passe partout, `manager` en lecture seule).
- Chaque ressource en lecture renvoie les libellés utiles à l'affichage (ex. une tournée renvoie
  `truck_plate`, `driver_name`, `depot_code` en plus des identifiants) pour éviter les requêtes en cascade.
