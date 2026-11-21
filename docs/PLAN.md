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

## 7. Avancement

| Date | État |
|---|---|
| 21/11/2026 | Vague 0 faite. Vague 1 : lots L1 à L8 livrés et fusionnés (règles, moteur, référentiels et imports, commandes et disponibilité, service de plans, chargement, comparaison, administration et infrastructure). Calcul réel de bout en bout vérifié (`tests/integration/planning/test_real_engine.py`). L9 (socle de l'interface) en cours. Vague 2 : L10 (événements) et L15 (démonstration de bout en bout) lancés ; les écrans (L11 à L14) partent à la livraison de L9. |
| 21/11/2026 | Vague 1 terminée (L1 à L9). Vague 2 livrée et fusionnée : L10 (événements), L11 à L14 (les onze écrans de la spec), L15 (jeux de démonstration, scénario complet, preuve A/B sur une journée fabriquée). Les défauts d'intégration trouvés par L15 et par les écrans sont corrigés. Vague 3 en cours : adoption des composants partagés, parcours de navigateur rejouables sur une même base, questions consolidées dans `docs/QUESTIONS.md`. Reste hors de portée ici : construction et lancement Docker, serveur de routage réel, restauration chronométrée (voir `docs/EXPLOITATION.md` §12 et `docs/DEMO.md`). |

## 8. État à la suspension du 21/11/2026

Le projet a été mis en pause à la demande du responsable. Chaque sous-session a terminé son étape en cours,
poussé sa branche et arrêté ses serveurs ; aucune n'a laissé de commit « WIP ». Rien de ce qui suit n'est
fusionné dans la branche d'intégration `claude/charming-wright-yri5q4`, qui reste à l'état vérifié `6fe5803`
(plus ce document). Pour reprendre : écrire « reprise » à chaque sous-session concernée, ou repartir des branches.

### Branches à fusionner à la reprise (dans cet ordre)

| Branche | Tête | Contenu non fusionné | État annoncé par le lot |
|---|---|---|---|
| `claude/tourneo-l7-comparaison` | `7eb2df5` | Tableau de bord : champ `pending_draft` et alerte « version en attente de publication » | 768 tests verts hors tests lents |
| `claude/tourneo-l15-demo` | `07e23ba` | `docs/DEMO.md` réécrit et remesuré, journée perturbée (pénurie, panne, arrêt sauté, second plan), critère 4 par l'API, `run_day.py --shortage --breakdown` | 771 verts, 1 ignoré, 1 échec attendu (défaut D8 ci-dessous) |
| `claude/tourneo-l9-frontend` | `9e2a5e3` | Droits par rôle alignés sur l'API, session robuste aux coupures, catalogue complété, contrôle préalable et aide de connexion des parcours, doublures des écrans Chargement / Suivi / Journal | lint, 307 tests, build verts ; une passe complète des parcours verte sur base vierge |
| `claude/tourneo-l11-ecrans-journee` | `eb06841` | Avertissements de cuve du serveur, effacement d'un stock, derniers événements et alertes cliquables sur l'accueil | lint, 281 tests, build verts |
| `claude/tourneo-l12-ecran-plan` | `9929900` | Données d'essai isolées (préfixe `ZL12`, jour vierge, ressources libérées en fin de test), parcours « chauffeur indisponible » corrigé | lint, 287 tests, build verts ; suite complète des parcours verte sur deux passes, sauf un parcours de L13 (voir ci-dessous) |
| `claude/tourneo-l13-ecrans-execution` | `b392554` | Explication de RM-13, version du plan dans les listes, pénurie résolue dans n'importe quel ordre, données d'essai préfixées | lint, 288 tests, build verts |
| `claude/tourneo-l14-ecran-comparaison` | `798fdb7` | Cadrage commun des cartes, couleurs du serveur, scénario de panne, données d'essai préfixées | lint, 288 tests, build verts |

Après fusion : `uv run alembic upgrade heads`, `./scripts/gen_api_types.sh` (nouveaux champs `pending_draft`,
`source: "plan"`, `details[].severity`), suite back-end complète, `pnpm lint && pnpm test && pnpm build`.
Vérifier que `dump.rdb` ne revient pas dans le dépôt.

### Travail restant

| Lot | Reste à faire |
|---|---|
| L4, L5, L6 | **Défaut D8** (trouvé par L15, test en échec attendu dans `backend/tests/e2e/`) : la livraison d'une commande planifiée en partie est refusée (409 `invalid_order_transition`, « confirmée » → « livrée »). Touche toute livraison partielle. |
| L9 | Bulle de la carte rognée près des bords ; `SortableList` (ligne libre, élément figé seul, repère d'insertion) ; captures du mode démonstration ; double passe de la suite complète des parcours sans vider la base. |
| L11 | Parcours fragile : `createOrder` choisit la station par son rang dans la liste (toute station classée avant `ST-AKWA` le casse). Adopter les ajouts de `DataTable`, `Notice`, `Badge`, `SelectField` ; vérifier que l'import des commandes impose le jour J ; préfixer les données d'essai (`e2e/l11-seed.ts`). |
| L12 | Régénérer les captures (elles montrent les anciens libellés) ; afficher la nature d'un plan (référence, rejeu) dans le sélecteur ; choisir le plan ouvert par défaut quand deux plans sont publiés le même jour. |
| L13 | **Parcours `l13-evenements` (pénurie) en échec dans la suite complète** : il attend l'option « Changer de dépôt », donc un second dépôt actif, mais ne le crée pas lui-même ; selon l'ordre des lots, `SCDP-YDE` n'est jamais importé (cause établie par L12). Créer ce dépôt dans son propre jeu. Assistant de réaffectation : enchaîner sur les autres tournées du camion en panne, version restée en brouillon clairement signalée ; retirer le contournement des droits une fois L9 fusionné (`useCan("events.shortage.write")`) ; corriger à la source l'import des dépôts de son jeu d'essai. |
| L14 | Rien d'ouvert. |
| Intégration | Revérifier deux parcours vus en échec par L14 sur une base non vierge et non reproduits par L12 sur deux passes (`l12-plan` bandeau des non servies, `l13-execution` retard 14 / 15 min) ; faire afficher l'alerte `pending_draft` par les écrans Journée et Journal ; renommer les schémas en double de l'OpenAPI (`PlanSummaryOut`, `StopOut`, `UnservedOut`) ; écarts d'interface relevés par L15 (`docs/DEMO.md` §6). |

### Hors de portée dans cet environnement

Construction et lancement des images Docker, serveur de routage OSRM réel sur la carte du Cameroun, certificat
HTTPS, restauration chronométrée (critère d'acceptation 6), formation d'un dispatcher (critère 4). Voir
`docs/EXPLOITATION.md` §12 et `docs/DEMO.md`.
