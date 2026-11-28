# Questions du lot L15 — Jeux de démonstration et scénario de bout en bout

Aucune ne bloque : une valeur par défaut est adoptée, notée ici, et isolée dans `scripts/demo/`.
Les défauts d'intégration trouvés par les scénarios ne sont pas des questions : ils sont décrits dans
[`docs/DEMO.md`](../DEMO.md#5-défauts-dintégration) (un défaut ouvert, figé par un test `xfail` ; sept
corrigés, gardés en tests de non-régression). Mis à jour le 21/11/2026 après l'intégration des vagues 1 et 2.

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
| L15-10 | Le rejeu (`POST /plans/{id}/replay`) n'accepte pas de surcharge de paramètres : il lit `settings` (limite du solveur : 45 s). | Les tests règlent `solver_time_limit_s` par `PUT /settings` avant le rejeu. Sur `demo_douala` le solveur s'arrête de lui-même en 4 s environ (critère « sans amélioration »), la limite n'est donc pas atteinte. Toujours ouvert : faut-il un corps `{params}` sur le rejeu, comme pour le calcul ? |
| L15-11 | Journée A réelle d'OLA non fournie (Q6). Comment prouver les critères 1 et 2 d'ici là ? | Journée fabriquée par `scripts/demo/make_reference_day.py` : stations prises dans l'ordre de leur code, camions dans l'ordre des immatriculations, premier qui rentre. Plan réalisable (0 violation), 20 commandes sur 20, 125,7 km. Le gain mesuré (15,8 %) illustre la chaîne de bout en bout ; il **ne préjuge pas** du gain sur une vraie journée d'OLA. |
| L15-12 | « Km réels » de la journée fabriquée. | Km estimés (repli haversine) majorés de 5 % et arrondis au kilomètre, par tournée : un compteur plausible, pas une mesure. Heures réelles non renseignées. |
| L15-13 | Critère 3 : les 60 s portent-elles sur le moteur seul ou sur tout le calcul (lecture de la base, matrice, moteur, enregistrement) ? | Les deux sont vérifiés : `computed_in_ms` (moteur, 17,3 s sur `demo_scale`) et la durée totale de `run_compute` (17,7 s). Sans OSRM la matrice coûte 0,2 s ; avec OSRM et un cache froid, elle s'ajoutera — à mesurer sur le serveur de démonstration. |
| L15-14 | `demo_scale` avait deux stations de même code (`MBA01`). | **Résolu** : le générateur du lot L2 a été corrigé, le jeu compte 70 stations aux identifiants distincts et l'export n'écarte plus rien. |
| L15-15 | Comptes créés par le chargeur de démonstration. | `dispatcher@`, `supply@`, `fleet@`, `manager@demo.tourneo.cm`, mot de passe commun de démonstration affiché en fin de chargement. À ne pas utiliser en production : désactiver ces comptes ou changer leur mot de passe après la démo. |
| L15-16 | Le rejeu utilise les ressources disponibles au moment où il est lancé (question L7-4). Après une panne déclarée le même jour, il n'a plus que 3 camions sur 4. | Constaté, non corrigé : même kilométrage et même verdict sur `demo_douala`, mais la comparaison « à ressources égales » n'est plus garantie. La preuve A/B des tests se fait sur une base sans événement. |
| L15-17 | Quelle pénurie simuler dans `run_day.py --shortage`, et quelle décision ? | Gasoil, 5 000 L de moins que ce que le plan publié prévoit (une seule tournée impactée sur `demo_douala`) ; décision « reporter ». « Réduire » n'est pas utilisé tant que la livraison d'une commande planifiée en partie est refusée (défaut D8 de `docs/DEMO.md`). |
| L15-18 | Quelle tournée mettre en panne dans `run_day.py --breakdown` ? | La première, dans l'ordre des départs, qui a au moins deux arrêts et qui est la dernière de son camion ce jour-là : la panne a lieu après son premier arrêt, et aucune autre tournée du camion ne laisse la nouvelle version en brouillon (question L10-6). Le remplaçant est le premier camion que l'assistant (`GET /events/replacement-options`) déclare éligible. |
| L15-19 | Deux plans publiés le même jour (plan principal + plan des commandes d'un arrêt sauté) : le second ignore les tournées du premier (RM-02, RM-14 ; question L5-8) et n'apparaît pas au tableau de bord (question L7-17). | Non tranché ici : constaté et décrit dans `docs/DEMO.md` §5.3. La démo le montre tel quel. |
| L15-20 | Critère 4 (dispatcher autonome après une heure de formation) : que peut-on automatiser ? | La faisabilité seulement : un test enchaîne les cinq gestes avec le compte dispatcher par l'API, et deux gestes (calcul, publication) ont été rejoués à la souris. L'autonomie après formation se constate chez OLA. |
