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

## 8. État à la suspension du 28/11/2026

Le projet a été repris le 28/11/2026 puis remis en pause le même jour, à la demande du responsable. Chaque
sous-session a terminé sa liste ou son étape en cours, poussé sa branche et arrêté ses serveurs ; aucune n'a
laissé de commit « WIP ». Pour reprendre : écrire « reprise » aux sous-sessions concernées, ou repartir des branches.

### Ce qui est fusionné dans `claude/charming-wright-yri5q4`

Les sept branches de la première suspension (21/11), le nettoyage des noms de schémas en double de l'OpenAPI
(test `backend/tests/unit/test_openapi.py`), et le lot L4 du 28/11 (commandes d'une journée de référence exclues
de la Journée, reliquat visible sur une commande). Dernier état vérifié : back-end 776 tests verts hors tests
lents, 1 échec attendu (défaut D8, corrigé par L6 sur sa branche), 1 test ignoré ; interface 315 tests, lint et
build verts.

### Branches à fusionner à la reprise (dans cet ordre)

| Branche | Tête | Contenu non fusionné | État annoncé par le lot |
|---|---|---|---|
| `claude/tourneo-l3-referentiels` | `17389dd` | Ré-import sans doublon quel que soit le statut ; fichiers modèles enrichis en un jeu planifiable (2 dépôts, 6 stations, 4 camions, 5 chauffeurs, 7 commandes sans date) ; `ST-AKWA` passe au gabarit grand | 783 verts (suite complète) |
| `claude/tourneo-l6-chargement` | `045cd0d` | **Défaut D8 corrigé** (livraison d'une commande planifiée en partie) ; faux RM-13 après une panne corrigé ; `orders.service.mark_fully_delivered` | 785 verts, 1 échec attendu (reliquat d'une commande sous-livrée, corrigé par L5) |
| `claude/tourneo-l5-plans` | `beac4b3` | Ressources engagées dans les autres plans publiés du jour (RM-02, RM-11, RM-14) ; reliquat sur le réellement livré ; `display_label`, `is_current` | 781 verts |
| `claude/tourneo-l7-comparaison` | `ddfc576` | Tableau de bord sur tous les plans publiés du jour (`plans[]`, `pending_drafts[]`) ; réserve « ressources inégales » dans la comparaison et le PDF | 779 verts |
| `claude/tourneo-l9-frontend` | `2e2e103` | Bulle de carte dans le cadre ; `SortableList` étendu ; alerte « plan resté en brouillon » dans la cloche ; pages d'attente supprimées ; captures du mode démonstration | lint, 323 tests, build verts |
| `claude/tourneo-l11-ecrans-journee` | `0828121` | Ajouts du socle adoptés ; bandeau `pending_draft` ; jeu d'essai préfixé `L11`, stations choisies par code | lint, 316 tests, build verts |
| `claude/tourneo-l12-ecran-plan` | `059b666` | Sélecteur de plan (nature, plan par défaut) ; bandeau « version créée par un événement » ; deux plans publiés le même jour | lint, 320 tests, build verts |
| `claude/tourneo-l13-ecrans-execution` | `2d3cf87` | Assistant de réaffectation enchaîné sur les autres tournées du camion ; droits par `useCan` ; jeu d'essai avec ses propres dépôts ; retard recalculé | lint, 318 tests, build verts |

Après fusion : `uv run alembic upgrade heads`, `./scripts/gen_api_types.sh`, suite back-end complète,
`pnpm lint && pnpm test && pnpm build`. Les nouveaux champs de l'API casseront la compilation de quelques
données de test de l'interface (comme à chaque fusion) : les compléter.

### À vérifier en premier après fusion

1. **L5 + L6 ensemble** : les deux correctifs du reliquat et de la livraison partielle n'ont pas été essayés l'un
   avec l'autre. Le test `test_reliquat_d_une_commande_sous_livree_repris_par_le_service_de_plans` (marqué
   échec attendu par L6) doit passer : retirer sa marque. Vérifier qu'une commande sous-livrée, repassée
   `confirmed`, est bien reprise par le calcul suivant.
2. **Suite complète des parcours de navigateur**, deux passes sans vider la base : L11 et L12 ont vu deux
   parcours de L13 en échec (`l13-evenements` déclaration de pénurie, `l13-execution` retard 14 / 15 min), mais
   avec la version de L13 antérieure à ses correctifs du 28/11. Écrire « branches fusionnées » à L9.
3. `display_label` / `is_current` (L5) contre l'écran Plan (L12), puis retirer les champs facultatifs ajoutés à
   la main dans `frontend/src/features/plan/types.ts`.
4. Fichiers d'autres lots touchés par L3, L5 et L7 pour garder les tests verts
   (`backend/tests/e2e/test_journee_perturbee.py` par L5 **et** L7 : conflit possible ;
   `tests/integration/comparison/test_reference_day.py` et `data/fixtures/demo_*/import/*.xlsx` par L3).

### Travail restant

| Lot | Reste à faire |
|---|---|
| L2 | **Défaut du moteur un dimanche** (trouvé par L12, question A6 de `docs/questions/l12-ecran-plan.md`) : `demo_douala` avec 30 000 L de gasoil au dépôt pour 43 000 L demandés → 36 000 L planifiés et RM-08 bloquant dès le calcul, uniquement pour un dimanche (3 fois sur 3 ; 0 sur 5 les autres jours). Vérifier aussi que le moteur renvoie telles quelles les tournées figées sans livraison que L5 lui passe (`seq` > 9000). |
| L10 | Exposer l'heure de saisie d'un événement (`created_at`) dans `EventOut` : le Journal mélange heure de l'événement et heure de saisie. Trancher : une pénurie déclarée après une panne ne compte plus le produit déjà chargé sur la tournée d'origine (stock de 1 L accepté). |
| L15 | `docs/DEMO.md` : D8 et E4 corrigés, constat du ré-import à retirer, récit de la journée perturbée (voir décision ci-dessous), écarts E1 à E6 traités ; revérification finale et re-mesure. |
| L9 | Double passe de la suite complète des parcours ; retirer l'import des dépôts du contrôle préalable (L13 crée les siens) et, si possible, l'ordre imposé de `e2e/run.mjs`. |
| L13 | Vérifier le message « livrée en partie » contre le correctif réel de L6 (testé sur doublure). |
| L11 | Vérifier le bandeau `pending_draft` contre la vraie API. |
| Intégration | Mise à jour de `docs/QUESTIONS.md` avec les questions ajoutées le 28/11. |

### Décisions attendues du responsable

| Sujet | Question | Appliqué sur les branches |
|---|---|---|
| Récit de la démonstration | Dans la journée perturbée, la commande de l'arrêt sauté n'est plus resservie par un second calcul : trois camions ont fait leurs deux chargements du jour, le quatrième est en panne. Relever le nombre de chargements du dépôt de démonstration, ou assumer la commande non servie ? | Commande non servie (test adapté par L5) ; `docs/DEMO.md` décrit encore l'ancien déroulé |
| Publication après un incident | Pour la suite d'un même incident, l'assistant demande la publication, sans quoi la version resterait en brouillon une fois toutes les tournées traitées. | Oui (L13) |
| Seuil « entièrement livrée » | Une commande passe « livrée » à partir de 98 % du volume demandé (réutilisation de la tolérance de chargement). Paramètre distinct ? | Tolérance de chargement, 2 % (L6) |
| Journal d'audit | L'écran Administration est ouvert à la direction, réduit à l'onglet d'audit. | Oui (L9) |
| Bandeau « version en brouillon » | Affiché à part, au-dessus des alertes de la Journée, plutôt que dans la liste. | À part (L11) |

### Constat sur le socle

Le défaut « lecture juste après une écriture » signalé le 21/11 n'a été reproduit ni avec le correctif
(validation de la transaction avant l'envoi de la réponse) ni sans lui : 600 puis 400 enchaînements corrects sur
un vrai serveur à deux processus (mesure de L3). Le correctif reste en place mais n'est pas prouvé ; les deux
signalements d'origine venaient des scripts de mise en données de L13 et L14.

### Hors de portée dans cet environnement

Construction et lancement des images Docker, serveur de routage OSRM réel sur la carte du Cameroun, certificat
HTTPS, restauration chronométrée (critère d'acceptation 6), formation d'un dispatcher (critère 4). Voir
`docs/EXPLOITATION.md` §12 et `docs/DEMO.md`.
