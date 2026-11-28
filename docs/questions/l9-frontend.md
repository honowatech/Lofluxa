# Questions du lot L9 — Socle de l'interface

Aucune ne bloque : une valeur par défaut est adoptée et isolée en un seul endroit du code.

## Tranché par l'API réelle (lots L3 et L8, intégrés) — le front est aligné

| # | Question de départ | Réponse constatée dans l'API | Conséquence dans le front |
|---|---|---|---|
| L9-Q1 | Verbe de mise à jour | `PUT` = `PATCH` = mise à jour partielle | `createResource` envoie `PUT` ; les éditions en ligne n'envoient que le champ modifié |
| L9-Q2 | Tri, recherche, filtres des listes | `q` + filtres exacts ; **aucun paramètre de tri** (ordre fixe : code, immatriculation, nom, date décroissante) | Les tableaux triables chargent toutes leurs lignes (`useAll`) et trient localement ; `DataTable` en mode serveur n'est triable que sur option (`serverSort`) |
| L9-Q5 | Forme du rapport d'import | `{summary, issues[], items[]}` + `can_apply` ; 409 `import_has_errors` / `already_applied` / `stale_preview` | `ImportDialog` affiche l'effet de chaque ligne (création, mise à jour avec avant → après, inchangée) et les anomalies ; `can_apply` fait foi |
| L9-Q6 | Forme de `/settings` | `Page[SettingOut]` avec type, bornes, défaut, description ; `PUT {"values": {…}}`, tout ou rien | Type et bornes viennent du serveur ; le front ne garde que le groupe d'affichage et l'unité de chaque clé |
| L9-Q7 | Filtres de `/audit` | `table`, `row_id` (exact), `actor_id`, `action`, `date_from`, `date_to` (jours locaux inclus) ; `actor_name`, `actor_email` | Filtre « action » ajouté ; les jours sont transmis tels quels |
| L9-Q8 | Réinitialisation du mot de passe | `POST /users/{id}/reset-password`, `activate`, `deactivate` ; son propre mot de passe : `PUT /me/password` | Routes dédiées utilisées ; réinitialisation de son propre compte désactivée dans le menu |
| L9-Q9 | Cuves et compartiments | Acceptés en ligne par `POST` / `PUT` du parent (rapprochés par produit / par position) | Une seule requête, atomique ; plus de positions provisoires |
| L9-Q10 | Longueur minimale du mot de passe | 8 par défaut, réglable côté serveur (`TOURNEO_PASSWORD_MIN_LENGTH`) | 8 à la saisie (`PASSWORD_MIN_LENGTH`) ; un refus du serveur s'affiche sous le champ |
| L9-Q11 | Somme des compartiments et capacité totale | Le serveur refuse (422) une somme **supérieure** à la capacité totale ; une somme inférieure est acceptée | Avertissement dans la fiche camion dès que les deux diffèrent, bouton « Utiliser la somme » ; le refus du serveur s'affiche sous « Capacité totale » |

## Écarts constatés entre la spec et l'API réelle

| Sujet | Spec (§9) | API réelle |
|---|---|---|
| Tri des listes | « toutes paginées, filtrables » — rien sur le tri | Pas de tri côté serveur. Sans effet pour les référentiels (quelques centaines de lignes), mais un tableau long et paginé côté serveur (commandes, audit) ne pourra pas être trié par l'utilisateur. À décider en vague 2 si un écran en a besoin. |
| Utilisateurs | `CRUD /users` | `DELETE /users/{id}` désactive (ne supprime pas) ; routes d'action supplémentaires ; `PUT /me/password` (pas d'écran « mon mot de passe » dans la spec §10 : non construit) |
| Audit | `GET /audit?table=&row_id=` | Filtres supplémentaires ; accès limité à `admin` et `manager` (l'écran Administration reste réservé à `admin`) |
| Paramètres | F9.2 liste 9 paramètres | 25 clés servies, dont 2 absentes du catalogue d'affichage du front : elles apparaissent dans le groupe « Autres », avec leurs bornes |
| Imports | `→ batch_id + rapport` | Réponse 201 ; une clé supprimée qui réapparaît dans un fichier est **réactivée** (annoncée comme mise à jour « supprimé → réactivé ») ; `GET /imports` (historique) existe mais aucun écran ne l'affiche |
| Authentification | JWT accès 15 min, rafraîchissement 7 jours | Rotation du jeton de rafraîchissement et révocation à la déconnexion ; 429 `rate_limited` (10 connexions/min par adresse) : traités (voir README) |

## Toujours ouvert

| # | Constat | Valeur adoptée |
|---|---|---|
| L9-Q3 | « Permis / habilitation proches de l'expiration » : aucun seuil dans la spec ni dans les paramètres. | 30 jours, constante `EXPIRY_WARNING_DAYS` (`src/lib/config.ts`). Simple aide visuelle, sans effet sur RM-03. À déplacer dans `settings` si OLA veut le régler. |
| L9-Q4 | Spec §2 : rôles décrits par leurs tâches, pas par la liste des écrans visibles. | Navigation filtrée par métier (`SCREEN_ROLES`, `src/lib/auth/roles.ts`) ; écritures des référentiels et de l'administration réservées à `admin` (confirmé par l'API). Le serveur reste seul juge (403). |
| L9-Q12 | Fuseau d'affichage : le paramètre `timezone` est modifiable, mais le front en a besoin avant d'avoir chargé les paramètres. | Constante `APP_TIMEZONE = "Africa/Douala"` ; toutes les fonctions de formatage acceptent un fuseau en argument. |
| L9-Q13 | Zone d'alertes de la coquille : contenu non précisé hors de l'écran Journée. | Mécanisme générique (`usePublishAlerts`) ; la coquille y publie les permis / habilitations expirés ou proches. Les écrans de vague 2 y ajouteront les leurs. |
| L9-Q14 | Limitation de débit : 10 connexions par minute **et par adresse IP**. Derrière le proxy du site d'OLA, tous les postes partagent probablement la même adresse. | Rien à faire côté front (message et délai affichés). À vérifier avec L8 : prise en compte de l'adresse réelle derrière Caddy, ou plafond par compte. |
| L9-Q15 | Types TypeScript : écrits à la main d'après l'OpenAPI réelle (`src/lib/types/`). | À remplacer par les types générés (lot L15) ; tout le code importe depuis `@/lib/types`. |
| L9-Q16 | Journal d'audit : l'API l'ouvre à `manager` (et `admin`), mais l'écran Administration était réservé à `admin`. | L'écran Administration est ouvert à `manager`, réduit au seul onglet « Journal d'audit » (sans filtre par auteur : la liste des utilisateurs reste réservée à `admin`). À confirmer : la direction doit-elle voir le journal d'audit ? |
| L9-Q17 | Journal des événements : `supply` déclare les pénuries (F6.3) mais ne voyait pas l'écran. | Écran ouvert à tous les rôles (lecture) ; droit `events.shortage.write` pour `supply`, `events.write` (réaffectation, traitement) pour `dispatcher`. |
| L9-Q18 | Démarrage avec un serveur injoignable : rien dans la spec. | Session conservée, page « Démarrage impossible » avec « Réessayer » (et nouvel essai automatique au retour du réseau). Seul un refus 401 / 403 efface la session. |
