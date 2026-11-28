# Questions du lot L12 — Écran Plan de tournées

Zones d'ombre rencontrées, choix fait en attendant la réponse. Aucune ne bloque. Les défauts constatés sur
l'API réelle sont décrits en fin de fichier (le back-end n'a pas été modifié).

## Choix d'interface à confirmer

| # | Question | Choix fait |
|---|---|---|
| L12-1 | Plusieurs plans le même jour (versions, plan des reliquats, journée de référence, rejeu) : lequel afficher par défaut ? | Le **plan du jour en vigueur le plus important** : parmi les plans calculés en vigueur (`is_current` du serveur s'il est fourni, sinon « publié »), celui qui a le plus de tournées, puis le plus de volume, puis le plus récent. Sans plan en vigueur : le brouillon calculé le plus important ; sans plan calculé : le plan non archivé le plus récent. Un brouillon en préparation ne s'ouvre donc plus par défaut : la version publiée le signale et y mène (écart E2 de `docs/DEMO.md`). Le sélecteur dit la nature de chaque plan (« Plan du jour », « Journée de référence », « Rejeu »), numérote les plans de même nature (« Plan du jour 2 (1 tournée) ») et reprend `display_label` quand le serveur le fournit. L'adresse porte `?plan=<id>` ; un plan d'un autre jour dans l'adresse est ignoré. |
| L12-2 | Faut-il une confirmation avant la première modification d'un plan publié (qui crée une version, RM-18) ? | Non : un bandeau l'annonce avant, une notification et un bandeau le rappellent après (« Nouvelle version brouillon… la version publiée reste la référence »). Ce n'est pas destructif : la version publiée n'est pas touchée. |
| L12-3 | Plan publié dont un brouillon est déjà en préparation (409 `draft_version_exists`). | L'écran le sait par la liste des plans du jour : la version publiée est alors en lecture seule avec un bouton « Ouvrir le brouillon ». Si le 409 survient quand même (brouillon créé ailleurs entre-temps), une boîte propose d'ouvrir le brouillon désigné par `details[0].draft_plan_id`. |
| L12-4 | Glisser un arrêt sur une tournée : à quelle position ? | Dépôt sur un **arrêt** = insertion à sa place ; dépôt sur une **tournée** (carte de la liste, en-tête du tableau) = ajout en fin de tournée. La position se règle ensuite dans la tournée. |
| L12-5 | « Les mêmes actions au clavier ». | Trois voies : poignée dnd-kit (Espace, flèches, Espace) ; **Alt + ↑ / ↓** sur un arrêt (d'un cran dans la tournée ; au bord, passage à la tournée voisine : fin de la précédente, début de la suivante) ; menu « Déplacer vers… » de chaque arrêt (tournée d'arrivée, en fin). Le focus suit l'arrêt déplacé, y compris après bascule sur une nouvelle version. |
| L12-6 | Modifications simultanées. | Une seule modification à la fois : pendant un appel, les autres actions d'édition sont désactivées (≈ 0,2 à 0,5 s constatés). Les valeurs calculées (heures, km, violations) ne sont jamais estimées côté écran : seuls l'ordre, les volumes et le remplissage sont anticipés, le reste attend la réponse. |
| L12-7 | « Reporter » depuis le bandeau : seulement les commandes urgentes ? | Proposé pour toute commande non servie encore `confirmed` (c'est la transition existante `POST /orders/{id}/postpone`), avec confirmation ; mis en avant pour les urgentes (RM-15). Uniquement sur un brouillon calculé. À restreindre aux urgentes si OLA le préfère. |
| L12-8 | Feuilles de route d'un brouillon (l'API les délivre avec la mention « BROUILLON », L5-22). | Non proposées : les boutons PDF n'apparaissent qu'une fois le plan publié (ou archivé), conformément à F5.4. |
| L12-9 | Confirmation de « Recalculer en conservant ». | Toujours demandée (le recalcul défait les ajustements manuels des tournées non verrouillées) ; marquée destructive si aucune tournée n'est verrouillée. |
| L12-10 | Retirer le chauffeur d'une tournée (`driver_id: null`). | Permis par la liste (« — Sans chauffeur — ») : l'API l'accepte et signale RM-01. |
| L12-11 | Camions et chauffeurs proposés pour une réaffectation. | Ceux de `GET /availability/trucks|drivers?day=` ; les non affectables restent sélectionnables mais portent leur motif (`block_reason`), puisque l'API accepte l'affectation et affiche la violation (L5-13). |
| L12-12 | Compartiments non utilisés d'un camion. | Résolu par l'API (`trips[].compartments`, tous les compartiments, vides compris) : l'écran dessine le camion entier (une cuve par compartiment, largeur proportionnelle à la capacité) puis le détail par compartiment. |
| L12-13 | Couleur des tournées. | Liée au numéro de tournée (`routeColor(seq − 1)`) : identique dans la liste, la carte et le tableau, stable après une modification. La palette partagée a 10 teintes : au-delà, elles se répètent. |
| L12-14 | Suivi du recalcul après rafraîchissement de la page. | L'identifiant de tâche est gardé en `sessionStorage` par plan ; « Ne plus suivre » l'efface (utile car `GET /tasks/{id}` répond `pending` pour un identifiant inconnu, L5-24). |
| L12-15 | Version affichée archivée par ailleurs (nouvelle version publiée après une panne ou une pénurie, lot L10). | La liste des plans du jour est relue toutes les 60 s (et au retour sur l'onglet). Quand la version affichée passe de publiée à archivée : notification et annonce « La version n affichée vient d'être archivée : la version m est maintenant en vigueur », lecture seule, bandeau avec « Afficher la version en vigueur » et lien vers le Journal des événements. L'écran ne bascule pas tout seul (le dispatcher peut être en train de lire). L'API ne dit pas si la nouvelle version vient d'un événement : le lien vers le Journal est donc proposé dans tous les cas. |
| L12-16 | Liens vers l'exécution depuis le détail d'une tournée. | « Chargement » (`/chargement?day=&trip=`) et « Suivi » (`/suivi?day=&trip=`) uniquement quand le plan est **publié**, et seulement pour les rôles qui voient ces écrans. |
| L12-17 | Version brouillon née d'un événement (panne, chauffeur indisponible, pénurie) et restée non publiée. | Reconnue en lisant `GET /events?plan_id=<brouillon>&day=<jour>&type=…` (le paramètre `day` est nécessaire : sans lui l'API filtre sur aujourd'hui). Bandeau en tête : « Version N créée par un événement : X violation(s) bloquante(s) à corriger avant publication », rappel de la version publiée qui reste la référence, type, heure et résumé de l'événement, liens vers le Journal et la version publiée. Un brouillon né d'une modification manuelle garde le bandeau habituel. |
| L12-18 | Deux plans du jour publiés le même jour (L5-7, L5-8). | L'écran n'affiche jamais qu'un plan à la fois (liste, carte, détail, violations, indicateurs sont ceux du plan choisi) ; une mention « n plans du jour publiés ce jour : chacun a ses propres tournées » accompagne le sélecteur. Les numéros de tournée repartent de 1 dans chaque plan : c'est le sélecteur qui les distingue. |

## Défauts et manques constatés sur l'API réelle

| # | Route | Entrée | Attendu | Constaté | Contournement dans l'écran |
|---|---|---|---|---|---|
| A1 | `POST /orders/{id}/postpone` puis `GET /plans/{plan_id}` | Report d'une commande urgente non servie | Plan relu sans RM-15, `blocking_count` et `publishable` à jour | **Corrigé côté back-end** (recontrôle des brouillons dans la même transaction) | Contournement `reconcileUrgentViolations` retiré ; parcours « reporter → publier » vérifié contre la vraie API (`e2e/l12-plan.e2e.ts`). |
| A2 | `GET /plans/{id}` — `violations[]` | — | Pouvoir relier une violation à sa commande | Pas d'`order_id` (L5-23) : une violation RM-15 n'est reliée ni à une tournée ni à un arrêt, seulement à son message | Clic sans effet de sélection pour ces violations ; la commande est visible en tête du bandeau. |
| A3 | `GET /plans/{id}` — compartiments vides | — | Tous les compartiments du camion | **Corrigé** : nouveau champ `trips[].compartments[]` (`loads` inchangé) | Utilisé par le plan de chargement (L12-12). |
| A4 | OpenAPI | — | Noms de schémas uniques | `PlanSummaryOut`, `StopOut`, `UnservedOut` existent dans plusieurs modules : les types générés s'appellent `app__planning__schemas__PlanSummaryOut`… | `features/plan/types.ts` déduit `Stop` et `Unserved` de `PlanOut` ; seul `PlanSummary` cite le nom préfixé. |
| A5 | `POST /plans/{id}/trips/{trip_id}/…` | Modification | Résumé de ce qui a été fait | **Corrigé** : `last_edit: {action, summary}` dans la réponse | L'annonce (zone `aria-live`) reprend `last_edit.summary` tel quel ; le texte reconstruit côté écran est supprimé. |

## Besoins non couverts par les composants partagés

- `MapView` : pas de clic ni de survol sur le **tracé** d'une tournée (seulement sur les arrêts), pas de recadrage
  sur une tournée donnée, pas de style propre aux commandes non servies (affichées comme stations « inactives »),
  les arrêts des tournées en retrait restent opaques, palette de 10 couleurs.
- `SortableList` embarque son propre `DndContext` : inutilisable pour déplacer un arrêt d'une liste à une autre.
  L'écran utilise dnd-kit directement (`features/plan/components/dnd.tsx`), avec les mêmes capteurs.
- `ViolationsPanel` : hauteur de liste fixée en interne (surchargée par une classe), type `Violation` sans `id`.
- `playwright.config.ts` : le projet `captures` tourne sur doublures complètes ; les captures L12 demandent un vrai
  plan et sont donc un test du projet `e2e`, lancé à la demande (`L12_CAPTURES=1`).
