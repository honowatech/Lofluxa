# Questions ouvertes — lot L8 (administration et infrastructure)

Zones d'ombre rencontrées pendant le lot. Aucune ne bloque : une valeur par défaut est adoptée et notée.
« À confirmer » = décision qui revient à OLA ou à Honowa.

## Administration (F9)

| # | Constat | Valeur adoptée |
|---|---|---|
| A1 | F9.1 dit « gestion des utilisateurs » sans préciser la suppression. Un compte est référencé par `created_by`, `actor_id`, `entered_by`… | Un compte ne se supprime jamais : `DELETE /users/{id}` le **désactive** (comme `POST /users/{id}/deactivate` et `PUT … {"active": false}`). |
| A2 | Rien n'empêche dans la spec de se retrouver sans administrateur. | Un administrateur ne peut ni se désactiver, ni changer son propre rôle (409). Comme seul un administrateur peut modifier les comptes, il en reste toujours au moins un actif. |
| A3 | Aucune politique de mot de passe dans la spec. | Longueur minimale de 8 caractères (`TOURNEO_PASSWORD_MIN_LENGTH`), maximale de 128, aucune règle de composition, pas d'expiration, pas de changement imposé à la première connexion. **À confirmer avec OLA** (politique de sécurité interne ?). Ce seuil est dans la configuration d'infrastructure (`core/config.py`) et non dans la table `settings`, comme les seuils de limitation de débit. |
| A4 | La spec ne prévoit que la déconnexion comme cause de révocation. | Le changement de mot de passe, sa réinitialisation par un administrateur et la désactivation d'un compte ferment aussi toutes les sessions ouvertes du compte. `PUT /me/password` renvoie une nouvelle paire de jetons pour que la session en cours continue. |
| A5 | Un administrateur peut-il réinitialiser son propre mot de passe sans donner l'ancien ? | Non : `POST /users/{id}/reset-password` est refusé pour son propre compte (409) ; il doit passer par `PUT /me/password`, qui exige le mot de passe actuel. |
| A6 | F9.3 limite l'audit aux écritures sur `plans`, `trips`, `loadings`, `stocks` et `settings`. Les opérations sur les comptes n'y figurent pas. | Les créations, modifications, désactivations et réinitialisations de comptes sont tracées dans `audit_log` (table `users`), sans jamais y écrire de mot de passe ni de hachage. Les connexions ne sont pas tracées (seul `last_login_at` est tenu à jour). **À confirmer** : faut-il journaliser les connexions réussies et échouées ? |
| A7 | F9.2 ne donne ni type ni bornes pour les paramètres. | Type déduit de la valeur par défaut ; bornes larges servant de garde-fou contre les fautes de frappe (`app/admin/settings_spec.py`) : vitesse 5–120 km/h, durée de service 1–24 h, durées en minutes 0–720, chargements par jour 1–10, marges et tolérances 0–50 %, part minimale livrable 0–100 %, coefficient à vol d'oiseau 1–3, limites du solveur 1–600 s. **À confirmer avec OLA** pour les bornes qui ont un sens métier. |
| A8 | RM-20 fixe le fuseau `Africa/Douala`, mais F9.2 liste « fuseau horaire » parmi les paramètres modifiables. | Le paramètre `timezone` reste modifiable (tout fuseau IANA valide). |
| A9 | Format de `PUT /settings` non précisé. | Corps `{"values": {"clé": valeur, …}}`, tout ou rien (une valeur refusée annule l'ensemble, 422 avec le détail par clé). `GET /settings` renvoie l'enveloppe de liste commune (`items`, `total`, `limit`, `offset`) sans pagination réelle : toutes les clés d'un coup. |
| A10 | Qui lit les paramètres et le journal d'audit ? | Paramètres : tout rôle authentifié en lecture, `admin` en écriture. Journal d'audit : `admin` et `manager`. `CRUD /users` : `admin` seul (les autres rôles ne voient pas la liste des comptes). |
| A11 | Durée de conservation du journal d'audit non précisée. | Conservation illimitée, aucune purge. |
| A12 | Le filtre « période » du journal n'est pas défini (instants ou jours ?). | Paramètres `date_from` / `date_to` : jours entiers, inclusifs, dans le fuseau d'affichage (RM-20). |

## Durcissement de l'authentification (§8.5)

| # | Constat | Valeur adoptée |
|---|---|---|
| S1 | Seuils de limitation de débit non chiffrés dans la spec. | 10 tentatives de connexion par minute et 60 requêtes par minute sur les autres routes d'authentification, **par adresse IP**. Attention : si tous les postes d'OLA sortent par la même adresse IP, le quota de connexion est partagé par le site. **À confirmer** ; à ajuster par `TOURNEO_RATE_LIMIT_LOGIN`. |
| S2 | Que faire si Redis est indisponible ? | Disponibilité avant rigueur : le contrôle de révocation est ignoré (un jeton d'accès révoqué reste alors valable jusqu'à son expiration, 15 minutes au plus), la limitation de débit bascule sur des compteurs en mémoire, `/health` passe à `degrade`. L'alternative (refuser toute requête authentifiée) rendrait l'application inutilisable à la moindre panne de Redis. |
| S3 | Rotation du jeton de rafraîchissement : que faire si un ancien jeton est rejoué ? | Il est refusé (401 `token_revoked`). La chaîne de jetons issue de la même connexion n'est pas révoquée en bloc (pas de détection de vol) : jugé hors de proportion pour le prototype. |
| S4 | `/health` et `/health/osrm` doivent-ils être protégés ? | Publics (utilisés par les contrôles de santé de Docker et par la page de connexion) ; ils ne renvoient qu'un état, sans adresse interne. `/health` répond 503 si la base est injoignable, 200 `degrade` si seul Redis l'est. `/health/osrm` répond toujours 200, avec `ok` ou `indisponible`. |
| S5 | La documentation interactive `/api/v1/docs` reste exposée en production (socle). | Laissée telle quelle. **À confirmer** : la masquer en `env=prod` ? |
| S6 | « CORS strict » non détaillé. | Origines explicites uniquement (`*` refusé en production), méthodes et en-têtes limités à ceux qu'utilise l'interface (`Authorization`, `Content-Type`, `Accept`). En production, l'interface et l'API partagent la même origine derrière Caddy. |

## Infrastructure (§8.1, §8.5)

| # | Constat | Valeur adoptée |
|---|---|---|
| I1 | La spec cite `osrm-contract` (algorithme CH) ; l'énoncé du lot laisse le choix. | MLD par défaut (`osrm-partition` + `osrm-customize`) : prétraitement plus rapide et moins gourmand en mémoire sur un VPS de 8 Go. CH disponible par `OSRM_ALGORITHM=ch`. |
| I2 | Profil camion : gabarit et vitesses non chiffrés. Un seul profil sert à tous les gabarits de camion (`small` / `medium` / `large`). | Vitesses voiture × 0,8, plafond 80 km/h ; gabarit d'une grande citerne : 4,0 m de haut, 2,55 m de large, 16,5 m de long, 40 t. Conséquence : une voie limitée à 20 t est aussi évitée pour un petit porteur. **À confirmer avec OLA** (gabarits réels, vitesses constatées) ; réglable par les variables `TRUCK_*`. |
| I3 | « Évite les voies interdites aux poids lourds si taguées » : quels tags ? | `hgv=no`, `goods=no`, restrictions générales (`motor_vehicle`, `vehicle`, `access`), limites `maxheight` / `maxwidth` / `maxlength` / `maxweight`, et en plus `hazmat=no` et `hazmat:water=no` (les citernes transportent des matières dangereuses ; désactivable par `TRUCK_HAZMAT=0`). `hgv=destination` et `hgv=delivery` restent autorisés pour la desserte locale. |
| I4 | Les durées OSRM (profil camion) et le paramètre `default_avg_speed_kmh` (40 km/h) peuvent diverger. | Non tranché ici : le moteur (lot L2) décide de l'usage des durées OSRM. À regarder à l'intégration, puis à caler sur les temps de trajet réels d'OLA. |
| I5 | Chiffrement des sauvegardes : méthode non précisée. | GnuPG symétrique AES-256 avec une phrase secrète (`BACKUP_PASSPHRASE`) : restauration simple, mais la phrase est présente sur le serveur. Une clé publique (le serveur ne pourrait alors plus déchiffrer ses propres sauvegardes) serait plus sûre et un peu plus lourde à exploiter. |
| I6 | Stockage hors serveur « au nom d'OLA ou de Honowa selon accord ». | Non décidé : la copie hors serveur est désactivée tant que `RCLONE_REMOTE` est vide. **À décider avant la mise en service.** Jour : dimanche. Conservation hors serveur : illimitée par défaut (`BACKUP_OFFSITE_RETENTION_DAYS`). |
| I7 | Personne n'est prévenu si une sauvegarde échoue (pas de pile d'observabilité dans le MVP). | Le service `backup` passe à l'état `unhealthy` ; contrôle manuel hebdomadaire documenté. **À confirmer** : une alerte par e-mail suffirait-elle ? |
| I8 | Périmètre de la sauvegarde. | La base PostgreSQL uniquement. À vérifier à l'intégration : aucun lot ne doit stocker de fichier hors de la base (imports, logos, PDF). |
| I9 | Version d'OSRM. | Image officielle `ghcr.io/project-osrm/osrm-backend:v5.27.1`. Elle ne contient ni `curl` ni `wget` et repose sur Debian 11 : le téléchargement de l'extrait est donc fait par un service séparé (`osrm-download`), sans rien installer dans l'image OSRM. |
| I10 | L'API et le worker reçoivent tout le fichier `.env` (pour que toute variable `TOURNEO_*` ajoutée par un lot soit prise en compte sans toucher au compose). | La phrase secrète des sauvegardes est neutralisée pour ces deux services, et les identifiants du stockage hors serveur vivent dans un fichier séparé (`.env.backup`) lu par le seul service `backup`. |
