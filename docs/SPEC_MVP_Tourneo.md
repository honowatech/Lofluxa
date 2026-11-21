# SPEC MVP — Tournéo (nom de code provisoire)
## Logiciel de planification des tournées de livraison carburant — OLA Energy Cameroun

Version 1.0 — 21 novembre 2026 — Honowa Technologies
Document destiné à l'équipe de développement (et à Claude Code). Il décrit le périmètre strict du prototype (Étape 1), le modèle de données, les règles métier, l'API, les écrans, la stack, l'organisation du dépôt et les critères d'acceptation. Tout ce qui n'est pas listé dans la section 3 est hors périmètre.

---

## 0. Instructions pour Claude Code

- Langue du code : identifiants en anglais, commentaires, messages d'interface et documentation en français.
- Ne pas implémenter ce qui est listé en section 4 (hors périmètre), même si c'est « facile ». Lever une question dans `docs/QUESTIONS.md` plutôt qu'inventer une règle métier absente de ce document.
- Chaque règle métier de la section 6 doit avoir un test unitaire qui la cite par son identifiant (ex. `test_RM_07_compartiment_mono_produit`).
- Le moteur de tournées (section 7) doit fonctionner et être testé sur le jeu de données fictif `data/fixtures/demo_douala/` avant toute intégration front.
- Avancer par jalons (section 12), chaque jalon se termine par une démo lançable avec `docker compose up`.
- Toute valeur paramétrable (seuils, durées, tolérances) vit dans la table `settings`, jamais en dur dans le code.

---

## 1. Contexte en dix lignes

OLA Energy Cameroun livre du carburant (super, gasoil, pétrole lampant) à environ 70 stations-service dans 10 régions à partir de dépôts de chargement (principalement SCDP Douala, puis SCDP Yaoundé). Chaque matin un dispatcher construit les tournées à la main sur Excel : quel camion, quel chauffeur, quel dépôt, quelles stations, quels volumes. Le prototype doit produire ce plan automatiquement, permettre au dispatcher de le corriger, enregistrer le chargement réel au dépôt (densité, température, volume) et démontrer, sur deux journées comparées, que le plan calculé est meilleur que le plan manuel (moins de kilomètres, moins de camions, toutes les stations livrées).

Le logiciel n'est connecté à aucun ERP dans le prototype : les données entrent par import Excel/CSV et saisie manuelle, derrière une couche d'import isolée qui sera remplacée plus tard par un connecteur SAGE 200 ACCPAC puis SAP.

---

## 2. Utilisateurs et rôles

| Rôle | Qui | Ce qu'il fait dans le MVP |
|---|---|---|
| `dispatcher` | Dispatcher Douala | Saisit/importe les commandes, lance le calcul, ajuste le plan, publie le plan du jour, enregistre les événements (panne, réaffectation) |
| `fleet` | Agent Fleet au dépôt | Enregistre le chargement réel (densité, température, volumes par compartiment), passe les statuts chargé/livré |
| `supply` | Agent Supply | Saisit le stock disponible par dépôt et par produit chaque matin |
| `manager` | Mme Medjo, direction | Consultation, tableau comparatif A/B, exports PDF |
| `admin` | Honowa | Référentiels, utilisateurs, paramètres |

Authentification par e-mail + mot de passe, JWT (access 15 min, refresh 7 jours), rôles portés dans le token. Pas de SSO, pas d'inscription libre : les comptes sont créés par `admin`.

---

## 3. Périmètre fonctionnel du MVP (ce qu'on construit)

### F1 — Référentiels
- F1.1 Produits : code, libellé, densité de référence à 15 °C (kg/L), couleur d'affichage.
- F1.2 Dépôts : code, nom, exploitant (SCDP / interne / tiers), coordonnées GPS, horaires d'ouverture par jour de semaine, temps moyen d'attente au chargement (minutes, paramétrable), nombre max de chargements par camion et par jour.
- F1.3 Stations : code, nom, région, ville, coordonnées GPS, horaires de réception, par produit : capacité de cuve (L), stock de sécurité (L), accessibilité (gabarit maximal de camion accepté : `small` / `medium` / `large`), temps de dépotage moyen (minutes).
- F1.4 Camions : immatriculation, transporteur (propre / tiers + nom), gabarit (`small` / `medium` / `large`), capacité totale (L), liste des compartiments avec capacité (L) et produit compatible (tous ou liste), vitesse moyenne de référence (km/h, par défaut valeur paramétrée), statut (`available`, `maintenance`, `broken`, `reserved`), coût kilométrique indicatif (FCFA/km, facultatif).
- F1.5 Chauffeurs : nom, téléphone, numéro de permis, date d'expiration du permis, habilitation matières dangereuses (oui/non + date d'expiration), transporteur, statut (`available`, `rest`, `leave`, `sick`), camion habituel (facultatif).
- F1.6 Import des référentiels F1.2 à F1.5 depuis des fichiers Excel (modèles fournis dans `data/templates/`), avec rapport d'erreurs ligne par ligne, sans écraser silencieusement : mode « prévisualiser » puis « appliquer ».

### F2 — Disponibilité du jour
- F2.1 Stock disponible par dépôt et par produit pour la date J (saisie Supply, en litres), avec heure de saisie et auteur. Une saisie remplace la précédente pour le même (dépôt, produit, date) en gardant l'historique.
- F2.2 Disponibilité des camions pour J : liste des camions `available` avec possibilité de les marquer indisponibles pour la journée (motif).
- F2.3 Disponibilité des chauffeurs pour J : idem, plus contrôle automatique : permis ou habilitation expirés → chauffeur non affectable (bloquant, avec message).
- F2.4 Affectation chauffeur ↔ camion par défaut (reprend le camion habituel, modifiable).

### F3 — Commandes du jour
- F3.1 Saisie manuelle d'une commande : station, produit, volume demandé (L), priorité (`normal`, `urgent`), fenêtre de livraison souhaitée (facultatif), commentaire.
- F3.2 Import Excel/CSV des commandes du jour (modèle fourni), même logique prévisualiser/appliquer.
- F3.3 Statuts : `draft`, `confirmed`, `planned`, `loaded`, `delivered`, `cancelled`, `postponed`.
- F3.4 Contrôle à la confirmation : volume demandé ≤ (capacité de cuve − stock de sécurité) si le stock station est renseigné, sinon avertissement non bloquant.

### F4 — Calcul automatique du plan de tournées
- F4.1 Bouton « Calculer le plan » sur une date J : prend toutes les commandes `confirmed`, les camions et chauffeurs disponibles, les stocks dépôt, et produit un plan (`plan` en statut `draft`).
- F4.2 Le plan est composé de tournées (`trip`) : un camion, un chauffeur, un dépôt de chargement, une séquence ordonnée d'arrêts (`stop`) avec, par arrêt, les volumes livrés par produit et par compartiment, les heures estimées d'arrivée et de départ, la distance et la durée cumulées.
- F4.3 Un camion peut effectuer plusieurs tournées dans la journée (retour au dépôt, rechargement) dans la limite du paramètre F1.2 et de la durée maximale de service (paramètre, défaut 11 h).
- F4.4 Les commandes que le moteur ne peut pas servir (pas de camion, pas de produit, fenêtre impossible) sont listées comme `unserved` avec la raison. Elles ne disparaissent jamais silencieusement.
- F4.5 Temps de calcul cible : < 60 s pour 70 stations, 25 camions, 120 commandes. Le calcul tourne en tâche de fond ; l'interface affiche la progression et peut être rafraîchie.
- F4.6 Le plan garde une trace de la version du moteur, des paramètres utilisés et de l'instant de calcul (reproductibilité).

### F5 — Ajustement manuel et publication
- F5.1 Vue carte + vue tableau du plan. Glisser-déposer d'un arrêt d'une tournée à une autre, réordonnancement des arrêts dans une tournée, changement de camion ou de chauffeur sur une tournée.
- F5.2 Chaque modification manuelle recalcule immédiatement distances, durées, heures estimées, taux de remplissage, et affiche les violations de contraintes (rouge bloquant / orange avertissement) sans empêcher la sauvegarde d'un plan avec avertissements. Les violations bloquantes empêchent la publication.
- F5.3 « Recalculer en conservant » : relance le moteur en figeant les tournées marquées verrouillées par le dispatcher.
- F5.4 Publication du plan (`published`) : fige la version, passe les commandes en `planned`, génère la feuille de route PDF par camion (section 9) et le tableau de bord de la journée.
- F5.5 Historique des versions d'un plan (qui a changé quoi, quand), restauration d'une version.

### F6 — Événements du jour (contraintes OLA)
- F6.1 Panne de camion : sur une tournée publiée, action « camion en panne » → choix d'un camion de remplacement disponible (et chauffeur), transfert des arrêts non encore livrés, recalcul, nouvelle version du plan, journalisation.
- F6.2 Chauffeur indisponible : même mécanique côté chauffeur.
- F6.3 Produit indisponible au dépôt : mise à jour du stock par Supply → le système signale les tournées impactées (volume prévu > stock restant), le dispatcher choisit : réduire, reporter (`postponed`), ou changer de dépôt. Alerte visible côté Fleet et Supply.
- F6.4 Tous les événements sont horodatés dans `events` et visibles dans un journal de la journée.

### F7 — Chargement au dépôt (Fleet)
- F7.1 Pour chaque tournée, l'agent Fleet enregistre le chargement réel : heure d'arrivée au dépôt, heure de début et de fin de chargement, par compartiment : produit, volume observé (L), température observée (°C), densité observée (kg/L), numéro du bon de chargement dépôt.
- F7.2 Le système calcule le volume à 15 °C (règle RM-12) et l'écart avec le volume planifié.
- F7.3 Génération de la fiche de chargement PDF (une par tournée) destinée aux gérants de station : camion, chauffeur, dépôt, produits, volumes observés et à 15 °C, température, densité, heure de départ, séquence d'arrêts. Téléchargeable et envoyable par e-mail (SMTP) ; le SMS n'est pas dans le MVP.
- F7.4 Statuts de tournée : `planned` → `at_depot` → `loaded` → `in_progress` → `completed` ; par arrêt : `pending` → `delivered` / `skipped` (motif). Saisie manuelle de l'heure réelle de livraison et du volume livré par le dispatcher ou Fleet.

### F8 — Journée A / Journée B et tableau de bord
- F8.1 Mode « journée de référence » : import d'une journée réellement effectuée (commandes, tournées réelles telles que le dispatcher les a faites, km réels si connus) → stockée comme plan `manual_reference`.
- F8.2 Rejeu : lancement du moteur sur les mêmes commandes/ressources que la journée de référence → plan `replay`.
- F8.3 Journée B : plan calculé et exécuté en réel, avec saisie des réalisations (F7.4).
- F8.4 Tableau comparatif entre deux plans quelconques : km totaux (estimés et réels), nombre de camions mobilisés, nombre de chauffeurs, nombre de tournées, stations livrées / demandées, volumes livrés / demandés, durée totale de service, taux de remplissage moyen, nombre de violations, temps de préparation du plan (saisi à la main pour le manuel). Écart en valeur et en %.
- F8.5 Export PDF du tableau comparatif avec les deux cartes côte à côte.
- F8.6 Tableau de bord du jour : avancement des tournées, retards estimés, alertes actives.

### F9 — Administration et paramètres
- F9.1 Gestion des utilisateurs et rôles.
- F9.2 Paramètres (`settings`) : vitesse moyenne par défaut, durée max de service, temps d'attente dépôt par défaut, temps de dépotage par défaut, marge de sécurité sur la capacité des compartiments (%), tolérance d'écart volume chargé/planifié (%), coefficient de dilatation par produit, heure de début de journée, fuseau horaire (Africa/Douala).
- F9.3 Journal d'audit : toute écriture sur `plans`, `trips`, `loadings`, `stocks` et `settings`.

---

## 4. Hors périmètre (ne pas coder)

- Connecteur SAGE 200 ACCPAC ou SAP (seule l'interface d'import `ImportSource` est prévue, voir 8.3).
- Géofencing, suivi GPS temps réel, application mobile chauffeur.
- Envoi SMS/WhatsApp automatique aux gérants (option chiffrée séparément).
- Alertes de pénurie à 15 jours et projection de stock (option).
- Cession ou vente de produit (fonction ERP).
- Facturation, coûts réels de transport, gestion des contrats transporteurs.
- Réconciliation de stock pétrolier (wet stock) et pertes/gains.
- Multi-société, multi-pays, multi-langue (français uniquement).
- SSO / Active Directory.
- Haute disponibilité, montée en charge au-delà de 200 stations.

---

## 5. Modèle de données (PostgreSQL 16 + PostGIS)

Conventions : `id` UUID v7, `created_at`, `updated_at`, `created_by` partout ; suppression logique (`deleted_at`) sur les référentiels ; géométries en `geography(Point, 4326)` ; volumes en litres (`numeric(12,2)`), distances en mètres (`integer`), durées en secondes (`integer`), argent en FCFA (`integer`).

```
products(id, code UNIQUE, label, ref_density_15 numeric(6,4), thermal_coeff numeric(8,6), color)
depots(id, code UNIQUE, name, operator, location geography, address, opening_hours jsonb, avg_wait_min int, max_loadings_per_truck_day int, active bool)
stations(id, code UNIQUE, name, region, city, location geography, opening_hours jsonb, max_truck_size enum, unload_time_min int, active bool)
station_tanks(id, station_id FK, product_id FK, capacity_l, safety_stock_l, UNIQUE(station_id, product_id))
carriers(id, name, type enum(own, third_party), contact)
trucks(id, plate UNIQUE, carrier_id FK, size enum(small, medium, large), total_capacity_l, avg_speed_kmh, status enum, cost_per_km int NULL, notes)
truck_compartments(id, truck_id FK, position int, capacity_l, allowed_product_ids uuid[] NULL)  -- NULL = tous produits
drivers(id, full_name, phone, license_no, license_expiry date, hazmat_cert bool, hazmat_expiry date NULL, carrier_id FK, status enum, default_truck_id FK NULL)

daily_depot_stocks(id, depot_id FK, product_id FK, day date, available_l, entered_at, entered_by, UNIQUE(depot_id, product_id, day, entered_at))
daily_resource_status(id, day date, truck_id FK NULL, driver_id FK NULL, available bool, reason text, CHECK(truck_id IS NOT NULL OR driver_id IS NOT NULL))

orders(id, day date, station_id FK, product_id FK, requested_l, priority enum, window_start time NULL, window_end time NULL, comment, status enum, source enum(manual, import), import_batch_id FK NULL)

plans(id, day date, kind enum(computed, manual_reference, replay), status enum(draft, published, archived), version int, parent_plan_id FK NULL, engine_version text, params_snapshot jsonb, computed_at, computed_in_ms int, created_by)
trips(id, plan_id FK, seq int, truck_id FK, driver_id FK, depot_id FK, planned_depart_at, planned_return_at, distance_m, duration_s, locked bool, status enum, actual_depart_at NULL, actual_return_at NULL, actual_distance_m NULL)
trip_compartment_loads(id, trip_id FK, compartment_id FK, product_id FK, planned_l)
stops(id, trip_id FK, seq int, station_id FK, planned_arrival_at, planned_departure_at, distance_from_prev_m, status enum, actual_arrival_at NULL, actual_departure_at NULL, skip_reason NULL)
stop_deliveries(id, stop_id FK, order_id FK, product_id FK, planned_l, actual_l NULL)
unserved_orders(id, plan_id FK, order_id FK, reason_code enum, reason_text)
constraint_violations(id, plan_id FK, trip_id FK NULL, stop_id FK NULL, rule_code text, severity enum(blocking, warning), message)

loadings(id, trip_id FK UNIQUE, depot_id FK, arrived_at, started_at, finished_at, depot_ticket_no, entered_by)
loading_lines(id, loading_id FK, compartment_id FK, product_id FK, observed_l, observed_temp_c numeric(5,2), observed_density numeric(6,4), volume_15_l numeric(12,2) GENERATED/computed, planned_l)

events(id, day date, plan_id FK NULL, trip_id FK NULL, type enum(truck_breakdown, driver_unavailable, product_shortage, manual_edit, publish, replan, loading_recorded, delivery_recorded), payload jsonb, occurred_at, actor_id FK)
import_batches(id, kind enum(stations, trucks, drivers, depots, orders, reference_day), filename, status enum(previewed, applied, rejected), row_count, error_count, report jsonb, created_by)
settings(key PK, value jsonb, description, updated_by, updated_at)
users(id, email UNIQUE, password_hash, full_name, role enum, active bool, last_login_at)
audit_log(id, table_name, row_id, action, before jsonb, after jsonb, actor_id, at)
distance_cache(origin_hash, dest_hash, distance_m, duration_s, computed_at, PRIMARY KEY(origin_hash, dest_hash))
```

Index : `orders(day, status)`, `trips(plan_id)`, `stops(trip_id, seq)`, `events(day, occurred_at)`, GIST sur toutes les `location`.

---

## 6. Règles métier (identifiants à citer dans les tests)

| Code | Règle | Sévérité |
|---|---|---|
| RM-01 | Une tournée a exactement un camion, un chauffeur, un dépôt de chargement. | Bloquant |
| RM-02 | Un camion ou un chauffeur ne peut pas être sur deux tournées qui se chevauchent dans le temps. | Bloquant |
| RM-03 | Un chauffeur dont le permis ou l'habilitation matières dangereuses est expiré à la date J n'est pas affectable. | Bloquant |
| RM-04 | Un camion en statut `maintenance` ou `broken`, ou marqué indisponible pour J, n'est pas affectable. | Bloquant |
| RM-05 | La somme des volumes chargés dans un compartiment ≤ capacité du compartiment × (1 − marge de sécurité, défaut 2 %). | Bloquant |
| RM-06 | Un compartiment ne contient qu'un seul produit par tournée. | Bloquant |
| RM-07 | Un compartiment ne reçoit qu'un produit figurant dans sa liste autorisée (si définie). | Bloquant |
| RM-08 | Le volume total planifié d'un produit au départ d'un dépôt pour J ≤ stock disponible saisi pour (dépôt, produit, J). Si aucun stock saisi : avertissement « stock non renseigné ». | Bloquant / Avertissement |
| RM-09 | Une station n'est livrée que par un camion de gabarit ≤ son gabarit maximal accepté. | Bloquant |
| RM-10 | Arrivée estimée à une station dans ses horaires de réception, et dans la fenêtre de la commande si elle existe ; dépassement ≤ 30 min toléré en avertissement, au-delà bloquant. | Avertissement / Bloquant |
| RM-11 | Durée de service d'une tournée (départ dépôt → retour dépôt) et cumul journalier par chauffeur ≤ durée max de service (défaut 11 h). | Bloquant |
| RM-12 | Volume à 15 °C = volume observé × [1 − coefficient_produit × (température observée − 15)]. Coefficients par défaut : super 0,00120 /°C, gasoil 0,00085 /°C, pétrole lampant 0,00095 /°C (paramétrables dans `products.thermal_coeff`). Si une densité observée est saisie, elle est stockée et affichée mais n'entre pas dans le calcul du MVP (les tables ASTM complètes sont hors périmètre ; le noter dans l'interface). | — |
| RM-13 | Écart entre volume à 15 °C chargé et volume planifié au-delà de la tolérance (défaut 2 %) → avertissement sur la tournée et mention sur la fiche de chargement. | Avertissement |
| RM-14 | Un camion ne dépasse pas `max_loadings_per_truck_day` du dépôt. | Bloquant |
| RM-15 | Une commande `urgent` doit être servie ; si le moteur ne peut pas, elle apparaît en tête des `unserved` et bloque la publication tant qu'elle n'est pas reportée explicitement. | Bloquant |
| RM-16 | Une commande ne peut être livrée que dans un volume ≤ volume demandé ; la livraison partielle est autorisée si ≥ 50 % du demandé (paramètre), le reste restant `confirmed` pour un recalcul. | Avertissement |
| RM-17 | Une tournée verrouillée (`locked`) n'est pas modifiée par un recalcul. | — |
| RM-18 | Toute modification d'un plan `published` crée une nouvelle version ; la version publiée précédente est archivée, jamais écrasée. | — |
| RM-19 | Une panne de camion transfère uniquement les arrêts en statut `pending` ; les arrêts déjà `delivered` restent sur la tournée d'origine. | — |
| RM-20 | Toutes les heures sont stockées en UTC et affichées en Africa/Douala. | — |

---

## 7. Moteur de tournées

### 7.1 Formulation
Problème de tournées de véhicules avec capacités multi-compartiments, fenêtres horaires, flotte hétérogène, multi-dépôts et multi-tournées par véhicule (CVRPTW multi-compartiment, multi-trip). Implémentation avec **Google OR-Tools, module Routing** (Python).

### 7.2 Entrées
- Matrice distances/durées entre tous les nœuds (dépôts + stations concernées par les commandes du jour), obtenue via OSRM (`/table`), mise en cache dans `distance_cache` (clé = hash des coordonnées arrondies à 5 décimales). Repli si OSRM indisponible : distance haversine × 1,3 et vitesse moyenne paramétrée, avec un drapeau `approximate=true` sur le plan.
- Commandes confirmées, camions et chauffeurs disponibles (après RM-03/RM-04), stocks dépôt, paramètres.

### 7.3 Modélisation
- Un « véhicule » OR-Tools = (camion, numéro de tournée dans la journée), jusqu'à `max_loadings_per_truck_day` véhicules virtuels par camion, chaînés par une contrainte de précédence temporelle (la tournée n+1 démarre après le retour de la tournée n + temps d'attente dépôt).
- Capacité : une dimension par produit par véhicule virtuel, bornée par la somme des capacités des compartiments compatibles ; l'affectation fine aux compartiments est faite en post-traitement par un algorithme glouton (plus gros volume → plus gros compartiment compatible), avec vérification RM-05/06/07 ; si l'affectation échoue, la commande est retirée du véhicule et le solveur est relancé une fois avec cette exclusion.
- Temps : dimension temps avec fenêtres (horaires station, fenêtre commande, horaires dépôt), temps de service = temps de dépotage station, temps de chargement dépôt = paramètre.
- Fonction objectif (pondérations dans `settings`, défauts) : distance totale × 1 + nombre de véhicules utilisés × coût fixe (équivalent 40 km) + pénalité de commande non servie (normale : 500 km, urgente : 5 000 km).
- Stratégie : première solution `PATH_CHEAPEST_ARC`, métaheuristique `GUIDED_LOCAL_SEARCH`, limite de temps paramétrée (défaut 45 s), arrêt anticipé si pas d'amélioration pendant 10 s.
- Affectation des chauffeurs en post-traitement : chauffeur habituel du camion si disponible, sinon premier chauffeur disponible du même transporteur, en respectant RM-02 et RM-11.

### 7.4 Sorties
Plan complet (trips, stops, stop_deliveries, trip_compartment_loads, unserved_orders, constraint_violations), métriques agrégées, journal de résolution (temps, itérations, statut du solveur).

### 7.5 Tests du moteur
- Jeu `demo_douala` : 1 dépôt, 12 stations, 4 camions (2 gabarits, compartiments différents), 5 chauffeurs, 3 produits, 20 commandes dont 2 urgentes, 1 station à gabarit limité, 1 fenêtre horaire étroite. Attendus : toutes les commandes servies, violations = 0, solution ≤ 10 s.
- Jeu `demo_shortage` : stock dépôt insuffisant sur un produit → `unserved` avec `reason_code = depot_stock`.
- Jeu `demo_scale` : 70 stations, 25 camions, 120 commandes générées aléatoirement avec graine fixe → solution < 60 s, aucune violation bloquante.
- Test de déterminisme : même entrée + même graine → même sortie.

---

## 8. Architecture et stack

### 8.1 Composants
```
[ React SPA ] ⇄ HTTPS ⇄ [ Caddy ] ⇄ [ FastAPI (API + workers) ] ⇄ [ PostgreSQL 16 + PostGIS ]
                                              │                      [ Redis ] (file de tâches + cache)
                                              └────── HTTP ─────────▶ [ OSRM ] (profil camion, extrait OSM Cameroun)
```
Un seul `docker-compose.yml` : `caddy`, `api`, `worker`, `db`, `redis`, `osrm`, `frontend` (build statique servi par Caddy), `backup` (pg_dump quotidien vers un volume + rétention 14 jours).

### 8.2 Back-end
- Python 3.12, FastAPI, SQLAlchemy 2 (async) + Alembic, Pydantic v2, OR-Tools, httpx, Celery (broker Redis) pour le calcul et la génération PDF, WeasyPrint pour les PDF (gabarits HTML/Jinja2), openpyxl/pandas pour les imports, python-jose pour JWT, passlib (argon2) pour les mots de passe, structlog pour les logs JSON.
- Organisation en modules métier (pas en couches techniques globales) :
```
backend/app/
  core/        config, sécurité, db, settings loader, time (tz)
  referentials/  products, depots, stations, trucks, drivers (+ import)
  availability/  stocks dépôt, statuts jour
  orders/
  planning/      engine/ (or_tools_solver.py, compartments.py, distance_matrix.py, osrm_client.py, objective.py), plans, trips, violations (rules.py = une fonction par RM-xx)
  events/        panne, réaffectation, pénurie
  loading/       chargements, conversion 15 °C, fiche PDF
  comparison/    métriques, A/B, export PDF
  imports/       ImportSource (interface), ExcelImportSource, batches, templates
  auth/, users/, audit/
tests/           unit/ (rules, engine, conversion), integration/ (API), fixtures/
```
- Toute la logique de contrainte est dans `planning/violations/rules.py`, appelée à la fois par le moteur (filtrage) et par l'édition manuelle (contrôle) : une seule source de vérité.

### 8.3 Couche d'import isolée (préparation ACCPAC/SAP)
```python
class ImportSource(Protocol):
    def fetch_stations(self) -> list[StationIn]: ...
    def fetch_trucks(self) -> list[TruckIn]: ...
    def fetch_drivers(self) -> list[DriverIn]: ...
    def fetch_orders(self, day: date) -> list[OrderIn]: ...
    def push_deliveries(self, deliveries: list[DeliveryOut]) -> PushResult: ...   # no-op dans le MVP
```
`ExcelImportSource` est la seule implémentation du MVP. Le futur `AccpacImportSource` (SAGE 300 Web API / SQL) et `SapImportSource` (OData) respecteront le même protocole. Aucune autre partie du code ne lit un fichier Excel.

### 8.4 Front-end
- React 18 + TypeScript + Vite, React Router, TanStack Query (données) et TanStack Table (tableaux), Zustand (état du plan en édition), MapLibre GL JS (carte, tuiles OSM auto-hébergées ou fournisseur libre), dnd-kit (glisser-déposer), react-hook-form + zod (formulaires), date-fns-tz, Tailwind CSS + composants shadcn/ui, i18n non nécessaire (français en dur, textes centralisés dans `src/i18n/fr.ts` pour faciliter une future traduction).
- Build statique servi par Caddy ; API consommée en `/api/v1`.

### 8.5 Infrastructure
- VPS 4 vCPU / 8 Go / 80 Go SSD, Ubuntu 24.04, Docker + Compose, Caddy avec HTTPS automatique (Let's Encrypt), domaine de test fourni par OLA ou Honowa.
- OSRM : extrait `cameroon-latest.osm.pbf` (Geofabrik), profil `truck` (vitesses réduites, évite les voies interdites aux poids lourds si taguées), prétraitement `osrm-extract` / `osrm-contract` dans une image dédiée ; rafraîchissement mensuel.
- Sauvegardes : `pg_dump` quotidien 02:00, copie hors serveur hebdomadaire (rclone vers un stockage objet au nom d'OLA ou de Honowa selon accord).
- Journaux : stdout JSON, rotation Docker ; pas de pile d'observabilité dans le MVP.
- Sécurité minimale : HTTPS, mots de passe argon2, JWT courts, CORS strict, rate limiting sur `/auth`, en-têtes de sécurité Caddy, sauvegardes chiffrées, aucun secret dans le dépôt (`.env` + `.env.example`).

---

## 9. API (FastAPI, préfixe `/api/v1`, OpenAPI généré)

Principales ressources (toutes paginées, filtrables par `day` quand pertinent, protégées par rôle) :

```
POST   /auth/login  /auth/refresh  /auth/logout
GET    /me

CRUD   /products  /depots  /stations  /stations/{id}/tanks  /carriers  /trucks  /trucks/{id}/compartments  /drivers
POST   /imports/{kind}/preview        (multipart xlsx/csv) → batch_id + rapport
POST   /imports/{batch_id}/apply
GET    /imports/templates/{kind}      → fichier modèle

GET/PUT /availability/depot-stocks?day=   /availability/trucks?day=   /availability/drivers?day=
CRUD   /orders?day=                   POST /orders/{id}/confirm  /cancel  /postpone

POST   /plans/compute  {day, params?}        → 202 + task_id
GET    /tasks/{task_id}                       → état, progression, plan_id à la fin
GET    /plans?day=  GET /plans/{id}  (plan complet : trips, stops, loads, unserved, violations, metrics)
POST   /plans/{id}/trips/{trip_id}/move-stop  {stop_id, to_trip_id, to_seq}
POST   /plans/{id}/trips/{trip_id}/reorder     {stop_ids[]}
POST   /plans/{id}/trips/{trip_id}/assign      {truck_id?, driver_id?}
POST   /plans/{id}/trips/{trip_id}/lock | /unlock
POST   /plans/{id}/recompute                   (respecte locked)
POST   /plans/{id}/publish                     → 409 si violations bloquantes
GET    /plans/{id}/versions   POST /plans/{id}/versions/{v}/restore
GET    /plans/{id}/route-sheets.pdf  (toutes)   GET /trips/{id}/route-sheet.pdf

POST   /events/truck-breakdown   {trip_id, replacement_truck_id, replacement_driver_id?}
POST   /events/driver-unavailable {trip_id, replacement_driver_id}
POST   /events/product-shortage  {depot_id, product_id, new_available_l}
GET    /events?day=

PUT    /trips/{id}/status
POST   /trips/{id}/loading  (loading + lines)    GET /trips/{id}/loading-sheet.pdf    POST /trips/{id}/loading-sheet/email
PUT    /stops/{id}/delivery  {actual_arrival_at, actual_departure_at, deliveries:[{order_id, actual_l}] | skip_reason}

POST   /reference-days/import   (journée A réelle)  → plan kind=manual_reference
POST   /plans/{id}/replay                              → plan kind=replay
GET    /comparison?plan_a=&plan_b=                     → métriques + écarts
GET    /comparison.pdf?plan_a=&plan_b=

GET    /dashboard?day=
CRUD   /users   GET/PUT /settings   GET /audit?table=&row_id=
GET    /health   GET /health/osrm
```

Erreurs : enveloppe JSON `{code, message, details[]}` ; les violations de règles retournent `rule_code` (RM-xx).

---

## 10. Écrans (React)

1. **Connexion.**
2. **Journée** (écran d'accueil, sélecteur de date) : résumé commandes / ressources / stocks, bouton « Calculer le plan », état du dernier calcul, alertes.
3. **Commandes du jour** : tableau éditable, import, confirmation en masse, filtres par station/produit/statut.
4. **Disponibilité du jour** : trois onglets (stocks dépôt, camions, chauffeurs) avec saisie rapide.
5. **Plan de tournées** (écran central) : panneau gauche liste des tournées (camion, chauffeur, km, durée, remplissage, violations), carte au centre (tournées colorées, arrêts numérotés, survol = détail), panneau droit détail de la tournée sélectionnée avec arrêts réordonnables et compartiments ; bandeau `unserved` ; actions verrouiller, recalculer, publier.
6. **Journal des événements** : panne, réaffectation, pénurie, avec assistant de réaffectation (modale).
7. **Chargement** (vue Fleet) : liste des tournées du jour au dépôt, formulaire de chargement par compartiment, calcul à 15 °C en direct, génération fiche PDF, passage des statuts.
8. **Suivi des livraisons** : par tournée, saisie des heures et volumes réels, arrêts sautés.
9. **Comparaison A / B** : choix de deux plans, tableau d'indicateurs avec écarts, deux cartes côte à côte, export PDF.
10. **Référentiels** : cinq tableaux CRUD + import, avec carte pour stations et dépôts.
11. **Administration** : utilisateurs, paramètres, journal d'audit.

Principes UI : densité d'information élevée (utilisateurs experts), tout faisable au clavier dans les tableaux, aucune action destructive sans confirmation, violations toujours visibles au même endroit, français partout, heures en `HH:mm` Afrique/Douala.

---

## 11. Documents PDF

- **Feuille de route** (par camion/tournée) : en-tête OLA (logo paramétrable), date, camion, chauffeur, dépôt, heure de départ prévue, tableau des arrêts (ordre, station, produit, volume, heure estimée, contact station), plan de chargement par compartiment, zone signatures (chauffeur, dispatcher).
- **Fiche de chargement** : identique + volumes observés, température, densité, volume à 15 °C, écart vs planifié, numéro de bon dépôt, mention « volume corrigé à 15 °C selon coefficient de dilatation, tables ASTM non appliquées dans le prototype ».
- **Rapport comparatif A/B** : page de synthèse (indicateurs, écarts, verdict par rapport au seuil paramétré), cartes, annexes par tournée.

---

## 12. Jalons de livraison (5 semaines)

| Jalon | Contenu | Démo attendue |
|---|---|---|
| J1 — fin semaine 1 | Squelette monorepo, docker-compose complet (db, redis, osrm sur extrait Cameroun, api, front vide), auth, référentiels + imports, fixtures `demo_douala` | Connexion, import des 4 fichiers modèles, stations et dépôts sur la carte |
| J2 — fin semaine 2 | Moteur OR-Tools v1 (mono-dépôt, mono-tournée) + règles RM-01 à RM-11 + matrice OSRM + commandes + disponibilité | `POST /plans/compute` sur `demo_douala` → plan sans violation, affiché sur la carte |
| J3 — fin semaine 3 | Multi-tournées, compartiments, stocks dépôt (RM-14/15/16), édition manuelle drag-and-drop avec recontrôle, verrouillage, recalcul, publication, versions, feuilles de route PDF | Dispatcher corrige un plan et publie |
| J4 — fin semaine 4 | Événements (panne, chauffeur, pénurie), chargement Fleet avec conversion 15 °C et fiche PDF, suivi des livraisons, tableau de bord | Scénario complet d'une journée, de la commande à la livraison |
| J5 — fin semaine 5 | Journée de référence, rejeu, comparaison A/B + PDF, administration, audit, sauvegardes, durcissement, documentation d'exploitation, recette interne sur `demo_scale` | Rapport A/B généré sur une journée réelle d'OLA |

Semaines 6–7 : test chez OLA (journée A rejouée, journée B réelle), corrections, rapport final.

---

## 13. Critères d'acceptation du prototype

1. Sur la journée de référence A fournie par OLA, le rejeu produit un plan sans violation bloquante, servant au moins autant de commandes que le plan manuel.
2. Le kilométrage estimé du plan calculé est inférieur au kilométrage du plan manuel d'au moins le seuil convenu avec OLA (valeur par défaut 10 %, paramètre `ab_success_threshold_pct`).
3. Calcul < 60 s sur `demo_scale` et sur les données réelles d'OLA.
4. Un dispatcher formé pendant une heure réalise seul : import des commandes, calcul, déplacement d'un arrêt, publication, traitement d'une panne.
5. Toutes les règles RM-01 à RM-20 ont un test automatisé qui passe ; couverture du module `planning` ≥ 80 %.
6. L'application redémarre proprement (`docker compose down && up`) sans perte de données, et une sauvegarde est restaurable sur une machine vierge en moins de 30 minutes (procédure documentée).
7. Aucun fichier Excel n'est lu ailleurs que dans `imports/`.

---

## 14. Données de départ et fichiers modèles

Dans `data/templates/` (xlsx) : `stations.xlsx` (code, nom, région, ville, lat, lon, horaires, gabarit max, temps dépotage, puis une ligne par cuve : produit, capacité, stock sécurité), `trucks.xlsx` (immat, transporteur, gabarit, capacité, puis compartiments : position, capacité, produits autorisés), `drivers.xlsx`, `depots.xlsx`, `orders.xlsx` (date, code station, produit, volume, priorité, fenêtre, commentaire), `reference_day.xlsx` (tournées réelles : camion, chauffeur, dépôt, ordre des stations, volumes, km réels, heures).

Dans `data/fixtures/` : `demo_douala/`, `demo_shortage/`, `demo_scale/` (générateur `scripts/gen_fixtures.py` avec graine).

---

## 15. Questions ouvertes à trancher avec OLA (ne pas bloquer le développement)

- Q1 Règle exacte de « dépotage à température ambiante » : confirmer qu'il s'agit de la correction de volume à 15 °C et des coefficients par produit.
- Q2 Nombre max de chargements par camion et par jour au SCDP Douala, et temps d'attente moyen observé.
- Q3 Les volumes de commande sont-ils en litres observés ou en litres à 15 °C ?
- Q4 Y a-t-il des stations livrables uniquement depuis un dépôt donné (contrainte d'affectation station → dépôt) ?
- Q5 Les chauffeurs sont-ils liés à un camion fixe ou interchangeables au sein d'un transporteur ?
- Q6 Format de la journée de référence A : qu'est-ce qui existe réellement (km réels, heures) ?

Valeurs par défaut adoptées en attendant : Q2 = 2 chargements/jour, attente 90 min ; Q3 = litres observés ; Q4 = non ; Q5 = interchangeables au sein du transporteur.
