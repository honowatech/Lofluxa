# Questions du lot L10 — Événements du jour

Zones d'ombre rencontrées en réalisant F6.1 à F6.4 et RM-19. Aucune ne bloque : la valeur par défaut
indiquée est codée et testée. À consolider dans `docs/QUESTIONS.md`.

## Ajouts à l'API (absents de la spec §9)

| # | Ajout | Raison |
|---|---|---|
| L10-A1 | `GET /events/replacement-options?trip_id=&replacement_truck_id=&occurred_at=` | Assistant de réaffectation (écran 6) : camions et chauffeurs possibles pour une tournée, avec le motif (`rule_code`) de ceux qui ne sont pas éligibles. Lecture seule. |
| L10-A2 | `POST /events/{event_id}/resolve` `{resolutions: [{trip_id, action, deliveries?, order_ids?, depot_id?}], publish?}` | F6.3 : « le dispatcher choisit : réduire, reporter ou changer de dépôt » demande une seconde action après la déclaration de Supply. |
| L10-A3 | `GET /events/{event_id}/impact` | F6.3 : tournées encore impactées par une pénurie et options à jour (après une résolution partielle, un rechargement, une nouvelle saisie de stock). |
| L10-A4 | `GET /events/{event_id}` | Relire un événement du journal (lien depuis une alerte du tableau de bord). |
| L10-A5 | `GET /events` : filtres `type` (répétable), `trip_id`, `plan_id`, `include_versions` | Journal filtrable (écran 6). `trip_id` retrouve aussi les événements qui citent la tournée (`payload.related_trip_ids`). |
| L10-A6 | Champs facultatifs des requêtes : `occurred_at`, `reason`, `publish` (panne, chauffeur) ; `day`, `comment` (pénurie) | Saisir un événement constaté plus tôt, garder le motif, choisir de publier ou non. Sans eux, le corps de la spec suffit. |

## Panne de camion (F6.1, RM-19)

| # | Question | Valeur adoptée |
|---|---|---|
| L10-1 | Que devient le produit déjà chargé dans le camion en panne : transbordement sur place, ou rechargement au dépôt ? | **Rechargement au dépôt.** La tournée de remplacement est une tournée normale : arrivée au dépôt à l'heure de l'événement, attente + chargement, puis les arrêts restants. Le modèle n'a qu'un chargement par tournée et tout horaire part du dépôt ; un transbordement demanderait un point de départ hors dépôt et un transfert de chargement, que la spec ne décrit pas. Le produit resté dans le camion en panne n'est pas suivi (pas de retour en stock : la réconciliation de stock est hors périmètre, §4). Conséquence : le volume rechargé compte une seconde fois dans la réalité du dépôt, mais pas dans RM-08 (qui somme les volumes à livrer). |
| L10-2 | La nouvelle version est-elle publiée d'office ou laissée en brouillon pour validation ? | **Publiée d'office si elle n'a aucune violation bloquante** et si c'est l'événement qui l'a créée : la panne est un fait, le terrain a besoin du plan tout de suite. Sinon elle reste en brouillon (la version publiée précédente reste la référence, L5-2) et la réponse liste les violations ; le dispatcher corrige puis publie. Un brouillon déjà en préparation avant l'événement n'est jamais publié d'office (il peut contenir un travail en cours) : il faut `publish: true` ou `POST /plans/{id}/publish`. `publish: false` empêche toujours la publication. |
| L10-3 | Le camion en panne passe-t-il au statut `broken` du référentiel ? | **Non** : il est marqué indisponible pour la journée (`daily_resource_status`, motif « Panne déclarée à HH:MM »), ce qui suffit à RM-04. La spec ne dit pas que la panne change le statut permanent ; le passage à `broken` (et le retour à `available`) reste une décision de gestion de flotte, dans le référentiel. À confirmer : sans cela, le camion redevient affectable le lendemain. |
| L10-4 | Que devient la tournée d'origine ? | Elle garde ses arrêts `delivered` / `skipped`, leurs heures et volumes réels, et passe à `completed` (sans heure de retour : le camion n'est pas rentré). Si elle n'avait rien réalisé et n'avait pas commencé (`planned`), elle est retirée de la nouvelle version (L5-10) ; si elle avait commencé (`at_depot`, `loaded`) elle est conservée, vide et `completed`, pour ne pas perdre son chargement réel. La version précédente, archivée, garde la tournée entière. |
| L10-5 | RM-03 / RM-04 sur une tournée déjà réalisée : le camion marqué indisponible rendait fautive, donc impubliable, la tournée qu'il avait livrée avant la panne. | Les règles RM-03 et RM-04 ne s'appliquent plus à une tournée sans arrêt `pending` (**modification de `planning/violations/rules.py`**, lot L1 : fonction `_is_done`). L'affectabilité vaut pour ce qui reste à faire. |
| L10-6 | Le camion en panne (ou le chauffeur indisponible) a d'autres tournées non terminées le même jour. | L'événement ne traite que la tournée désignée (`trip_id` de la spec). Les autres ressortent en RM-04 (ou RM-03) bloquant : la nouvelle version reste en brouillon, la réponse les liste (`other_impacted_trips`) ; le dispatcher déclare l'événement pour chacune (les appels suivants se poursuivent sur le même brouillon) ou les réaffecte dans l'écran du plan. |
| L10-7 | Quel chauffeur pour la tournée de remplacement quand aucun n'est fourni ? | Celui affecté au camion de remplacement pour la journée (F2.4) ; sinon celui de la tournée d'origine. Le premier des deux qui passe les règles est retenu ; aucun → 409 avec les `rule_code`. Si le chauffeur d'origine continue, la nouvelle tournée ne commence pas avant son retour prévu au dépôt (sinon RM-02 le verrait sur deux tournées à la fois). |
| L10-8 | Quelles règles valent refus (409) du remplaçant ? | Camion : RM-04, RM-05/06/07 (compartiments), RM-09, RM-14. Chauffeur : RM-01, RM-02, RM-03, RM-11. Seules les violations bloquantes **nouvelles** qui touchent la tournée concernée ou les autres tournées du remplaçant comptent. Le verdict vient d'une simulation passée à `rules.check_plan` (aucune règle recodée). Les autres violations (RM-10 : stations fermées à l'heure recalculée ; RM-08…) ne refusent pas l'événement : elles laissent la version en brouillon. |
| L10-9 | Un événement alors qu'une nouvelle version est déjà en préparation (brouillon de la même lignée). | L'événement s'applique à ce brouillon, que le client envoie l'identifiant de la tournée publiée ou celui du brouillon. La tournée est retrouvée par son numéro (`seq`), stable d'une version à l'autre tant qu'aucun recalcul n'a remplacé les tournées — à fiabiliser par une correspondance persistée si le cas se présente. Plan jamais publié, archivé, journée de référence ou rejeu : 409 `plan_not_published`. |
| L10-10 | Heure de l'événement antérieure au début de journée, ou postérieure à la fermeture. | Bornée par l'heure de début de journée (paramètre `day_start_time`). Une heure tardive n'est pas refusée : RM-10 signale les arrêts hors horaires et la version reste en brouillon. |

## Chauffeur indisponible (F6.2)

| # | Question | Valeur adoptée |
|---|---|---|
| L10-11 | « Même mécanique côté chauffeur » : faut-il aussi scinder la tournée ? | **Non** : le camion et son chargement ne changent pas, le remplaçant reprend la même tournée (les arrêts livrés, leurs réalisés et le chargement y restent). Même mécanique pour le reste : contrôle du remplaçant, nouvelle version (RM-18), journalisation. Le chauffeur d'origine reste lisible dans la version archivée et dans l'événement. Il est marqué indisponible pour la journée. |
| L10-12 | RM-02 et RM-11 pour le remplaçant : sur quelle durée ? | Sur toute la tournée telle que planifiée, y compris la partie déjà faite par le chauffeur d'origine (prudent : `TripD` ne permet pas de compter une demi-tournée). À affiner si OLA veut ne compter que le reste. |
| L10-13 | Heures de la tournée après le remplacement. | Tournée déjà commencée : heures prévues inchangées (le retard réel se lit dans le suivi). Tournée encore `planned` : elle ne démarre pas avant l'heure de l'événement. |

## Produit indisponible au dépôt (F6.3)

| # | Question | Valeur adoptée |
|---|---|---|
| L10-14 | `new_available_l` est-il le stock **restant maintenant** ou le stock **total du jour** ? | **Total du jour**, comme la saisie du matin (F2.1) et comme RM-08, qui compare le stock à tout le volume planifié de la journée. « En tenant compte de ce qui est déjà chargé » : stock restant = nouveau stock − volume des tournées déjà chargées (statut `loaded` ou au-delà, ou chargement enregistré). Une valeur inférieure à ce qui est déjà chargé est refusée (422 `stock_below_loaded`). À confirmer avec Supply : si la saisie doit être le restant, il suffira d'ajouter le déjà-chargé avant d'enregistrer. |
| L10-15 | « Déjà chargé » : volume réel du bon de chargement ou volume planifié ? | Volume planifié des tournées chargées (cohérent avec RM-08, question R5 du lot L1). |
| L10-16 | Quelles tournées sont « impactées » quand le stock ne couvre plus tout ? | Les tournées non chargées sont servies dans l'ordre de leur heure de départ prévue ; sont impactées celles que le stock restant ne couvre plus en entier. Pour chacune : volume prévu, volume couvert, manque, commandes, dépôts de repli avec leur stock restant. |
| L10-17 | Quels plans sont examinés ? | La version publiée de chaque lignée de plans calculés du jour (les brouillons seront arrêtés par RM-08 à leur publication). |
| L10-18 | « Réduire » : de combien, et sur quelles commandes ? | Par défaut, réduction proportionnelle de toutes les livraisons du produit de la tournée, jusqu'au volume que le stock couvre encore (arrondi au litre inférieur). Le dispatcher peut imposer les volumes (`deliveries`). Une réduction sous le seuil de RM-16 reste permise (avertissement). Le reliquat redevient `confirmed` à la publication (mécanisme du lot L5). S'il ne reste rien : 422, il faut reporter ou changer de dépôt. |
| L10-19 | « Reporter » : quelles commandes, et à quel moment changent-elles de statut ? | Par défaut toutes les commandes du produit de la tournée ; sinon celles de `order_ids`. Elles passent `postponed` (statut final, L4-4) **dès la décision**, même si la nouvelle version reste en brouillon ; elles restent listées dans les non servies du plan (L5-20). Un arrêt vidé disparaît, une tournée vidée aussi. |
| L10-20 | « Changer de dépôt » : pour le produit en pénurie seulement, ou pour toute la tournée ? | Toute la tournée (RM-01 : un seul dépôt de chargement par tournée). Horaires, RM-08 du nouveau dépôt, RM-10 et RM-14 sont recontrôlés ; le dépôt de repli n'est pas refusé s'il manque de stock, la violation le dit. |
| L10-21 | Une pénurie se résout-elle en une fois ? | Non : tournée par tournée, en un ou plusieurs appels. Tant que RM-08 reste bloquante, la nouvelle version reste en brouillon et les décisions suivantes s'y ajoutent. L'alerte passe de `open` à `resolved` quand plus aucune tournée n'est impactée. |
| L10-22 | Pénurie déclarée sans tournée impactée. | Stock historisé, événement journalisé avec `status: "no_impact"`. |

## Journal et tableau de bord (F6.4, F8.6)

| # | Question | Valeur adoptée |
|---|---|---|
| L10-23 | Format du `payload` des événements du lot. | Toujours `action`, `summary` (phrase lisible), `related_trip_ids`. Pénurie : `status` (`open` / `resolved` / `no_impact`), `depot_code`, `product_code`, `previous_available_l`, `new_available_l`, `loaded_l`, `remaining_l`, `shortfall_l`, `impacted_trips[]` (avec `options[]` puis `resolution`), `resolutions[]`. Une résolution est journalisée comme `manual_edit` (`action: "shortage_resolution"`) sur la nouvelle version, et reportée dans l'alerte d'origine. |
| L10-24 | **Écart avec le tableau de bord** (`comparison/dashboard.py`, lot L7) : chaque événement d'alerte y a un message générique (« Panne de camion »…) et y reste affiché toute la journée. | Non modifié (hors périmètre). Proposé : afficher `payload.summary` quand il existe, et ne plus compter comme alerte active une pénurie dont `payload.status` vaut `resolved` ou `no_impact`. Le `payload` complet est déjà transmis tel quel, l'écran peut donc le faire dès maintenant. |
| L10-25 | Les changements de statut de tournée ne figurent pas au journal (L6-19). | Inchangé : seuls les types d'événement de la spec §5 existent. |

## Remarques pour l'intégration

- **Chargement réel et versions (L5-5).** `loadings.trip_id` reste attaché à la tournée de la version où le
  chargement a été saisi. Après une panne, la tournée d'origine de la nouvelle version n'a donc pas son
  chargement tant que le lot L5 n'a pas livré le rattachement ; la tournée de remplacement, elle, reçoit
  son propre chargement (rechargement au dépôt). La détection « déjà chargé » de la pénurie s'appuie sur
  le statut de la tournée (copié d'une version à l'autre) et, à défaut, sur le chargement.
- **Fichiers hors périmètre modifiés** : `backend/app/planning/violations/rules.py` (L10-5) uniquement.
- `daily_resource_status` est écrit directement par l'ORM dans `events/service.py::mark_unavailable` : la
  fonction équivalente du lot L4 (`availability/router.py::_set_day_mark`) est privée au routeur. À
  remonter dans `availability/service.py` si l'on veut une seule écriture.
