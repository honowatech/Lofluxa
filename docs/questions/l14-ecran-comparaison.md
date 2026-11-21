# Questions — lot L14 (écran Comparaison A / B)

Aucune ne bloque : un choix par défaut est fait, noté ici, et isolé dans `frontend/src/features/comparison/`.
L'écran n'invente ni indicateur ni règle : lignes, libellés, écarts, sens du « mieux » (`better`) et message
du verdict sont ceux de `GET /comparison` (définitions : `docs/questions/l7-comparaison.md`).

## À trancher avec OLA

| # | Question | Choix fait en attendant |
|---|---|---|
| L14-1 | Le « test réussi » se lit-il sur le seul gain kilométrique (critère 2 de la spec §13), ou faut-il aussi que le plan B serve au moins autant de commandes et n'ait aucune violation bloquante (critère 1) ? L'API donne les trois booléens (`success`, `orders_served_ok`, `no_blocking_violation`) mais pas de verdict global. | Les trois critères sont affichés séparément, chacun avec sa valeur. Le bandeau reprend le message du serveur ; il est vert si les trois sont tenus, **orange « Objectif kilométrique atteint, sous réserve »** si le gain est atteint mais qu'un des deux autres ne l'est pas, rouge si le gain n'est pas atteint, gris si le gain n'est pas calculable. À valider : c'est une présentation, pas une règle (`verdictOutcome` dans `VerdictBanner.tsx`). |
| L14-2 | Le tableau de bord du jour (F8.6) n'a pas d'écran dans la spec §10. Où la direction le lit-elle ? | Volet « Suivi de la journée B » de cet écran (`?vue=suivi`), alimenté par `GET /dashboard?day=` pour le jour J : avancement des tournées du plan publié, retards estimés, alertes actives, actualisé chaque minute. L'écran Journée (lot L11) garde ses propres alertes. |
| L14-3 | Les deux plans comparés sont-ils toujours du même jour ? La journée A (référence) et la journée B (plan calculé et exécuté, F8.3) sont en pratique deux dates différentes. | Chaque côté a son propre sélecteur de jour ; « deux plans quelconques » (F8.4) est pris à la lettre. Le serveur accepte déjà deux plans de jours différents. |
| L14-4 | Comment formuler pour la direction que les distances sont « approchées » (`approximate`) ? | Mention dans le bandeau du verdict, dès qu'un des deux plans est approché : distances à vol d'oiseau corrigé, sans le réseau routier ; les deux plans sont mesurés de la même façon ; les kilomètres affichés ne sont pas ceux de la route. Le texte est à relire par OLA (`fr.screens.comparison.verdict.approximate`). |
| L14-5 | « Gain face aux km réels de A » (`gain_vs_actual_pct`) : faut-il le montrer à la direction, alors qu'il compare des km réels (compteur) à des km estimés ? | Affiché en petit, « à titre indicatif », seulement quand le serveur le fournit. Il ne participe pas au verdict. |

## Choix de réalisation (à valider à l'intégration)

| # | Constat | Décision |
|---|---|---|
| L14-6 | Présélection des deux plans. | Sans choix dans l'URL : A = journée de référence non archivée la plus récente du jour J, B = son rejeu le plus récent (`parent_plan_id`), à défaut la version publiée la plus récente du plan calculé du jour (demande de l'intégration : une panne ou une pénurie crée une nouvelle version publiée). Sans l'un ni l'autre, l'écran propose « Rejouer avec le moteur ». Dès qu'un choix est fait, `a`, `b`, `da`, `db` sont écrits dans l'URL (lien partageable) ; un lien sans `da` / `db` est recalé sur le jour réel des plans. |
| L14-7 | Couleur des tournées : `TripRouteOut.color` (palette du PDF, avec du rouge et de l'orange) ou palette de l'interface ? | Palette `routeColor` de `MapView`, comme les autres écrans : rouge et orange restent réservés aux violations. Conséquence : les couleurs des tracés diffèrent entre l'écran et le PDF. |
| L14-8 | Même cadrage et même échelle des deux cartes : `MapView` cadre sur son contenu et n'accepte pas d'emprise imposée. | Les deux cartes reçoivent les mêmes marqueurs (dépôts et stations des deux plans réunis) ; seules les tournées diffèrent. L'emprise est donc identique. Une station servie par un seul plan apparaît sur l'autre carte comme simple marqueur. |
| L14-9 | Sens des couleurs dans le tableau. | A (ardoise) et B (pétrole) sont des couleurs d'identité, pas de jugement : la colonne « Avantage » nomme le plan avantagé par le serveur, la barre d'écart prend sa couleur. Un indicateur favorable au plan manuel est donc aussi visible qu'un indicateur favorable au logiciel. |
| L14-10 | Écart du taux de remplissage (unité `pct`). | Écart en valeur affiché en points (« +3,4 pt »), écart relatif en %. |
| L14-11 | Temps de préparation d'un plan calculé : quelques secondes (`computed_in_ms`). | Affiché « < 1 min (temps de calcul) » et non « 0 min » ; la source (`saisi` / `temps de calcul`) est toujours précisée. |
| L14-12 | Km réels connus pour une partie seulement des tournées (`distance_actual_trips < trips_count`). | Note sous le tableau : « km réels connus pour n tournées sur m — total partiel ». |
| L14-13 | Import : date de la journée. Le champ `day` du formulaire prime sur celle du fichier. | Champ laissé vide par défaut (la date du fichier est utilisée et rappelée dans le rapport de contrôle) pour éviter d'écraser sans le dire la date du fichier par le jour J. |
| L14-14 | Rejeu d'une journée de référence archivée (remplacée). | Bouton désactivé avec explication. Le serveur n'a pas été interrogé sur ce cas ; s'il l'accepte, la restriction n'est que dans l'interface. |
| L14-15 | Import par `ImportDialog` (partagé) ou par un dialogue propre ? | Dialogue propre (`ReferenceDayDialog`) : `ImportDialog` passe par `/imports/{kind}/preview` + `apply`, sans les champs date / temps de préparation / libellé visibles, sans remplacement confirmé (409), et son rapport est par ligne alors que celui de la journée de référence est par feuille / ligne / colonne. |

## Défauts et manques constatés côté API ou données (non corrigés ici)

| # | Route / fichier | Entrée | Attendu | Constaté |
|---|---|---|---|---|
| D1 | `data/templates/reference_day.xlsx` avec les autres modèles | Importer `depots`, `stations`, `trucks`, `drivers` d'exemple, puis `POST /reference-days/import` avec `reference_day.xlsx` | La journée d'exemple s'importe sur les référentiels d'exemple | 422, 12 erreurs : stations `ST-DLA-001…004`, camions `LT-123-AA` / `LT-456-BB`, chauffeur `Paul Etoa` absents des autres modèles (qui contiennent `ST-AKWA`, `ST-BONAB`, `LT 123 AB`, `LT 456 CD`, `Paul Atangana`). Les tests e2e fabriquent donc leur propre jeu (`frontend/e2e/l14-seed.ts`). |
| D2 | `POST /imports/{batch_id}/apply` | Appliquer un lot puis lire aussitôt les données créées (`GET /orders?day=`, ou prévisualiser un lot qui en dépend) | Les données sont visibles dès la réponse | Par moments la lecture immédiate ne voit rien (commandes absentes, « Camion inconnu » à la prévisualisation des chauffeurs juste après l'import des camions) : la réponse semble partir avant la validation de la transaction. Contourné dans le script de mise en données par une attente sur `GET /imports/{id}`. |
| D3 | `POST /reference-days/import`, fichier rejeté (422) | Fichier avec erreurs | Erreurs **et** avertissements exploitables | Le corps contient bien `warnings`, mais `ApiError` (client partagé) ne conserve que `details` (= erreurs) : les avertissements d'un fichier rejeté ne sont pas affichés. Besoin : exposer le corps brut dans `ApiError`. |
| D4 | `GET /comparison` | `delta_pct` quand A vaut 0 et B aussi | 0 % ou « sans objet » explicite | `null` (affiché « — ») alors que `delta` vaut 0 et `better` vaut `equal` : cohérent avec la docstring, mais surprenant sur la ligne « Violations bloquantes 0 / 0 ». |
| D5 | `PUT /trips/{id}/status` `completed` sans `actual_return_at` | Journée datée dans le futur (jeu de démonstration) | — | 422 `invalid_times` : l'heure de retour par défaut est « maintenant ». Sans conséquence en exploitation réelle ; à connaître pour les démonstrations sur dates fictives. |
| D6 | `GET /plans` | — | Un `title` prêt à afficher, comme dans `GET /comparison` | `PlanSummaryOut` du lot L5 n'a que `label` (souvent `null` pour un plan calculé) : le sélecteur compose donc « type · version · statut — libellé (heure de calcul) ». |
