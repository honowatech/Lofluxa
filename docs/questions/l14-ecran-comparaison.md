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
| L14-7 | Couleur des tournées. | `TripRouteOut.color` du serveur, qui renvoie désormais la palette de l'interface dans le même ordre : mêmes couleurs par tournée à l'écran et dans le PDF. |
| L14-8 | Même cadrage et même échelle des deux cartes. | `MapView` reçoit des deux côtés la même emprise `bounds={boundsOf(...)}` calculée sur les deux plans réunis ; chaque carte ne montre que les dépôts et stations de son plan. Survol ou clic d'un tracé (`onRouteHover` / `onRouteClick`) = même effet que sur la ligne du tableau. |
| L14-9 | Sens des couleurs dans le tableau. | A (ardoise) et B (pétrole) sont des couleurs d'identité, pas de jugement : la colonne « Avantage » nomme le plan avantagé par le serveur, la barre d'écart prend sa couleur. Un indicateur favorable au plan manuel est donc aussi visible qu'un indicateur favorable au logiciel. |
| L14-10 | Écart du taux de remplissage (unité `pct`). | Écart en valeur affiché en points (« +3,4 pt »), écart relatif en %. |
| L14-11 | Temps de préparation d'un plan calculé : quelques secondes (`computed_in_ms`). | Durées sous la minute affichées en secondes (`formatDuration(v, { seconds: true })`, ex. « 6 s (temps de calcul) ») ; la source (`saisi` / `temps de calcul`) est toujours précisée. |
| L14-12 | Km réels connus pour une partie seulement des tournées (`distance_actual_trips < trips_count`). | Note sous le tableau : « km réels connus pour n tournées sur m — total partiel ». |
| L14-13 | Import : date de la journée. Le champ `day` du formulaire prime sur celle du fichier. | Champ laissé vide par défaut (la date du fichier est utilisée et rappelée dans le rapport de contrôle) pour éviter d'écraser sans le dire la date du fichier par le jour J. |
| L14-14 | Rejeu d'une journée de référence archivée (remplacée). | Bouton désactivé avec explication. Le serveur n'a pas été interrogé sur ce cas ; s'il l'accepte, la restriction n'est que dans l'interface. |
| L14-15 | Import par `ImportDialog` (partagé) ou par un dialogue propre ? | Dialogue propre (`ReferenceDayDialog`) : `ImportDialog` passe par `/imports/{kind}/preview` + `apply`, sans les champs date / temps de préparation / libellé visibles, sans remplacement confirmé (409), et son rapport est par ligne alors que celui de la journée de référence est par feuille / ligne / colonne. |

## Défauts signalés à la livraison, corrigés depuis par l'intégration

Relevés lors de la première livraison du lot ; l'écran a été réaligné le 21/11/2026 sur les corrections.

| # | Constat initial | État |
|---|---|---|
| D1 | `data/templates/reference_day.xlsx` n'était pas importable sur les autres fichiers modèles. | Corrigé (annoncé par l'intégration ; non revérifié ici). Les parcours du lot gardent leur propre jeu (`frontend/e2e/l14-seed.ts`), plus riche : 14 stations, 15 commandes, 6 tournées manuelles. |
| D2 | Après `POST /imports/{id}/apply`, une lecture immédiate ne voyait parfois pas les données. | Non revérifié. Le script de mise en données garde son attente sur `GET /imports/{id}`. |
| D3 | Les avertissements d'un fichier rejeté (422) étaient perdus par `ApiError`. | Corrigé : `ApiError.body` donne `errors`, `warnings`, `summary` ; `details[]` mêle erreurs et avertissements (`severity`). Le dialogue d'import affiche maintenant les deux. |
| D4 | `delta_pct` valait `null` pour 0 contre 0. | Corrigé : `0` et `better = "equal"`, affichés tels quels. |
| D5 | `PUT /trips/{id}/status` `completed` sans `actual_return_at` échoue sur une journée datée dans le futur. | Inchangé, sans conséquence en exploitation ; le script fournit l'heure de retour. |
| D6 | `GET /plans` sans `title`. | Inchangé : le sélecteur compose « type · version · statut — libellé (heure de calcul) ». |

## Constats du scénario de panne (vérifié contre l'API réelle)

- `POST /events/truck-breakdown` crée et publie une version 2, l'ancienne passe `archived` ; le volet de suivi
  bascule sur la nouvelle version, l'alerte `truck_breakdown` affiche le résumé rédigé par le serveur, et la
  présélection met en B la version publiée la plus haute (parcours `l14-comparaison.e2e.ts`).
- Si le camion en panne a une **autre** tournée encore planifiée, la nouvelle version garde une violation
  bloquante RM-04 et reste en brouillon : le tableau de bord continue alors d'afficher l'ancienne version
  publiée, sans mention du brouillon en préparation. À signaler à l'écran Journal / Journée ; le volet de
  suivi ne montre que ce que renvoie `GET /dashboard`.
- Jeu `demo_scale` (32 tournées, deux plans du même jour) : cartes et tableaux lisibles ; à cette échelle
  (Douala–Yaoundé) les arrêts d'une même ville se superposent, la sélection d'une tournée atténue les autres.
