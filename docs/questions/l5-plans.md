# Questions du lot L5 — Service de plans

Zones d'ombre rencontrées, valeur par défaut adoptée en attendant la réponse. Aucune ne bloque.

## Modèle de versions (F5.5, RM-18)

| # | Question | Valeur adoptée |
|---|---|---|
| L5-1 | Granularité des versions : faut-il une version à chaque modification, y compris sur un brouillon ? | Non. Un **brouillon** se modifie sur place ; chaque modification est journalisée dans `events` (`manual_edit` ou `replan` : qui, quoi, quand). Une **version** = un cycle de publication : toute modification d'un plan publié le copie en version *n+1* brouillon, modifiée ensuite sur place. `GET /plans/{id}/versions` renvoie les versions de la lignée, chacune avec son journal de modifications. |
| L5-2 | RM-18 « la version publiée précédente est archivée » : à quel moment ? | À la **publication** de la nouvelle version (conforme à la docstring de `new_version`). D'ici là, la version publiée reste la référence du terrain et n'est pas modifiable une seconde fois (409 `draft_version_exists`, avec l'identifiant du brouillon en cours). |
| L5-3 | Restaurer une version : remplace-t-on le plan en cours ? | Non : la restauration crée une nouvelle version brouillon, copie de la version demandée, recontrôlée avec les données du moment ; elle prend effet à sa publication. Le brouillon en cours de la lignée est archivé (abandonné, jamais supprimé). |
| L5-4 | Une modification d'un plan publié change les identifiants de tournées et d'arrêts (copie). | L'API accepte les identifiants de la version publiée et les traduit ; la réponse porte le nouveau plan (autre `id`). L'écran doit basculer sur le plan renvoyé. |
| L5-5 | Le chargement réel (`loadings.trip_id`, lot L6) reste attaché à la tournée de l'ancienne version quand une nouvelle version est créée (panne, F6.1). | Non traité par ce lot : à trancher à l'intégration (rattacher le chargement à la tournée copiée, ou le lire par lignée). |

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
| L5-15 | Plan de chargement impossible après modification (`assign_compartments` renvoie `None`). | Chargement laissé vide et violation bloquante `RM-05` ajoutée par le service si les règles n'en signalent pas déjà une (RM-05/06/07) sur la tournée. À revoir avec le lot L1 pour éviter le doublon. |
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
