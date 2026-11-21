# Plan de réalisation — prototype Tournéo

Référence : [SPEC_MVP_Tourneo.md](SPEC_MVP_Tourneo.md). Ce document décline la stratégie, les vagues de
travail parallèle, les lots et les étapes jusqu'aux critères d'acceptation (spec §13).

## 1. Stratégie

1. **Un socle commun d'abord, le parallèle ensuite.** Tout le schéma de données (spec §5), l'authentification,
   les paramètres, l'audit, les erreurs, le temps (RM-20), le PDF et surtout les **contrats entre modules**
   (domaine du moteur, signatures règles / moteur / service de plans) sont posés une fois, testés, puis figés.
   Chaque lot travaille ensuite dans ses propres fichiers, sur sa propre branche, sans collision.
2. **Le moteur est le chemin critique.** Il est développé et testé sur des jeux fictifs (`demo_douala`,
   `demo_shortage`, `demo_scale`) sans base de données ni interface, comme l'exige la spec §0. Les règles
   RM-xx sont une source de vérité unique, partagée par le moteur et l'édition manuelle.
3. **Découplage par interfaces.** Un lot qui dépend d'un autre passe par une signature de
   [CONTRATS.md](CONTRATS.md) et simule l'autre côté dans ses tests. L'intégration réelle se fait à la fusion.
4. **L'écran suit l'API réelle.** Le socle de l'interface (coquille, composants, référentiels) part en vague 1 ;
   les écrans métier partent en vague 2, sur l'OpenAPI réellement générée par le back-end.
5. **Une intégration par vague.** La session principale fusionne les branches des lots, relance toute la suite
   de tests, corrige les frictions, consolide les questions, puis ouvre la vague suivante.
6. **Périmètre strict.** Rien de la section 4 de la spec. Toute zone d'ombre devient une question
   (`docs/questions/<lot>.md`) avec une valeur par défaut, jamais une règle inventée.

## 2. Vagues

| Vague | Contenu | Jalons de la spec couverts |
|---|---|---|
| 0 — Socle (fait) | Monorepo, schéma complet + migration, auth JWT, rôles, paramètres, audit, erreurs, temps, PDF, domaine du moteur, calcul des horaires, outillage de test, script de mise en route | J1 (partie) |
| 1 — Modules (9 lots en parallèle) | Règles, moteur + jeux fictifs, référentiels + imports, commandes + disponibilité, service de plans, chargement + livraisons, comparaison A/B, administration + infrastructure, socle de l'interface | J1, J2, J3 (back), J4 (back, partie), J5 (back, partie) |
| 2 — Écrans et événements (6 lots en parallèle) | Événements (panne, chauffeur, pénurie), écrans Journée / Commandes / Disponibilité, écran Plan de tournées, écrans Chargement / Suivi / Journal, écran Comparaison + tableau de bord, jeux de démonstration importables + tests de bout en bout | J3, J4, J5 |
| 3 — Recette | Recette interne sur `demo_scale`, durcissement, documentation d'exploitation, vérification des 7 critères d'acceptation, démo `docker compose up` | J5, §13 |

## 3. Lots de la vague 1

Chaque lot ne modifie que les fichiers listés (chemins relatifs à `backend/app/` sauf mention contraire).

| Lot | Branche | Périmètre | Fichiers possédés | Dépend de |
|---|---|---|---|---|
| **L1 Règles** | `claude/tourneo-l1-regles` | RM-01 à RM-11, RM-14 à RM-17 : une fonction par règle + `check_plan` ; tests `test_RM_xx_…` | `planning/violations/` ; `tests/unit/rules/` | domaine, timing |
| **L2 Moteur** | `claude/tourneo-l2-moteur` | OR-Tools multi-compartiment, multi-tournée, multi-dépôt ; matrice OSRM + repli haversine ; compartiments ; affectation chauffeurs ; jeux fictifs + générateur ; tests §7.5 | `planning/engine/`, `planning/fixtures.py` ; `data/fixtures/` ; `scripts/gen_fixtures.py` ; `tests/unit/engine/` | domaine, timing, contrat L1 |
| **L3 Référentiels et imports** | `claude/tourneo-l3-referentiels` | CRUD F1.1–F1.5 ; `ImportSource` / `ExcelImportSource` ; prévisualiser / appliquer (stations, camions, chauffeurs, dépôts, commandes) ; fichiers modèles | `referentials/` (hors `models.py`), `imports/` (hors `models.py`) ; `data/templates/` ; `tests/integration/referentials/`, `tests/integration/imports/` | socle |
| **L4 Commandes et disponibilité** | `claude/tourneo-l4-commandes` | F2.1–F2.4, F3.1, F3.3, F3.4 ; confirmation / annulation / report | `orders/`, `availability/` (hors `models.py`) ; `tests/integration/orders/`, `tests/integration/availability/` | socle |
| **L5 Service de plans** | `claude/tourneo-l5-plans` | Base ↔ domaine, calcul en tâche de fond + `/tasks`, lecture d'un plan, édition manuelle (déplacer, réordonner, affecter, verrouiller), recalcul, publication (409), versions (RM-18), feuilles de route PDF | `planning/service.py`, `planning/router.py`, `planning/schemas.py`, `planning/tasks.py`, `planning/editing.py`, `planning/versions.py`, `planning/route_sheet.py`, `planning/templates/` ; `tests/integration/planning/` | contrats L1, L2 |
| **L6 Chargement et livraisons** | `claude/tourneo-l6-chargement` | F7.1–F7.4 ; RM-12, RM-13 ; fiche de chargement PDF + envoi SMTP ; statuts de tournée et d'arrêt | `loading/` (hors `models.py`) ; `tests/unit/loading/`, `tests/integration/loading/` | socle |
| **L7 Comparaison A/B** | `claude/tourneo-l7-comparaison` | F8.1–F8.6 : métriques, import de la journée de référence, rejeu, comparaison + PDF (cartes en SVG), tableau de bord du jour | `comparison/` ; `imports/reference_day.py` ; `tests/unit/comparison/`, `tests/integration/comparison/` | contrat L5 |
| **L8 Administration et infrastructure** | `claude/tourneo-l8-admin-infra` | F9.1–F9.3 (utilisateurs, paramètres, audit) ; limitation de débit et révocation à la déconnexion ; `docker-compose.yml` complet (caddy, api, worker, db, redis, osrm, frontend, backup), images, Caddyfile, OSRM profil camion, sauvegardes ; `/health/osrm` ; documentation d'exploitation | `users/`, `admin/`, `audit/` (hors `models.py`, `listener.py`) ; racine : `docker-compose.yml`, `infra/`, `backend/Dockerfile` ; `docs/EXPLOITATION.md` ; `tests/integration/admin/` | socle |
| **L9 Socle de l'interface** | `claude/tourneo-l9-frontend` | Vite + React + TS + Tailwind + shadcn/ui ; coquille et navigation des 11 écrans ; connexion + rafraîchissement du jeton ; client API ; `src/i18n/fr.ts` ; composants partagés (tableau clavier, carte MapLibre, formulaires, violations) ; écrans Connexion, Référentiels, Administration | `frontend/` | spec §9, CONTRATS §7 |

## 4. Lots de la vague 2 (après intégration de la vague 1)

| Lot | Périmètre |
|---|---|
| **L10 Événements** | F6.1–F6.4, RM-19 : panne, chauffeur indisponible, pénurie produit ; journal de la journée |
| **L11 Écrans Journée, Commandes, Disponibilité** | Écrans 2, 3, 4 |
| **L12 Écran Plan de tournées** | Écran 5 : liste, carte, détail, glisser-déposer, violations, verrouillage, recalcul, publication, versions |
| **L13 Écrans Chargement, Suivi, Journal** | Écrans 6, 7, 8 (assistant de réaffectation compris) |
| **L14 Écran Comparaison et tableau de bord** | Écran 9, tableau de bord du jour |
| **L15 Démonstration de bout en bout** | Jeux fictifs convertis en fichiers importables, scénario complet d'une journée (commande → livraison) en test automatisé, types TypeScript générés depuis l'OpenAPI |

## 5. Étapes d'intégration (session principale)

1. Recevoir le compte rendu de chaque lot (tests, écarts au contrat, questions, migrations ajoutées).
2. Fusionner les branches dans la branche d'intégration, dans l'ordre : L1 → L2 → L3 → L4 → L6 → L8 → L5 → L7 → L9.
3. Fusionner les éventuelles têtes Alembic multiples, régénérer `uv.lock` si besoin.
4. Lancer toute la suite (`uv run pytest`, lint, build du front) ; brancher le moteur réel et les règles
   réelles dans les tests d'intégration du service de plans ; corriger les frictions.
5. Consolider `docs/questions/*.md` dans `docs/QUESTIONS.md`.
6. Ouvrir la vague suivante sur la branche d'intégration à jour.

## 6. Suivi des critères d'acceptation (spec §13)

| # | Critère | Porté par |
|---|---|---|
| 1 | Rejeu de la journée A sans violation bloquante, au moins autant de commandes servies | L2, L5, L7 |
| 2 | Kilométrage calculé inférieur d'au moins `ab_success_threshold_pct` | L2, L7 |
| 3 | Calcul < 60 s sur `demo_scale` et sur données réelles | L2 |
| 4 | Dispatcher autonome après une heure de formation | L9, L11, L12, L13 |
| 5 | RM-01 à RM-20 testées ; couverture du module `planning` ≥ 80 % | L1, L2, L5, L6, L10, socle (RM-20) |
| 6 | Redémarrage sans perte, sauvegarde restaurable en moins de 30 minutes | L8 |
| 7 | Aucun fichier Excel lu hors de `imports/` | L3, L7 (contrôle automatisé en vague 3) |
