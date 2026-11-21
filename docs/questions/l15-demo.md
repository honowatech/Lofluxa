# Questions du lot L15 — Jeux de démonstration et scénario de bout en bout

Aucune ne bloque : une valeur par défaut est adoptée, notée ici, et isolée dans `scripts/demo/`.
Les défauts d'intégration trouvés par les scénarios ne sont pas des questions : ils sont décrits dans
[`docs/DEMO.md`](../DEMO.md#5-défauts-dintégration-trouvés) et figés par des tests `xfail`.

## Données que les jeux du moteur ne contiennent pas

Un `problem.json` ne porte que ce dont le moteur a besoin. Pour remplir les modèles d'import, l'export
(`scripts/demo/export_fixture.py`) complète de façon déterministe. Rien de tout cela n'est une règle
métier : ce sont des données de démonstration, à remplacer par les référentiels réels d'OLA.

| # | Donnée manquante | Valeur adoptée |
|---|---|---|
| L15-1 | Cuves des stations (capacité, stock de sécurité), nécessaires au contrôle F3.4 à la confirmation. | Chaque station reçoit une cuve de super et une de gasoil de 30 000 L, plus une cuve de 15 000 L par autre produit qu'elle commande ; stock de sécurité = 10 % de la capacité ; capacité relevée par pas de 5 000 L si la plus grosse commande du jeu ne passait pas. |
| L15-2 | Région et ville des stations. | Ville déduite du nom (« OLA Yaoundé 12 » → Yaoundé ; stations de quartier de `demo_douala` → Douala) ; région par table ville → région dans le script. |
| L15-3 | Horaires hebdomadaires : le jeu ne connaît que les fenêtres du jour J. | Fenêtres du jour J reportées sur les sept jours (« lun-dim 06:00-18:00 »), ce qui permet de rejouer la démo à une autre date (`--day`). |
| L15-4 | Numéro de permis des chauffeurs (clé d'import, question L3-14). | `PERMIS-<identifiant du jeu>` (ex. `PERMIS-CH01`). Téléphone non renseigné. |
| L15-5 | Nom et type des transporteurs (le jeu n'a qu'un identifiant). | `TR-OLA` → « OLA Flotte » (propre) ; `TR-XXX` → « Xxx » (tiers). |
| L15-6 | Exploitant des dépôts, contacts des stations. | Exploitant `SCDP` si le code commence par `SCDP`, sinon `tiers`. Contacts non renseignés (les feuilles de route affichent une case vide). |
| L15-7 | Référence d'une commande : pas de champ dans le modèle. | Identifiant du jeu (`CMD001`…) recopié dans la colonne « Commentaire ». |

## Zones d'ombre

| # | Question | Valeur adoptée en attendant |
|---|---|---|
| L15-8 | La spec ne prévoit pas d'import pour les stocks dépôt (F2.1 : saisie Supply). Faut-il un modèle `depot_stocks.xlsx` ? | Non : fichier `depot_stocks.json` (codes dépôt et produit, litres), saisi par le chargeur avec le compte Supply par `PUT /availability/depot-stocks`. |
| L15-9 | Paramètres de calcul propres à un jeu (`solver_time_limit_s` = 6 pour `demo_douala`, 30 pour `demo_scale`) et affectations camion → chauffeur du jour : où les ranger ? | Fichier `compute.json` à côté des fichiers d'import : les écarts aux valeurs par défaut sont passés à `POST /plans/compute {params}`, sans toucher à la table `settings` ; les affectations passent par `PUT /availability/drivers`. |
| L15-10 | Le rejeu (`POST /plans/{id}/replay`) n'accepte pas de surcharge de paramètres : il lit `settings` (limite du solveur : 45 s). | Les tests règlent `solver_time_limit_s` par `PUT /settings` avant le rejeu. Sur `demo_douala` le solveur s'arrête de lui-même en 4 s environ (critère « sans amélioration »), la limite n'est donc pas atteinte. À voir avec L7 : faut-il un corps `{params}` sur le rejeu, comme pour le calcul ? |
| L15-11 | Journée A réelle d'OLA non fournie (Q6). Comment prouver les critères 1 et 2 d'ici là ? | Journée fabriquée par `scripts/demo/make_reference_day.py` : stations prises dans l'ordre de leur code, camions dans l'ordre des immatriculations, premier qui rentre. Plan réalisable (0 violation), 20 commandes sur 20, 125,7 km. Le gain mesuré (15,8 %) illustre la chaîne de bout en bout ; il **ne préjuge pas** du gain sur une vraie journée d'OLA. |
| L15-12 | « Km réels » de la journée fabriquée. | Km estimés (repli haversine) majorés de 5 % et arrondis au kilomètre, par tournée : un compteur plausible, pas une mesure. Heures réelles non renseignées. |
| L15-13 | Critère 3 : les 60 s portent-elles sur le moteur seul ou sur tout le calcul (lecture de la base, matrice, moteur, enregistrement) ? | Les deux sont vérifiés : `computed_in_ms` (moteur) et la durée totale de `run_compute`. Sans OSRM la matrice coûte 0,2 s ; avec OSRM et un cache froid, elle s'ajoutera — à mesurer sur le serveur de démonstration. |
| L15-14 | `demo_scale` : deux stations portent le même code (`MBA01`, défaut du générateur). Laquelle garder à l'export ? | La première rencontrée, celle que le moteur utilise (`problem.station()`). Le jeu importé compte 69 stations et non 70 ; les 120 commandes sont conservées. |
| L15-15 | Comptes créés par le chargeur de démonstration. | `dispatcher@`, `supply@`, `fleet@`, `manager@demo.tourneo.cm`, mot de passe commun de démonstration affiché en fin de chargement. À ne pas utiliser en production : désactiver ces comptes ou changer leur mot de passe après la démo. |
