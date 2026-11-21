# Questions du lot L12 — Écran Plan de tournées

Zones d'ombre rencontrées, choix fait en attendant la réponse. Aucune ne bloque. Les défauts constatés sur
l'API réelle sont décrits en fin de fichier (le back-end n'a pas été modifié).

## Choix d'interface à confirmer

| # | Question | Choix fait |
|---|---|---|
| L12-1 | Plusieurs plans le même jour (versions, plan des reliquats, journée de référence, rejeu) : lequel afficher par défaut ? | Le plan **calculé non archivé le plus récent** (donc le brouillon en cours s'il existe, sinon la version publiée). Les autres se choisissent dans le sélecteur, regroupés par lignée (« Plan 1 — calculé », versions de la plus récente à la plus ancienne). L'adresse porte `?plan=<id>` ; un plan d'un autre jour dans l'adresse est ignoré (le jour J l'emporte). |
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
| L12-12 | Compartiments non utilisés d'un camion. | `loads` ne liste que les compartiments chargés : l'écran affiche une jauge par compartiment chargé et le volume total des compartiments inutilisés (capacité du camion − capacités listées), sans appel supplémentaire. |
| L12-13 | Couleur des tournées. | Liée au numéro de tournée (`routeColor(seq − 1)`) : identique dans la liste, la carte et le tableau, stable après une modification. La palette partagée a 10 teintes : au-delà, elles se répètent. |
| L12-14 | Suivi du recalcul après rafraîchissement de la page. | L'identifiant de tâche est gardé en `sessionStorage` par plan ; « Ne plus suivre » l'efface (utile car `GET /tasks/{id}` répond `pending` pour un identifiant inconnu, L5-24). |

## Défauts et manques constatés sur l'API réelle

| # | Route | Entrée | Attendu | Constaté | Contournement dans l'écran |
|---|---|---|---|---|---|
| A1 | `POST /orders/{id}/postpone` puis `GET /plans/{plan_id}` | Report d'une commande urgente non servie d'un plan brouillon | Le plan relu ne porte plus la violation RM-15 ; `blocking_count` et `publishable` sont à jour (RM-15 : « tant qu'elle n'est pas reportée ») | `unserved[].order_status` passe bien à `postponed`, mais `violations` garde RM-15, `blocking_count = 1`, `publishable = false` jusqu'au prochain recontrôle (une modification ou la publication — qui, elle, réussit) | `reconcileUrgentViolations` (`features/plan/edits.ts`) retire à l'affichage les violations RM-15 en trop par rapport aux commandes urgentes encore ouvertes ; le serveur reste juge à la publication. À supprimer quand le plan sera recontrôlé au report (ou à la lecture). |
| A2 | `GET /plans/{id}` — `violations[]` | — | Pouvoir relier une violation à sa commande | Pas d'`order_id` (L5-23) : une violation RM-15 n'est reliée ni à une tournée ni à un arrêt, seulement à son message | Clic sans effet de sélection pour ces violations ; la commande est visible en tête du bandeau. |
| A3 | `GET /plans/{id}` — `trips[].loads` | — | Tous les compartiments du camion, vides compris | Seuls les compartiments chargés | Voir L12-12. |
| A4 | OpenAPI | — | Noms de schémas uniques | `PlanSummaryOut`, `StopOut`, `UnservedOut` existent dans plusieurs modules : les types générés s'appellent `app__planning__schemas__PlanSummaryOut`… | `features/plan/types.ts` déduit `Stop` et `Unserved` de `PlanOut` ; seul `PlanSummary` cite le nom préfixé. |
| A5 | `POST /plans/{id}/trips/{trip_id}/…` | Modification | — | La réponse ne dit pas ce qui a été fait (le résumé n'est que dans `GET …/versions`) | L'écran compose lui-même l'annonce lue par les lecteurs d'écran. |

## Besoins non couverts par les composants partagés

- `MapView` : pas de clic ni de survol sur le **tracé** d'une tournée (seulement sur les arrêts), pas de recadrage
  sur une tournée donnée, pas de style propre aux commandes non servies (affichées comme stations « inactives »),
  les arrêts des tournées en retrait restent opaques, palette de 10 couleurs.
- `SortableList` embarque son propre `DndContext` : inutilisable pour déplacer un arrêt d'une liste à une autre.
  L'écran utilise dnd-kit directement (`features/plan/components/dnd.tsx`), avec les mêmes capteurs.
- `ViolationsPanel` : hauteur de liste fixée en interne (surchargée par une classe), type `Violation` sans `id`.
- `playwright.config.ts` : le projet `captures` tourne sur doublures complètes ; les captures L12 demandent un vrai
  plan et sont donc un test du projet `e2e`, lancé à la demande (`L12_CAPTURES=1`).
