# Questions du lot L5 — Service de plans

Zones d'ombre rencontrées, valeur par défaut adoptée en attendant la réponse. Aucune ne bloque.

## Modèle de versions (F5.5, RM-18)

| # | Question | Valeur adoptée |
|---|---|---|
| L5-1 | Granularité des versions : faut-il une version à chaque modification, y compris sur un brouillon ? | Non. Un **brouillon** se modifie sur place ; chaque modification est journalisée dans `events` (`manual_edit` ou `replan` : qui, quoi, quand). Une **version** = un cycle de publication : toute modification d'un plan publié le copie en version *n+1* brouillon, modifiée ensuite sur place. `GET /plans/{id}/versions` renvoie les versions de la lignée, chacune avec son journal de modifications. |
| L5-2 | RM-18 « la version publiée précédente est archivée » : à quel moment ? | À la **publication** de la nouvelle version (conforme à la docstring de `new_version`). D'ici là, la version publiée reste la référence du terrain et n'est pas modifiable une seconde fois (409 `draft_version_exists`, avec l'identifiant du brouillon en cours). |
| L5-3 | Restaurer une version : remplace-t-on le plan en cours ? | Non : la restauration crée une nouvelle version brouillon, copie de la version demandée, recontrôlée avec les données du moment ; elle prend effet à sa publication. Le brouillon en cours de la lignée est archivé (abandonné, jamais supprimé). |
| L5-4 | Une modification d'un plan publié change les identifiants de tournées et d'arrêts (copie). | L'API accepte les identifiants de la version publiée et les traduit ; la réponse porte le nouveau plan (autre `id`). L'écran doit basculer sur le plan renvoyé. |
| L5-5 | Chargement réel (`loadings`, lot L6) quand une nouvelle version d'un plan publié est créée. | Le chargement et ses lignes sont **recopiés** sur la tournée correspondante de la nouvelle version (comme les violations RM-13) ; l'ancienne version garde son relevé. Une saisie faite ensuite sur l'ancienne version n'est pas reportée sur le brouillon en cours. |

## Livraison partielle (RM-16, question S7)

| # | Question | Valeur adoptée |
|---|---|---|
| L5-6 | « Le reste restant `confirmed` » alors qu'une commande n'a qu'un statut. | Pas de scission de commande. **Reliquat = volume demandé − volume planifié dans les plans `published` de type `computed`**. À la publication : commande entièrement planifiée → `planned` ; planifiée en partie → reste `confirmed`. Le calcul suivant (`build_problem` sans `order_ids`) ne reprend que le reliquat ; quand le reliquat tombe à zéro, la commande passe `planned`. `service.order_remainders()` donne le reliquat aux écrans. |
| L5-7 | Le reliquat se planifie-t-il le même jour ou un autre jour ? | Le même jour (la commande garde sa date) : un second plan du jour, de lignée distincte. Le report à un autre jour relève du statut `postponed` (lot commandes). |
| L5-8 | Deux plans publiés le même jour (plan initial + plan des reliquats) partagent camions et chauffeurs : le chevauchement (RM-02) n'est contrôlé qu'à l'intérieur d'un plan. | Non contrôlé entre plans. À confirmer : faut-il interdire plusieurs plans publiés par jour, ou étendre RM-02 ? |
| L5-9 | Une nouvelle version publiée ne sert plus une commande que la précédente servait. | La commande repasse `planned` → `confirmed` à la publication. |

## Édition manuelle (F5.1, F5.2)

| # | Question | Valeur adoptée |
|---|---|---|
| L5-10 | Que devient une tournée dont on a retiré le dernier arrêt ? | Elle est supprimée du plan (les numéros des autres tournées ne changent pas). |
| L5-11 | Peut-on modifier à la main une tournée verrouillée ? | Oui : le verrou ne protège que du recalcul (RM-17). |
| L5-12 | Heure de début d'une tournée après modification. | Elle garde son heure de début ; si le même camion a une tournée précédente qui finit plus tard, elle est décalée au retour de celle-ci. Le reste (chauffeur partagé…) est constaté par RM-02. |
| L5-13 | Affecter un camion ou un chauffeur non affectable (RM-03, RM-04). | Accepté et enregistré avec la violation ; seule la publication est bloquée (F5.2). |
| L5-14 | Arrêt déjà livré ou sauté, tournée terminée. | Non déplaçable / non modifiable (409). |
| L5-15 | Plan de chargement impossible après modification (`assign_compartments` renvoie `None`). | Chargement laissé vide : la règle RM-05 du lot L1 signale alors en bloquant chaque volume qui ne tient pas. Le service n'ajoute sa propre violation `RM-05` que si les règles n'en renvoient aucune (RM-05/06/07) pour la tournée (filet de sécurité). |
| L5-16 | Paramètres utilisés pour recontrôler un plan existant. | Ceux de son calcul (`params_snapshot`), complétés par les réglages courants pour les clés absentes. |

## Calcul, recalcul, publication

| # | Question | Valeur adoptée |
|---|---|---|
| L5-17 | `POST /plans/{id}/recompute` : synchrone ou tâche de fond ? | Tâche de fond comme le calcul : 202 + `task_id`, `plan_id` final dans `GET /tasks/{task_id}`. |
| L5-18 | Recalcul d'un plan dont des tournées sont déjà en cours d'exécution. | Les tournées au statut ≠ `planned` sont figées comme si elles étaient verrouillées. |
| L5-19 | Commandes reprises par un recalcul. | Commandes `confirmed` du jour + commandes du plan encore `confirmed` ou `planned` (les reportées / annulées sortent). Rejeu et journée de référence : uniquement les commandes du plan. |
| L5-20 | RM-15 « reportée explicitement ». | Commande au statut `postponed` (ou `cancelled`) : elle reste listée dans les non servies du plan, mais n'est plus soumise aux règles. |
| L5-21 | Quels plans se publient ? | Seulement `kind = computed` (ni journée de référence, ni rejeu). |
| L5-22 | Feuille de route d'un plan non publié. | Délivrée avec la mention « BROUILLON — plan non publié » (ou « VERSION ARCHIVÉE »). Les PDF sont produits à la demande, pas stockés à la publication. |
| L5-23 | `constraint_violations` n'a pas de colonne `order_id` (présent dans `ViolationD`). | L'identifiant de commande n'est pas conservé ; le message de la règle doit désigner la commande. Pas de migration ajoutée. |
| L5-24 | `GET /tasks/{id}` avec un identifiant inconnu. | État `pending` (Celery ne distingue pas inconnu et en attente). |
| L5-25 | Violations `RM-13` (écrites par le chargement, lot L6). | Jamais effacées par un recontrôle ni par un recalcul (sauf si leur tournée est supprimée) ; recopiées sur la tournée correspondante d'une nouvelle version. |
| L5-26 | Plans `manual_reference` et `replay` (lot L7). | `manual_reference` : lecture seule — édition, recalcul et restauration refusés (409 `plan_is_reference`), publication refusée (409 `plan_kind_not_publishable`). `replay` : publication refusée ; l'édition et le recalcul restent permis (brouillon de comparaison, sans effet sur les commandes). À confirmer. |
| L5-27 | Tournée ayant un chargement enregistré. | Son dernier arrêt ne peut pas être déplacé (409 `trip_already_loaded` : la tournée serait supprimée avec son chargement) ; un recalcul la fige comme une tournée verrouillée. |
| L5-28 | Journée de référence passée par un dépôt, un camion ou un chauffeur désactivé ou supprimé depuis. | `build_problem(..., extra_depot_ids, extra_truck_ids, extra_driver_ids)` les inclut ; les stations des commandes sont toujours incluses. |
| L5-29 | Cohérence du plan lu après le report ou l'annulation d'une commande (A1 du lot L12). | `POST /orders/{id}/postpone` et `/cancel` appellent `service.recheck_drafts_for_orders` : les plans **brouillons** (hors journée de référence) qui portent la commande sont recontrôlés dans la même transaction. Les autres chemins qui changent un statut de commande (`orders.service.mark_postponed` appelé directement) doivent l'appeler eux-mêmes. |
| L5-30 | Tous les compartiments du camion dans la lecture d'un plan (A3 du lot L12). | Nouveau champ `trips[].compartments` (vides compris, par position). `trips[].loads` reste la liste des seuls compartiments chargés : des consommateurs en dérivent le chargement réel à saisir (aides de test du lot L10), y ajouter des lignes vides les cassait. |
| L5-31 | Avancement saisi sur la version en vigueur pendant qu'un brouillon est en préparation (D3 du lot L15). | À la publication du brouillon, l'état d'exécution est repris de la version en vigueur, tournée par tournée et arrêt par arrêt : **le plus avancé des deux états l'emporte** (le brouillon peut lui-même avoir avancé, ex. tournée close par une panne). Les heures et volumes réels manquants sont complétés ; le chargement est repris s'il manque ou s'il a été saisi ou corrigé après la copie. La correspondance des tournées et arrêts entre versions est journalisée dans l'événement de création de version (`trip_ids`, `stop_ids`), sans migration. Limite : une tournée créée par un recalcul n'a pas d'ancêtre et ne reprend rien. |
| L5-32 | Arrêt sauté (D4, D5 du lot L15). | Un arrêt `skipped` ne livre rien : ses livraisons ne comptent ni dans le reliquat, ni pour les règles (RM-15, RM-16), ni dans les métriques, ni comme « servies » par une tournée figée lors d'un recalcul — les commandes sont replanifiées ou listées non servies. |
| L5-33 | Stock dépôt quand plusieurs plans sont publiés le même jour (D6 du lot L15). | Le stock passé au moteur et aux règles est le stock saisi moins les volumes des autres plans publiés calculés du jour (hors lignée du plan contrôlé ; arrêts sautés compris, le produit ayant quitté le dépôt). Le message RM-08 affiche donc le stock restant, pas le stock saisi. Non appliqué aux rejeux et journées de référence. |
