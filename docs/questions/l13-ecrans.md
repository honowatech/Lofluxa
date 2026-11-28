# Questions du lot L13 — Écrans Chargement, Suivi des livraisons, Journal des événements

Zones d'ombre rencontrées, valeur par défaut adoptée en attendant la réponse. Aucune ne bloque.

## Écran 7 — Chargement

| # | Question | Choix fait |
|---|---|---|
| L13-1 | Qui écrit sur l'écran Chargement ? L'API ouvre `POST /trips/{id}/loading` et `PUT /trips/{id}/status` à `fleet` et `dispatcher`, mais `CAPABILITIES["loading.write"]` (socle, `lib/auth/roles.ts`) ne cite que `fleet`. | L'écran ouvre l'écriture à `fleet`, `dispatcher` et `admin` (`useCan("loading.write")` ou rôle `dispatcher`). À aligner dans `roles.ts` à l'intégration. |
| L13-2 | RM-13 en direct : un compartiment planifié mais pas encore saisi doit-il déjà alerter ? | Aucun avertissement tant que rien n'est saisi ; dès la première ligne, les compartiments non saisis sont annoncés « non chargé (−100 %) », comme le serveur les comptera (L6-2). |
| L13-3 | Précision d'affichage du volume à 15 °C. | Centième de litre dans le formulaire (précision enregistrée, L6-1), litre entier dans les listes. |
| L13-4 | L6-4 (volumes planifiés en litres observés comparés à un volume à 15 °C) : à 24–30 °C, la seule correction de température consomme 1,1 à 1,8 % de la tolérance de 2 %. Sur le jeu d'essai, un chargement strictement conforme au plan frôle l'avertissement, et un écart de 1 % au compteur le déclenche. | Rien de corrigé côté écran (règle appliquée telle quelle). À trancher avec OLA avant la journée B, sinon presque toutes les tournées porteront un RM-13. |
| L13-5 | Envoi de la fiche : destinataires proposés. | Une case par station de la tournée (adresse du gérant, `stations.contact_email`), cochée par défaut, plus un champ d'adresses libres ; l'écran envoie toujours la liste explicite. Les stations sans adresse sont signalées avant et après l'envoi. |
| L13-6 | Heure de départ réelle au passage à « En cours ». | Champ facultatif ; vide = heure du serveur (L6-18). Les heures saisies sont des heures locales du **jour du plan**. |
| L13-7 | Deux plans publiés le même jour (plan initial + plan des reliquats, L5-7) : deux « Tournée 1 ». | Résolu : `GET /loadings` renvoie `plan_version` et `plan_label` ; les écrans 7 et 8 les affichent sur chaque tournée dès que plusieurs plans publiés coexistent. |
| L13-7b | Décomposition de l'écart RM-13 (température / volume chargé). | Affichée par compartiment et au total, en direct (même convention que le serveur : écart = [15 °C − observé] + [observé − planifié]) puis avec les valeurs et la phrase `gap_explanation` du serveur après enregistrement. Répond en pratique à L13-4 : l'agent voit quelle part de l'écart vient de la température. |

## Écran 8 — Suivi des livraisons

| # | Question | Choix fait |
|---|---|---|
| L13-8 | « Retard par rapport à l'heure prévue » : quelle référence, quel seuil ? | Écart arrivée réelle − arrivée prévue de l'arrêt ; pour la tournée, écart du dernier arrêt atteint (à défaut, du départ du dépôt ; du retour une fois terminée). Aucun seuil : tout retard ≥ 1 min est affiché en orange, l'avance ou l'heure exacte en vert. |
| L13-9 | Volume livré proposé par défaut. | Le volume planifié de la commande (cas courant), modifiable. Un volume à 0 est accepté avec la mention « la commande repart à replanifier » (L6-16). |
| L13-10 | Heure d'arrivée d'un arrêt sauté. | Facultative (l'API l'accepte vide) ; motif obligatoire. |
| L13-11 | Kilomètres réels à la clôture. | Saisis en kilomètres (une décimale possible), envoyés en mètres ; facultatifs comme côté API. Confirmation avant clôture car elle n'est pas réversible (L6-12). |
| L13-12 | Source des données : aucune route ne liste les arrêts d'une tournée hors du plan complet. | `GET /loadings?day=` pour les tournées, `GET /plans/{plan_id}` (un appel par plan publié du jour) pour les arrêts. |

## Écran 6 — Journal des événements (aligné sur les routes réelles du lot L10)

Les types viennent de `api.gen.ts` (`EventOut`, `EventResultOut`, `ReplacementOptionsOut`, `ShortageOut`, `ResolveOut`) ;
tous les appels sont dans `frontend/src/features/events/api.ts`.

| # | Question | Choix fait |
|---|---|---|
| L13-13 | F6.3 attribue la déclaration d'une pénurie à Supply (`POST /events/product-shortage` : `supply`, `admin`), mais `supply` ne voit pas l'écran Journal (`SCREEN_ROLES.events` du socle). | Le bouton « Déclarer une pénurie » n'apparaît que pour `supply` et `admin` ; tant que `roles.ts` n'ouvre pas l'écran à Supply, seule l'administration peut déclarer par l'écran. À trancher : ouvrir le Journal à Supply, ou placer la déclaration dans l'écran Disponibilité. |
| L13-14 | Pénurie : `day` est facultatif côté API (défaut : aujourd'hui). | L'écran envoie toujours le jour J affiché. `new_available_l` est présenté comme le stock **total** du jour. |
| L13-15 | Traitement d'une pénurie : « réduire » et « reporter » acceptent un détail par commande. | L'écran s'en tient aux valeurs par défaut du serveur (réduction proportionnelle, report de toutes les commandes du produit) ; « changer de dépôt » propose les `alternative_depots` en signalant s'ils suffisent. Faut-il une saisie par commande ? |
| L13-16 | Champs facultatifs des réaffectations (`occurred_at`, `reason`, `publish`). | Motif et heure de l'incident proposés (les remplaçants sont évalués à cette heure) ; `publish` jamais envoyé (comportement par défaut du serveur : publication si aucune violation bloquante). |
| L13-17 | Panne de camion : chauffeur de remplacement. | Chauffeur proposé par le serveur retenu par défaut ; obligatoire si `driver_required`. Les chauffeurs sont réévalués pour le camion choisi (`replacement_truck_id`). |
| L13-18 | Nouvelle version restée en brouillon (violations bloquantes) après une réaffectation. | Signalée dans l'assistant avec ses violations et un lien vers le plan ; le lien « Ouvrir son chargement » de la tournée de remplacement n'est proposé qu'une fois la version publiée (un brouillon n'apparaît pas dans `GET /loadings`). |
| L13-19 | Liens du journal vers les autres écrans. | `/suivi?trip=<id>`, `/chargement?trip=<id>` (lus par les écrans 7 et 8 de ce lot) et `/plan?plan=<id>` (à confirmer avec le lot Plan). |

## Constats sur l'API et le socle (non modifiés)

- **`POST /imports/{kind}/preview` puis `POST /imports/{batch_id}/apply` immédiat** : constaté une fois un 404
  « Lot d'import introuvable » sur l'`apply` envoyé aussitôt après un `preview` 201 (script `e2e/l13-seed.ts`,
  import `depots`). Attendu : lot visible dès la réponse du `preview`. Non reproduit à la demande ; le script réessaie.
- **Fichier modèle `data/templates/orders.xlsx`** : lignes datées du 12/01/2027 ; l'import avec un autre `day` est
  rejeté (« La date ne correspond pas à la journée importée »). Le script de mise en données crée donc ses commandes
  par `POST /orders`. Les fichiers modèles ne contiennent que 2 stations, 2 camions (dont 1 en maintenance) et
  2 chauffeurs (dont 1 au repos) : trop peu pour une démonstration, le script ajoute 8 stations, 4 camions, 4 chauffeurs.
- **`/auth/login` limité à 10 par minute et par adresse** : un enchaînement de parcours e2e peut l'atteindre ;
  le script de mise en données ne se connecte qu'une fois.
- **Socle, démarrage de session** (`lib/auth/session.ts`, `bootstrap`) : si le `GET /me` initial est interrompu
  (rechargement ou navigation pendant le chargement), les jetons sont effacés et l'utilisateur renvoyé à la
  connexion. Attendu : n'effacer les jetons que sur un refus d'authentification, pas sur une erreur réseau.
- **`GET /stops/{id}`** : pas de lecture unitaire d'un arrêt ; `StopOut` du plan ne porte pas `contact_email`
  (l'écran 7 lit `/stations` pour proposer les destinataires).
- **Corrigés depuis par le back-end** (constats du premier rendu) : `resolve` avec `reduce` dans n'importe quel ordre de
  tournées ; `occurred_at` accepté par `product-shortage` et `resolve` (proposé dans les formulaires) ; clôture sans
  heure de retour sur une journée datée dans le futur ; libellé de plan dans `GET /loadings`.
- **Toujours ouverts côté socle** : `loading.write` limité à `fleet` et écran Journal invisible pour `supply` dans
  `lib/auth/roles.ts` (contournement conservé à l'écran 7 ; pénurie déclarée en `admin` dans le parcours e2e).
- **Jeu de données des parcours** : tout ce que `e2e/l13-seed.ts` crée est préfixé `L13` (stations `L13-…`, camions
  `L13 …`, permis `L13-…`, noms suffixés « (L13) ») et le script est rejouable sur une base remplie par d'autres lots.
