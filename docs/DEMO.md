# Démonstrations de Tournéo — pas-à-pas, critères d'acceptation, limites connues

Ce document sert à **dérouler les démos de chaque jalon** (spec §12) sur des données réalistes, par les
mêmes portes qu'un utilisateur : **les écrans**, l'API et les fichiers d'import. Il tient aussi l'**état des
sept critères d'acceptation** (spec §13) et la liste des **défauts d'intégration** trouvés par les scénarios
de bout en bout.

Tout ce qui suit a été exécuté tel quel le 21/11/2026 sur un poste de développement, après l'intégration
des vagues 1 et 2 (back-end complet, événements, onze écrans) : PostgreSQL + PostGIS, Redis, API, worker
Celery et interface en local, **sans OSRM** (distances à vol d'oiseau corrigées, plans marqués
« approximatifs ») et **sans Docker**. Tous les chiffres ont été mesurés ce jour-là sur le code intégré.
Ce qui n'a pas pu être vérifié est signalé comme tel.

## Sommaire

1. [Ce qui est livré](#1-ce-qui-est-livré)
2. [Préparation](#2-préparation)
3. [Démos par jalon](#3-démos-par-jalon)
4. [Critères d'acceptation](#4-critères-dacceptation-spec-13)
5. [Défauts d'intégration](#5-défauts-dintégration)
6. [Écarts constatés entre l'interface et le pas-à-pas](#6-écarts-constatés-entre-linterface-et-le-pas-à-pas)
7. [Limites connues](#7-limites-connues)

---

## 1. Ce qui est livré

| Élément | Où | Rôle |
|---|---|---|
| Jeux importables | `data/fixtures/<jeu>/import/` | `depots.xlsx`, `stations.xlsx`, `trucks.xlsx`, `drivers.xlsx`, `orders.xlsx` au format exact des modèles ; `depot_stocks.json` ; `compute.json` (paramètres de calcul du jeu, affectations du jour) |
| Journée A fabriquée | `data/fixtures/demo_douala/import/reference_day.xlsx` | Plan manuel plausible et médiocre, au format `reference_day.xlsx` |
| `scripts/demo/export_fixture.py` | | `problem.json` → fichiers importables (reproductibles à l'octet près) |
| `scripts/demo/make_reference_day.py` | | Fabrique la journée A (heuristique du « dispatcher pressé ») |
| `scripts/demo/load_demo.py` | | Charge un jeu **par l'API seule** ; options `--compute`, `--ab`, `--day` |
| `scripts/demo/run_day.py` | | Déroule une journée par l'API ; options `--until publish`, `--shortage`, `--breakdown` |
| Tests de bout en bout | `backend/tests/e2e/` | Journée complète, journée perturbée (pénurie, panne, arrêt sauté, second plan), preuve A/B, passage à l'échelle, critères d'acceptation, non-régression, défauts ouverts en `xfail` |
| Captures du rapport A/B | `docs/demo/` | Contrôle visuel du PDF produit |
| Captures des écrans | `frontend/docs/captures/` | Produites par les lots d'interface ; citées dans les pas-à-pas |

Les trois jeux (`problem.json`, lot L2) :

| Jeu | Contenu | Attendu |
|---|---|---|
| `demo_douala` | 1 dépôt, 12 stations, 4 camions, 5 chauffeurs, 20 commandes (2 urgentes, 1 fenêtre 10:00–11:00, 1 station réservée aux petits camions) | tout servi, 0 violation |
| `demo_shortage` | `demo_douala` avec 30 000 L de gasoil pour 43 000 L demandés | 2 commandes non servies `depot_stock` |
| `demo_scale` | 2 dépôts, 70 stations, 25 camions, 28 chauffeurs (1 en congé, 1 au permis expiré), 120 commandes | calcul < 60 s, 0 violation bloquante |

Régénérer les fichiers après une modification des jeux ou des modèles d'import :

```bash
cd backend && uv run python ../scripts/demo/export_fixture.py --all
```

```bash
cd backend && uv run python ../scripts/demo/make_reference_day.py
```

Un test (`tests/e2e/test_jeux_importables.py`) échoue si les fichiers versionnés ne sont plus à jour.

---

## 2. Préparation

### 2.1 En développement (sans Docker) — vérifié

Quatre terminaux.

```bash
./scripts/dev_setup.sh
```

```bash
cd backend && uv run uvicorn app.main:app_instance --port 8000
```

```bash
cd backend && uv run celery -A app.worker.celery_app worker -l info -c 2
```

```bash
cd frontend && pnpm install && VITE_MOCKS=off pnpm dev
```

`dev_setup.sh` installe PostgreSQL + PostGIS et Redis, crée les bases, applique les migrations et insère
les paramètres, les trois produits et le compte administrateur. Le worker Celery exécute les calculs
(calcul, recalcul, rejeu). L'interface s'ouvre sur <http://localhost:5173> et parle à la vraie API
(`VITE_MOCKS=off` : aucune donnée simulée). Contrôle de l'API :

```bash
curl -s http://localhost:8000/api/v1/health
```

Réponse attendue : `{"status":"ok","checks":{"database":"ok","redis":"ok"}}`.
Documentation interactive de l'API : <http://localhost:8000/api/v1/docs>.

Pour repartir d'une base vide entre deux démonstrations (API et worker arrêtés) :

```bash
su postgres -c "psql -c 'DROP DATABASE tourneo'" && redis-cli flushall && ./scripts/dev_setup.sh
```

### 2.2 Avec `docker compose up` — non vérifié ici

Pas de démon Docker dans l'environnement de développement cloud : cette variante **n'a pas été exécutée**.
Installation et premier démarrage : [`EXPLOITATION.md`](EXPLOITATION.md) §2 à §4 ; ce qui a été vérifié de
l'infrastructure et ce qui reste à vérifier sur une machine avec Docker : [`EXPLOITATION.md`](EXPLOITATION.md) §12.
L'image de l'API contient `backend/app` et `data/` mais pas `scripts/` ; deux façons de lancer les scripts de
démonstration :

- depuis un poste qui a le dépôt et `uv`, en visant l'API publiée :

  ```bash
  cd backend && uv run python ../scripts/demo/load_demo.py demo_douala --base-url https://tourneo.exemple.cm --admin-email "$TOURNEO_ADMIN_EMAIL" --admin-password "$TOURNEO_ADMIN_PASSWORD"
  ```

- ou dans un conteneur de l'image, en montant le dossier des scripts (à valider au premier essai) :

  ```bash
  docker compose run --rm -v "$PWD/scripts:/srv/tourneo/scripts:ro" api python /srv/tourneo/scripts/demo/load_demo.py demo_douala --base-url http://api:8000
  ```

### 2.3 Comptes

| Compte | Mot de passe | Rôle | Créé par |
|---|---|---|---|
| `admin@honowa.tech` | `admin-dev-only` (développement ; en production : `TOURNEO_ADMIN_EMAIL` / `TOURNEO_ADMIN_PASSWORD`) | `admin` | `python -m app.cli seed` |
| `dispatcher@demo.tourneo.cm` | `demo-tourneo-2027` | `dispatcher` | `load_demo.py` |
| `supply@demo.tourneo.cm` | `demo-tourneo-2027` | `supply` | `load_demo.py` |
| `fleet@demo.tourneo.cm` | `demo-tourneo-2027` | `fleet` | `load_demo.py` |
| `manager@demo.tourneo.cm` | `demo-tourneo-2027` | `manager` | `load_demo.py` |

Les comptes de démonstration sont créés par l'administrateur **par l'API** (`POST /users`) au premier
chargement. Ils ne conviennent pas à la production : les désactiver après la démo.

La connexion est limitée à 10 tentatives par minute et par adresse : enchaîner plusieurs scripts en
moins d'une minute fait attendre le chargeur (message « trop de connexions récentes »), sans échec.

### 2.4 Le jour des jeux

Le jour des jeux est le **mardi 12/01/2027**. À l'écran, le jour J est dans l'adresse
(`?day=2027-01-12`) et dans le sélecteur de date de l'en-tête ; sans lui, l'interface montre le jour
courant, qui est vide. Ouvrir par exemple <http://localhost:5173/journee?day=2027-01-12> : la date suit
ensuite la navigation. Pour une démo datée d'aujourd'hui, ajouter `--day $(date +%F)` aux scripts.

---

## 3. Démos par jalon

Chaque jalon a deux pas-à-pas : **par script** (commandes exactes, depuis `backend/`) et **à l'écran**.
Les captures citées sont dans `frontend/docs/captures/` ; elles ont été produites par les lots d'interface
sur des données simulées : la mise en page est la même, les chiffres non.

Les écrans ont été ouverts un par un avec Playwright sur l'API réelle, après chaque étape ci-dessous
(jeu `demo_douala`, rôles dispatcher, fleet, supply, manager, admin) : tous s'affichent avec les données du
jeu, sans erreur d'API ni de console. Les écarts relevés sont en [§6](#6-écarts-constatés-entre-linterface-et-le-pas-à-pas).

### J1 — Connexion, import des fichiers modèles, stations et dépôts sur la carte

**Par script**

```bash
uv run python ../scripts/demo/load_demo.py demo_douala
```

```
→ Connexion (admin@honowa.tech) et comptes de démonstration
→ Import depots.xlsx : 1 créé(s), 0 mis à jour, 0 inchangé(s), 0 avertissement(s)
→ Import stations.xlsx : 12 créé(s), 0 mis à jour, 0 inchangé(s), 0 avertissement(s)
→ Import trucks.xlsx : 4 créé(s), 0 mis à jour, 0 inchangé(s), 2 avertissement(s)
→ Import drivers.xlsx : 5 créé(s), 0 mis à jour, 0 inchangé(s), 0 avertissement(s)
→ Import orders.xlsx : 20 créé(s), 0 mis à jour, 0 inchangé(s), 0 avertissement(s)
→ Stocks dépôt du 12/01/2027 : 3 couple(s) (dépôt, produit) saisis
→ Commandes du jour : 20 confirmée(s) à l'instant (0 avertissement(s)) ; 20 au total {'confirmed': 20}
```

- Chaque import passe par **prévisualiser** puis **appliquer**. Les 2 avertissements des camions annoncent
  la création automatique des transporteurs « OLA Flotte » et « Sotracam ».
- Les référentiels sont importés par l'administrateur, les commandes par le dispatcher, les stocks saisis
  par le compte Supply.
- **Relancer la même commande** : tout est « inchangé », aucune commande n'est reconfirmée, aucun stock
  n'est ressaisi (« sans écraser silencieusement », F1.6).

**À l'écran** (compte `admin@honowa.tech`)

| Étape | Écran, geste | Ce qu'on doit voir | Capture |
|---|---|---|---|
| 1 | Page de connexion : e-mail, mot de passe, Entrée | L'écran **Journée** | `01-connexion.png` |
| 2 | Menu **Référentiels**, onglet **Dépôts**, bouton **Importer** : choisir `data/fixtures/demo_douala/import/depots.xlsx`, **Prévisualiser**, puis **Appliquer l'import** | « 1 création » annoncée, puis le dépôt SCDP-DLA dans le tableau et sur la carte | `06-referentiels-depots.png` |
| 3 | Onglet **Stations**, **Importer** `stations.xlsx` ; puis **Camions** (`trucks.xlsx`) ; puis **Chauffeurs** (`drivers.xlsx`) — dans cet ordre | 12 stations (DLA01 à DLA12, cuves GASOIL / SUPER 30 000 L, DLA12 en gabarit « Petit »), **12 points sur la carte** à droite ; 4 camions avec leurs compartiments ; 5 chauffeurs | `04-referentiels-stations-carte.png`, `07-referentiels-camions.png`, `08-referentiels-camion-compartiments.png`, `10-referentiels-chauffeurs-alertes.png` |
| 4 | Pour montrer le rapport d'erreurs : modifier une cellule d'un fichier (gabarit « énorme »), **Prévisualiser** | Erreurs ligne par ligne, application impossible, rien n'est écrit | `12-import-previsualisation-erreurs.png` |
| 5 | Menu **Administration**, onglet **Utilisateurs** | Les cinq comptes (après un passage de `load_demo.py`) ; création d'un compte par **Nouvel utilisateur** | `13-administration-utilisateurs.png`, `14-administration-nouvel-utilisateur.png` |

Le fond de carte n'est pas configuré en développement (`VITE_TILES_URL` vide) : les points sont placés à
l'échelle sur un fond uni, avec la mention « Fond de carte non configuré — positions à l'échelle ».

### J2 — Commandes, disponibilité, calcul : un plan sans violation

**Par script**

```bash
uv run python ../scripts/demo/load_demo.py demo_douala --compute
```

Après la progression du calcul (4 à 5 s) :

```
plan … : 6 tournée(s), 4 camion(s), 105.9 km, 20 commande(s) servie(s), 0 non servie(s),
0 violation(s) bloquante(s), 0 avertissement(s) — distances approximatives (OSRM indisponible)
```

Variante pénurie, sur une base vide : `uv run python ../scripts/demo/load_demo.py demo_shortage --compute`
→ 18 commandes servies, **2 non servies** (`depot_stock`, gasoil), 0 violation bloquante.

**À l'écran** (compte `dispatcher@demo.tourneo.cm`, après `load_demo.py demo_douala` **sans** `--compute`)

| Étape | Écran, geste | Ce qu'on doit voir | Capture |
|---|---|---|---|
| 1 | **Commandes du jour** (`/commandes?day=2027-01-12`) ; pour importer soi-même : **Importer** `orders.xlsx`, puis cocher les lignes et **Confirmer** | 20 commandes « Confirmée », dont 2 « Urgente » (CMD004, CMD014) ; fenêtre 10:00–11:00 sur CMD012 | `l11-04-commandes.png`, `l11-06-commandes-confirmation-en-masse.png` |
| 2 | **Disponibilité du jour**, onglets **Stocks dépôt**, **Camions**, **Chauffeurs** | Stocks 64 000 L / 9 000 L / 76 000 L saisis par « Supply Démo » ; « 4 / 4 affectables » ; « 5 / 5 affectables » | `l11-07-disponibilite-stocks.png`, `l11-09-disponibilite-camions.png`, `l11-10-disponibilite-chauffeurs.png` |
| 3 | **Journée** : bouton **Calculer le plan** | Résumé « 20 commandes », « 4 / 4 », « 5 / 5 », « 3 / 3 renseignés » ; barre de progression ; puis « Plan calculé », durée 4 à 5 s, « Distances approchées » | `l11-01-journee-preparation.png`, `l11-02-journee-calcul-en-cours.png`, `l11-03-journee-plan-calcule.png` |
| 4 | **Ouvrir le plan** (ou menu **Plan de tournées**) | « Version 1 · Brouillon », **6 tournées, 106 km, 20 / 20 commandes servies**, remplissage moyen 80 %, « Aucune violation », six tracés colorés sur la carte | `l12-01-plan-vue-ensemble.png` |

Vérifié à la souris avec Playwright sur une journée neuve : **Calculer le plan** lance bien le calcul par
le worker et le plan apparaît « Brouillon … 6 tournées … 20 / 20 … 106 km … Aucune — publiable ».

### J3 — Le dispatcher corrige un plan et publie

**Par script**

```bash
uv run python ../scripts/demo/run_day.py demo_douala --until publish --pdf-dir /tmp/tourneo-pdf
```

```
   essai : DLA12 → tournée 5 : violation bloquante RM-09 — annulé
→ Arrêt DLA09 déplacé de la tournée 6 vers la tournée 5 (1 essai(s) refusé(s) par les règles auparavant)
→ Tournée modifiée verrouillée ; recalcul en conservant les tournées verrouillées
   tournée 5 — LT-402-AB (Alain Nkoulou), départ 12:11, 22.0 km 🔒 : DLA09 → DLA06 → DLA04
   6 tournée(s), 115.2 km, 0 non servie(s), 0 violation(s) bloquante(s), 0 avertissement(s)
→ Plan publié (version 1) : 20 commande(s) « planned »
```

Le premier essai (DLA12, station réservée aux petits camions, vers un camion moyen) est refusé par RM-09 :
c'est le recontrôle immédiat de F5.2. La correction manuelle coûte ici 9,3 km (115,2 km contre 105,9 km).
L'arrêt déplacé et les kilomètres peuvent différer d'une machine à l'autre.

**À l'écran** (compte dispatcher, écran **Plan de tournées**)

| Étape | Geste | Ce qu'on doit voir | Capture |
|---|---|---|---|
| 1 | Cliquer une tournée dans la liste de gauche | Panneau de droite : arrêts dans l'ordre, volumes par produit, compartiments | `l12-02-tournee-selectionnee-detail.png` |
| 2 | Glisser un arrêt vers une autre tournée (ou, au clavier, le menu « Déplacer vers… ») | Distances, heures et remplissage recalculés aussitôt | `l12-03-glisser-deposer-arret.png`, `l12-06-deplacer-au-clavier-menu.png` |
| 3 | Glisser **DLA12** sur une tournée d'un camion moyen (LT-401-AA ou LT-402-AB) | Violation **RM-09** en rouge, bouton **Publier** inactif ; remettre l'arrêt à sa place | `l12-04-violation-bloquante-publication-desactivee.png` |
| 4 | Cadenas d'une tournée (**Verrouiller**), puis **Recalculer en conservant** et confirmer | La tournée verrouillée ressort inchangée, les autres sont réoptimisées | `l12-07-recalculer-confirmation.png`, `l12-08-recalcul-en-cours.png` |
| 5 | **Publier**, puis **Publier** dans la boîte « Publier ce plan ? » | « Version 1 · Publié », bandeau « Plan publié. Toute modification crée une nouvelle version brouillon… », bouton **Feuilles de route** | `l12-09-publier-confirmation.png`, `l12-10-plan-publie-feuilles-de-route.png` |
| 6 | **Feuilles de route** | Un PDF, une page par tournée : arrêts, plan de chargement, signatures | — |
| 7 | **Historique** | Qui a changé quoi : déplacement, verrouillage, recalcul, publication | `l12-12-historique-versions.png` |
| 8 | **Commandes du jour** | Les 20 commandes sont « Planifiée » | — |

Vérifié à la souris avec Playwright : **Publier** ouvre « Publier ce plan ? La version 1 (6 tournées) sera
figée, les commandes servies passeront à « planifiée » et les feuilles de route seront disponibles. », et
le plan passe à « Publié ». Une violation bloquante empêche la publication (409 avec `rule_code`) : vérifié
par `tests/e2e/test_journee_complete.py`.

### J4 — Journée complète, de la commande à la livraison, avec ses événements

**Par script**, à la suite de J3 (le script reprend le plan publié) :

```bash
uv run python ../scripts/demo/run_day.py demo_douala --shortage --breakdown --pdf-dir /tmp/tourneo-pdf
```

Sans option, la journée se déroule sans incident (six tournées, dernier arrêt sauté, second calcul).
Avec les deux options, mesuré le 21/11/2026 :

```
→ Pénurie déclarée par Supply : Stock de GASOIL au dépôt SCDP-DLA : 64 000 L → 38 000 L (déjà chargé 0 L,
  reste 38 000 L pour 43 000 L encore à charger). 1 tournée(s) impactée(s) (n° 6), il manque 5 000 L : le
  dispatcher doit réduire, reporter ou changer de dépôt.
   tournée 6 impactée : 10 000 L prévus, 5 000 L couverts, options ['reduce', 'postpone'] — DLA10 6 000 L, DLA08 4 000 L
→ Pénurie traitée par le dispatcher (postpone) : alerte « resolved », version 2 publiée
→ Tournée 1 (CE-404-AD) chargée à 27 °C : 11 000 L observés, 10 863 L à 15 °C (écart -1.25 %)
→ Tournée 2 (LT-402-AB) chargée à 36 °C : 20 000 L observés, 19 570 L à 15 °C (écart -2.15 %) ⚠ Écart entre
  volume chargé à 15 °C et volume planifié au-delà de la tolérance (2 %) — compartiment 1 : −172,87 L (−2,52 %) …
→ Tournée 3 (LT-403-AC) chargée à 27 °C : 11 000 L observés, 10 842 L à 15 °C (écart -1.44 %)
   remplaçant possible ? CE-404-AD : oui
   remplaçant possible ? LT-401-AA : non — RM-09, RM-14
   remplaçant possible ? LT-402-AB : non — RM-09, RM-14
→ Panne du camion LT-403-AC (tournée 3) à 09:30 : 1 arrêt(s) non livré(s) transféré(s) sur le camion CE-404-AD
  (tournée 7, chauffeur Serge Owona), à recharger au dépôt ; 1 arrêt(s) déjà réalisé(s) conservé(s) sur la
  tournée d'origine. Version 3 publiée.
→ Tournée 7 (CE-404-AD) chargée à 27 °C : 4 000 L observés, 3 942 L à 15 °C (écart -1.44 %)
   arrêt DLA08 sauté (station fermée à l'arrivée) : commandes à replanifier
→ Second calcul du jour : 1 commande(s) à replanifier
   tournée 1 — LT-402-AB (Alain Nkoulou), départ 08:15, 18.7 km : DLA08
→ Tournée 1 (LT-402-AB) chargée à 27 °C : 6 000 L observés, 5 914 L à 15 °C (écart -1.44 %)

Tableau de bord du 2027-01-12 (plan publié version 3) :
  tournées : {"planned": 0, "at_depot": 0, "loaded": 0, "in_progress": 0, "completed": 7}
  arrêts : 10 livré(s), 1 sauté(s), 0 en attente
  volumes : 84 000 L livrés sur 90 000 L planifiés
  retards : 7 tournée(s), au plus 25 min
  alertes : 2 (dont 0 bloquante(s))
  journal : {"Panne de camion": 1, "Livraison enregistrée": 12, "Chargement enregistré": 8,
             "Publication du plan": 4, "Modification du plan": 7, "Produit indisponible au dépôt": 1,
             "Recalcul du plan": 1}
  commandes : {'delivered': 18, 'postponed': 2}
```

Ce que cela montre :

- **Pénurie (F6.3)** : Supply ramène le stock de gasoil 5 000 L sous ce que le plan prévoit ; la tournée
  qui part la dernière avec du gasoil est signalée, avec ses options. Le dispatcher **reporte** ses deux
  commandes de gasoil (`postponed`) : nouvelle version publiée d'office, alerte résolue. Les commandes
  reportées restent listées dans les non servies du plan.
- **Chargement (F7, RM-12, RM-13)** : conversion à 15 °C ; à 36 °C le super dépasse la tolérance de 2 %
  (avertissement sur la tournée, la fiche et le tableau de bord).
- **Panne (F6.1, RM-19)** : le camion tombe en panne après son premier arrêt. L'assistant dit quels camions
  peuvent le remplacer et pourquoi les autres ne le peuvent pas (RM-09 gabarit, RM-14 chargements du jour).
  Seul l'arrêt en attente est transféré ; l'arrêt livré reste sur la tournée d'origine avec son chargement
  réel ; la tournée de remplacement est **rechargée au dépôt** puis livrée.
- **Arrêt sauté** : ses commandes reviennent à `confirmed`, un **second calcul du jour** les reprend dans un
  second plan publié (lignée distincte), dans la limite du stock restant.
- **Fin de journée** : 18 commandes livrées, 2 reportées, aucune oubliée.

**À l'écran**

| Étape | Compte, écran, geste | Ce qu'on doit voir | Capture |
|---|---|---|---|
| 1 | Fleet, **Chargement** : choisir une tournée, **Au dépôt**, saisir heures, bon de chargement, volume et température par compartiment | Volume à 15 °C calculé en direct ; au-delà de 2 % d'écart, bandeau RM-13 | `l13-01-chargement-saisie-rm13.png` |
| 2 | **Enregistrer le chargement**, **Fiche de chargement**, puis **Chargée** et **En cours** | Fiche PDF ; pastilles d'état Planifiée → Au dépôt → Chargée → En cours | `l13-03-chargement-enregistre-pret-au-depart.png`, `l13-02-chargement-envoi-fiche.png` |
| 3 | Fleet, **Suivi des livraisons** : pour chaque arrêt, heure d'arrivée et volumes livrés, **Enregistrer la livraison** ; pour un arrêt non livré, **Arrêt sauté…** et son motif | « 1 / 2 arrêts », volumes livrés ; l'arrêt sauté avec son motif | `l13-04-suivi-saisie-livraison.png`, `l13-05-suivi-arret-saute.png` |
| 4 | **Clôturer la tournée** (heure de retour, kilomètres réels) | « Terminée », retard affiché | `l13-06-suivi-cloture.png`, `l13-07-suivi-tournee-terminee.png` |
| 5 | Dispatcher, **Journal des événements** : **Assistant de réaffectation**, choisir la tournée en panne, le camion de remplacement proposé, valider | Camions éligibles et motif (`RM-xx`) des autres ; résultat : arrêts transférés, « Version n publiée » | `l13-09-journal-assistant-tournee-rm19.png`, `l13-10-journal-assistant-remplacant.png`, `l13-12-journal-reaffectation-resultat.png` |
| 6 | Administrateur, **Journal des événements** : **Déclarer une pénurie** (dépôt, produit, nouveau stock) — voir écart E1 | Tournées impactées et options | `l13-11-journal-penurie-tournees-impactees.png` |
| 7 | Dispatcher, **Journal** : **Traiter la pénurie** sur la ligne de l'alerte, choisir **Reporter** | « Pénurie traitée », alerte résolue | `l13-13-journal-penurie-traitee.png` |
| 8 | Tous, **Journal des événements** | Après la journée scriptée : « 34 événements », filtres Panne de camion 1, Pénurie produit 1, Publication 4, Chargement 8, Livraison 12 | `l13-08-journal-evenements.png` |
| 9 | Direction, **Comparaison A / B**, onglet **Suivi de la journée B** | « Plan publié · version 3 », « Tournées terminées 7 sur 7 », « Arrêts livrés 10 sur 11 · 1 arrêt sauté », « 84 000 L sur 90 000 L », « Alertes actives 2 » | — |
| 10 | Direction, **Journée** | « Alertes du jour » : RM-13 de la tournée 2 et la panne du camion LT-403-AC | `03-coquille-alertes.png` |
| 11 | Administrateur, **Administration**, onglet **Journal d'audit** | Chaque écriture sur les plans, tournées, chargements, stocks, avec son auteur | `16-administration-audit-diff.png` |

Les mêmes scénarios, avec toutes leurs vérifications :

```bash
uv run pytest tests/e2e/test_journee_complete.py tests/e2e/test_journee_perturbee.py
```

### J5 — Journée de référence, rejeu, rapport A/B

La journée A réelle d'OLA n'est pas encore fournie. La démo utilise une **journée A fabriquée** :
`reference_day.xlsx`, produite par `make_reference_day.py` à partir des 20 commandes de `demo_douala`
(stations prises dans l'ordre de leur code, camions dans l'ordre des immatriculations, premier qui rentre ;
plan réalisable, sans optimisation).

**Par script** (sur une base vide, ou à la suite des démos précédentes) :

```bash
uv run python ../scripts/demo/load_demo.py demo_douala --ab --pdf /tmp/tourneo-pdf/comparaison_AB.pdf
```

```
Comparaison A / B (journée manuelle fabriquée → rejeu du moteur)
  A (manuel)  : 125.7 km, 4 camion(s), 7 tournée(s), 20/20 commande(s), 0 violation(s) bloquante(s)
  B (calculé) : 105.9 km, 4 camion(s), 6 tournée(s), 20/20 commande(s), 0 violation(s) bloquante(s)
  gain kilométrique : 19.8 km (15.8 %) pour un seuil de 10 %
  verdict : Objectif atteint : le plan B parcourt 15,8 % de kilomètres en moins que le plan A (seuil : 10,0 %).
```

Lancé **après une panne déclarée le même jour**, le rejeu n'a plus que 3 camions (le camion en panne est
indisponible pour la journée) : même kilométrage, même verdict, « B : 3 camion(s) ».

**À l'écran**

| Étape | Compte, geste | Ce qu'on doit voir | Capture |
|---|---|---|---|
| 1 | Dispatcher, **Comparaison A / B** : **Importer une journée de référence**, choisir `data/fixtures/demo_douala/import/reference_day.xlsx` | Plan « Journée de référence · v1 — Journée A — plan manuel fabriqué (démonstration) » | — |
| 2 | **Rejouer avec le moteur** | « Rejeu terminé : comparaison ouverte sur la journée A et son rejeu. » | — |
| 3 | Direction (ou dispatcher), **Comparaison A / B** | Verdict **« OBJECTIF ATTEINT −15,8 % »**, barres « A 126 km / B 106 km », « Objectif : 113 km au plus », les trois critères cochés, tableau d'indicateurs, deux cartes côte à côte | `l14-01-verdict-favorable.png`, `l14-02-page-entiere.png` |
| 4 | **Exporter le PDF** | Rapport de 6 pages : synthèse et verdict, cartes, annexes par tournée | captures ci-dessous |

Le rapport PDF a été contrôlé visuellement sur le code intégré ; captures régénérées :

- synthèse : [`demo/comparaison_AB_demo_douala-1.png`](demo/comparaison_AB_demo_douala-1.png)
- cartes : [`demo/comparaison_AB_demo_douala-2.png`](demo/comparaison_AB_demo_douala-2.png)
- annexe : [`demo/comparaison_AB_demo_douala-3.png`](demo/comparaison_AB_demo_douala-3.png)

![Synthèse du rapport A/B](demo/comparaison_AB_demo_douala-1.png)

Mesuré le 21/11/2026 (`tests/e2e/test_preuve_ab.py`, base vide, sans OSRM) :

| Indicateur | A — manuel fabriqué | B — rejeu du moteur | Écart |
|---|---|---|---|
| Kilomètres estimés (même matrice) | 125,7 km | 105,9 km | −19,8 km (−15,8 %) |
| Kilomètres « réels » de A (fabriqués : estimés + 5 %) | 131,0 km | — | gain de B : 19,2 % |
| Camions mobilisés | 4 | 4 | 0 |
| Chauffeurs mobilisés | 4 | 4 | 0 |
| Tournées | 7 | 6 | −1 |
| Commandes servies / demandées | 20 / 20 | 20 / 20 | 0 |
| Durée totale de service | 12 h 43 | 10 h 39 | −2 h 04 |
| Taux de remplissage moyen | 74,5 % | 80,2 % | +5,7 points |
| Violations bloquantes | 0 | 0 | 0 |
| Temps de préparation | 2 h 00 (déclaré) | 4 s (calcul : 4,1 s) | |

**Ce résultat prouve la chaîne, pas le gain chez OLA** : la journée A est fabriquée par une heuristique
naïve ; le gain réel se mesurera sur la journée fournie par OLA (question Q6).

### Recette sur `demo_scale` (J5)

```bash
uv run python ../scripts/demo/load_demo.py demo_scale --compute
```

ou, avec les temps détaillés :

```bash
uv run pytest tests/e2e/test_echelle.py -m slow -s
```

Temps mesurés le 21/11/2026 (import par les fichiers puis calcul par le service réel, sans OSRM) :

| Étape | Temps |
|---|---|
| Import `depots.xlsx` (2 dépôts) | 0,05 s |
| Import `stations.xlsx` (70 stations, 158 cuves) | 0,12 s |
| Import `trucks.xlsx` (25 camions, 123 compartiments) | 0,11 s |
| Import `drivers.xlsx` (28 chauffeurs) | 0,20 s |
| Import `orders.xlsx` (120 commandes) | 0,13 s |
| Confirmation en masse des 120 commandes | 0,68 s |
| **Chargement complet** (connexions, comptes, imports, stocks, confirmation) | **2,41 s** |
| Construction du problème (lecture de la base) | 0,04 s |
| Matrice de distances (repli haversine) | 0,20 s |
| Calcul des tournées (moteur OR-Tools, limite 30 s) | 17,28 s |
| Enregistrement du plan | 0,17 s |
| **Calcul complet** (`run_compute`) | **17,68 s** (seuil : 60 s) |
| Lecture du plan complet (`GET /plans/{id}`) | 0,25 s |

Résultat : 32 tournées, 24 camions sur 25, 4 092,8 km, **120 commandes servies sur 120, 0 violation
bloquante, 0 avertissement**, les deux dépôts utilisés. Chaque import comprend prévisualisation et
application. Les kilomètres diffèrent de la mesure précédente (3 753,8 km) parce que le jeu a changé :
70 stations aux identifiants distincts, plusieurs villes renommées.

À l'écran, le plan de `demo_scale` se lit comme les captures `l12-14-plan-30-tournees-carte.png` et
`l12-15-plan-30-tournees-tableau.png` (non rejoué à l'écran ici).

---

## 4. Critères d'acceptation (spec §13)

Tests : `backend/tests/e2e/test_acceptance.py` (un test par critère vérifiable automatiquement).
Suite complète du back-end le 21/11/2026 (`uv run pytest`, tests lents compris) : 773 tests, 771 réussis,
1 ignoré, 1 `xfail` documenté (le défaut D8 ci-dessous) ; `uv run ruff check .` sans remarque.

| # | Critère | Vérifié ici | Reste à vérifier ailleurs | Preuve |
|---|---|---|---|---|
| 1 | Rejeu de la journée A sans violation bloquante, au moins autant de commandes servies | Oui, **sur la journée fabriquée** : 0 violation bloquante, 20 / 20 comme le manuel | Chez OLA : sur la journée A réelle | `test_critere_1_…`, `tests/e2e/test_preuve_ab.py` |
| 2 | Kilométrage calculé inférieur d'au moins `ab_success_threshold_pct` (10 %) | Oui, **sur la journée fabriquée** : 105,9 km contre 125,7 km, gain 15,8 % ; le verdict suit le paramètre | Chez OLA : sur la journée A réelle, avec OSRM | `test_critere_2_…` |
| 3 | Calcul < 60 s sur `demo_scale` et sur les données réelles | Oui sur `demo_scale` par l'API : 17,7 s tout compris, sans OSRM | Avec Docker : temps de la matrice OSRM (cache froid) ; chez OLA : données réelles | `test_critere_3_…` (`-m slow`), `tests/e2e/test_echelle.py` |
| 4 | Un dispatcher formé une heure réalise seul import, calcul, déplacement d'un arrêt, publication, panne | La séquence des cinq gestes s'enchaîne de bout en bout avec le seul compte dispatcher (par l'API) ; calcul et publication vérifiés à la souris ; écrans ouverts sur les données du jeu | Chez OLA : l'heure de formation et l'autonomie réelle d'un dispatcher | `test_critere_4_…`, §3 et §6 |
| 5 | RM-01 à RM-20 ont un test automatisé qui passe ; couverture de `planning` ≥ 80 % | Oui : **20 règles sur 20** ont un test `test_RM_xx…` (RM-19 depuis le lot L10) ; couverture de `app/planning` : **93 %** (3 551 instructions, `uv run pytest --cov=app/planning`) | — | `test_critere_5_…` |
| 6 | Redémarrage sans perte (`docker compose down && up`), sauvegarde restaurable en moins de 30 min | Non (pas de démon Docker). Scripts de sauvegarde et de restauration exécutés hors Docker : [`EXPLOITATION.md`](EXPLOITATION.md) §12 | Sur une machine avec Docker : redémarrage, restauration chronométrée sur un VPS vierge ([`EXPLOITATION.md`](EXPLOITATION.md) §9 et §12) | — |
| 7 | Aucun fichier Excel lu ailleurs que dans `imports/` | Oui : `backend/app` (contrôle du lot L3) et `scripts/` (les scripts de démonstration écrivent des classeurs, ne lisent que du JSON) | — | `test_critere_7_…` |

---

## 5. Défauts d'intégration

### 5.1 Défaut ouvert

Figé par un test `xfail(strict=True)` de `backend/tests/e2e/test_defauts_integration.py` : le test décrit le
comportement attendu, échoue aujourd'hui, et signalera la correction.

#### D8 — La livraison d'une commande planifiée en partie est refusée (L4 × L5 × L6)

- **Où** : `app/loading/service.py::record_delivery` → `app/orders/service.py::mark_delivered` ;
  table `ALLOWED_TRANSITIONS` du même fichier.
- **Entrée** : plan publié de `demo_douala` ; Supply déclare une pénurie de gasoil (38 000 L pour 43 000 L
  planifiés) ; le dispatcher la traite par **« réduire »** (`POST /events/{id}/resolve`, action `reduce`) :
  version 2 publiée, les deux commandes de gasoil de la tournée impactée sont planifiées en partie
  (2 000 L sur 4 000 L, 3 000 L sur 6 000 L). Conformément à RM-16 (question L5-6), elles restent
  `confirmed`. Fleet charge la tournée, part, puis saisit la livraison aux volumes planifiés.
- **Attendu** : la livraison partielle est enregistrée ; le reliquat reste à replanifier.
- **Constaté** : `PUT /stops/{id}/delivery` → 409 `invalid_order_transition`, « une commande « confirmée »
  ne peut pas passer à « livrée » ». L'arrêt ne peut être ni livré ni, donc, la tournée clôturée autrement
  qu'en sautant l'arrêt. Toute livraison partielle (RM-16) est concernée, pas seulement la pénurie.
- **Piste** : dans `record_delivery`, ne faire passer à `delivered` que les commandes entièrement livrées
  (une commande `confirmed` planifiée en partie garde son statut, son volume livré est porté par
  `stop_deliveries.actual_l`) ; ou autoriser `confirmed → delivered` quand le reliquat est nul.
- **Contournement pour la démo** : traiter la pénurie par **« reporter »** (c'est ce que fait `run_day.py`).
- **Test** : `test_defaut_livraison_d_une_commande_planifiee_en_partie`.

### 5.2 Défauts trouvés à la première passe, corrigés depuis

Les sept défauts trouvés le 21/11/2026 ont été corrigés par leurs lots ; leurs tests, d'abord en `xfail`,
passent et restent comme tests de non-régression (`backend/tests/e2e/test_non_regression.py`). Les scénarios
`test_journee_perturbee.py` repassent en outre par D2, D4 et D6 dans une même journée.

| # | Défaut (lots) | Correction constatée | Test de non-régression |
|---|---|---|---|
| D1 | `demo_scale` avait deux stations d'identifiant `MBA01` : 69 stations au lieu de 70 (L2) | 70 stations aux identifiants distincts ; l'export n'écarte plus rien | `test_demo_scale_a_70_stations_aux_identifiants_distincts` |
| D2 | Une nouvelle version d'un plan publié perdait les chargements enregistrés (L5 × L6) | Le chargement suit la tournée dans la version en vigueur (fiche PDF comprise) | `test_nouvelle_version_d_un_plan_publie_conserve_le_chargement_enregistre` |
| D3 | La publication d'une version écrasait l'avancement saisi entre-temps par Fleet (L5 × L6) | L'état d'exécution est repris de la version précédente à la publication | `test_publication_d_une_version_conserve_l_avancement_saisi_entre_temps` |
| D4 | Les commandes d'un arrêt sauté n'étaient pas replanifiables (L5 × L6) | Un arrêt `skipped` ne compte plus dans le reliquat : le second calcul les reprend | `test_second_calcul_du_jour_reprend_les_commandes_d_un_arret_saute` |
| D5 | « Recalculer en conservant » faisait disparaître ces commandes (L5 × L6) | Elles sont replanifiées ou listées non servies | `test_recalcul_du_plan_publie_reprend_les_commandes_d_un_arret_saute` |
| D6 | RM-08 n'était pas cumulée entre les plans publiés du jour (L5 × L1) | Le stock transmis est le stock saisi moins les volumes des autres plans publiés | `test_RM_08_second_plan_publie_du_jour_respecte_le_stock_restant` |
| D7 | Motif d'indisponibilité d'un chauffeur en anglais (« statut : leave ») (socle) | Libellé français | `test_motif_d_indisponibilite_du_chauffeur_en_francais` |

### 5.3 Constats sans test (questions déjà ouvertes par d'autres lots)

- **Deux plans publiés le même jour partagent camions et chauffeurs sans contrôle croisé** (question L5-8).
  Constaté sur la journée perturbée : le second plan (commandes de l'arrêt sauté) confie une tournée au
  camion LT-402-AB, départ prévu 08:15, alors que ce camion a déjà fait ses deux chargements du jour dans le
  premier plan (RM-14) et qu'il y roulait à cette heure-là (RM-02). Le second calcul ne connaît ni l'heure
  qu'il est, ni les tournées déjà publiées.
- **Le tableau de bord ne suit qu'un plan publié par jour** (question L7-17) : le second plan n'y figure
  pas. Sur la journée perturbée il affiche « 84 000 L livrés sur 90 000 L », alors que les 6 000 L de
  l'arrêt sauté ont été livrés par le second plan.
- **Réimporter `orders.xlsx` après un report recrée les commandes reportées** : l'import ignore les
  commandes `postponed` quand il cherche une commande existante (question L3-15). Rejouer
  `load_demo.py demo_douala` après une pénurie traitée par report crée deux nouvelles commandes confirmées.
  `--ab` seul n'importe donc plus les commandes du jour.
- `scripts/dev_setup.sh` démarre `redis-server --daemonize yes` depuis la racine du dépôt : Redis y écrit
  `dump.rdb`, qui n'est pas ignoré par git.
- Deux sessions `pytest` lancées en même temps se marchent dessus (la base `tourneo_test` est recréée au
  début de chaque session) : une seule suite à la fois.

---

## 6. Écarts constatés entre l'interface et le pas-à-pas

Relevés le 21/11/2026 en ouvrant chaque écran avec Playwright sur l'API réelle (`VITE_MOCKS=off`), jeu
`demo_douala`, avant le calcul, après la publication, après la journée perturbée et après la comparaison.
Aucun écran n'a échoué à s'ouvrir ; aucune requête d'API en erreur ; aucune erreur de console.

| # | Écran | Écart | Conséquence pour la démo |
|---|---|---|---|
| E1 | Journal des événements | Le rôle `supply` reçoit « Accès refusé » sur l'écran Journal, alors que c'est là que se trouve **Déclarer une pénurie**, réservé à `supply` et `admin` (question L13-13, toujours ouverte). | À l'écran, la pénurie se déclare avec le compte administrateur ; Supply ne peut le faire que par l'API (`run_day.py --shortage`). |
| E2 | Plan de tournées | Le sélecteur « Plan et version affichés » liste aussi la journée de référence et son rejeu sous le libellé « Version 1 · Brouillon », sans dire leur nature ; avec deux plans publiés le même jour, c'est le second (une tournée) qui s'ouvre par défaut. | Choisir « Version 3 · Publié » dans le sélecteur pour montrer le plan principal. |
| E3 | Chargement, Suivi des livraisons | Avec deux plans publiés le même jour, deux lignes « Tournée 1 » (une par plan) se suivent sans rien qui les distingue, sinon le camion. | Les nommer par leur camion pendant la démo. |
| E4 | Chargement | La tournée d'origine d'une panne (tournée 3) porte la pastille « Écart RM-13 » : son chargement réel (10 842 L à 15 °C) est comparé aux 7 000 L qui lui restent après le transfert d'un arrêt. Le plan et le tableau de bord, eux, ne comptent pas d'avertissement RM-13 sur cette tournée. | Conséquence du rechargement au dépôt (question L10-1) : à expliquer, ce n'est pas une erreur de chargement. |
| E5 | Journal des événements | Les lignes n'affichent que l'heure. Une panne saisie « à 09:30 » le jour J s'affiche au-dessus d'événements saisis à « 13:16 » aujourd'hui pour ce même jour J. | Sans effet quand la démo est datée d'aujourd'hui (`--day $(date +%F)`). |
| E6 | Journée | Après `--ab`, le résumé compte aussi les 20 commandes de la journée de référence (« 40 commandes … Livrée 38 »). | À dire pendant la démo, ou faire la comparaison sur une autre date. |
| E7 | Toutes les cartes | Pas de fond de carte en développement (« Fond de carte non configuré — positions à l'échelle »). | Renseigner `VITE_TILES_URL` pour une démo avec fond de carte. |

Non vérifié à la souris (écrans ouverts et lus, gestes non rejoués) : glisser-déposer d'un arrêt,
verrouillage, saisie d'un chargement et d'une livraison, assistant de réaffectation, import d'un fichier,
import de la journée de référence et rejeu. Ces gestes sont couverts par les parcours Playwright des lots
d'interface (`frontend/e2e/`), non relancés ici. Vérifiés à la souris : connexion des cinq rôles,
**Calculer le plan**, **Publier** et sa confirmation, onglet **Suivi de la journée B**.

---

## 7. Limites connues

- **Pas d'OSRM** dans cet environnement : toutes les distances sont à vol d'oiseau × 1,3, tous les plans
  sont « approximatifs ». Les kilomètres et le gain A/B changeront avec OSRM ; le temps de calcul de la
  matrice aussi (critère 3).
- **Pas de Docker** : `docker compose up`, le redémarrage sans perte et la restauration (critère 6) ne sont
  pas vérifiés ici ([`EXPLOITATION.md`](EXPLOITATION.md) §12). La tâche Celery réelle l'a été en local
  (API + worker + Redis), pas dans les tests automatisés, qui exécutent `service.run_compute` avec la
  session du test.
- **Journée A fabriquée** : heuristique naïve sur `demo_douala`. Les critères 1 et 2 restent à prouver sur
  la journée réelle d'OLA.
- **Livraison partielle** : tant que D8 n'est pas corrigé, ne pas traiter une pénurie par « réduire »
  pendant une démo qui va jusqu'aux livraisons.
- **Second plan du jour** : il reprend bien les commandes à replanifier et respecte le stock restant, mais
  il ignore les tournées déjà publiées (camions, chauffeurs, heure qu'il est) et n'apparaît pas au tableau
  de bord (§5.3).
- **Chauffeur indisponible** (F6.2) : couvert par les tests du lot L10, pas rejoué dans les scénarios de
  bout en bout ni dans `run_day.py`.
- **Données complétées** : cuves, régions, numéros de permis, transporteurs des jeux sont fabriqués par
  l'export (voir [`questions/l15-demo.md`](questions/l15-demo.md)) ; les contacts des stations sont vides.
- `run_day.py` reprend un plan publié dont il reste des tournées à faire, mais une journée entièrement
  déroulée ne se rejoue pas (base vide ou `--day` différent) ; l'arrêt qu'il déplace et la tournée qu'il
  met en panne dépendent du plan calculé.
- Les captures de `frontend/docs/captures/` viennent de données simulées : mêmes écrans, autres chiffres.
