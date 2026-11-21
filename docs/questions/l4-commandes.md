# Questions du lot L4 — Commandes et disponibilité du jour

Aucune ne bloque : une valeur par défaut est adoptée et codée. À consolider dans `docs/QUESTIONS.md`.

## Ajouts à l'API (absents de la spec §9)

| # | Ajout | Raison |
|---|---|---|
| L4-A1 | `POST /orders/confirm` `{order_ids[]}` → `{confirmed, failed, results[{order_id, ok, order, warnings[], error{code, message}}]}` (toujours 200, un résultat par commande) | L'écran 3 demande la « confirmation en masse ». |
| L4-A2 | `GET /availability/summary?day=` (commandes par statut, camions et chauffeurs affectables, stocks renseignés ou non) | Résumé de l'écran 2 « Journée » en une requête. |
| L4-A3 | `GET /availability/depot-stocks/history?day=&depot_id=&product_id=` | F2.1 demande de garder l'historique ; il faut pouvoir le consulter. |
| L4-A4 | `PATCH /orders/{id}` (modification partielle) en plus de `PUT /orders/{id}` (remplacement complet) | Tableau éditable de l'écran 3 : modifier une cellule sans renvoyer toute la ligne. |
| L4-A5 | Champ `warnings[]` (`{code, message}`) sur une commande lue, renseigné par la confirmation et par la modification d'une commande confirmée | F3.4 : avertissement non bloquant à renvoyer dans la réponse. |

## Zones d'ombre de la spec

| # | Question | Valeur adoptée en attendant |
|---|---|---|
| L4-1 | F3.3 liste les statuts mais pas les transitions autorisées. | `draft → confirmed, cancelled, postponed` ; `confirmed → planned, cancelled, postponed` ; `planned → loaded, confirmed, postponed` ; `loaded → delivered, confirmed` ; `delivered`, `cancelled`, `postponed` sont finaux. Table unique : `app/orders/service.py::ALLOWED_TRANSITIONS`. |
| L4-2 | Le dispatcher peut-il annuler ou reporter lui-même une commande déjà `planned` (elle figure dans un plan publié) ? | Non par les routes `/orders/{id}/cancel` et `/postpone` (409) : seulement en `draft` / `confirmed`. Le report d'une commande planifiée passe par le traitement d'un événement (F6.3), via la fonction de service `mark_postponed`. L'annulation d'une commande planifiée n'est pas prévue. |
| L4-3 | Retour arrière `planned → confirmed` et `loaded → confirmed` : la spec n'en parle que par RM-16 (« le reste restant `confirmed` ») et par les arrêts non livrés (`skipped`). | Transitions autorisées, réservées aux autres modules (`release_to_confirmed`) : commande sortie d'un plan publié ou arrêt non livré → à replanifier. À confirmer avec les lots L5 / L6 (voir S7). |
| L4-4 | `postponed` : le report crée-t-il une commande pour un autre jour (J+1 ?), et faut-il saisir un motif ? | Non : la commande passe à `postponed` (statut final), sans date de report ni motif (aucune colonne prévue en §5). Le dispatcher ressaisit une commande pour le nouveau jour. |
| L4-5 | Peut-on « déconfirmer » une commande (`confirmed → draft`) ? | Non. Une commande confirmée reste modifiable ; sinon on l'annule. |
| L4-6 | Suppression d'une commande (le « D » de CRUD) : jusqu'à quel statut ? | Suppression réelle en `draft` seulement ; au-delà → 409, il faut annuler (la trace est conservée). |
| L4-7 | F3.4 : code HTTP du refus de confirmation pour volume trop grand. | 422, code `order_exceeds_tank_capacity`, `details[0].max_l` = volume recevable. (409 est réservé aux transitions interdites.) |
| L4-8 | F3.4 s'applique-t-il encore quand on modifie une commande déjà confirmée ? | Oui : le contrôle est rejoué à chaque modification d'une commande `confirmed` (bloquant ou avertissement). Un brouillon n'est contrôlé qu'à sa confirmation. |
| L4-9 | Fenêtre de livraison : peut-on ne saisir qu'une seule borne ? | Oui (début seul ou fin seule). Si les deux sont saisies : début < fin, sinon 422. |
| L4-10 | Commande sur une station inactive ou supprimée ? | Refusée à la saisie (422). Aucun contrôle sur la date (une commande peut être saisie pour un jour passé). |
| L4-11 | F2.1 : quels couples (dépôt, produit) sont « attendus » chaque matin ? Tous les dépôts ne distribuent peut-être pas tous les produits. | Tous les dépôts actifs × tous les produits. Un couple sans saisie est « non renseigné » (≠ 0 L, qui est une valeur saisie). |
| L4-12 | F2.1 : une saisie identique à la valeur courante doit-elle créer une ligne d'historique ? | Non (la grille de saisie rapide renvoie souvent toutes les lignes) : seule une valeur modifiée ajoute une ligne. |
| L4-13 | F2.2 / F2.3 : le motif de l'indisponibilité du jour est-il obligatoire ? | Facultatif (saisie rapide). |
| L4-14 | F2.2 dit « liste des camions `available` » : faut-il masquer les autres ? | Non : tous les camions sont renvoyés avec `assignable` et `block_reason` ; filtre `?assignable=true|false`. Un camion `reserved` est non affectable (comportement de `truck_block_reason` du socle, RM-04 ne cite que `maintenance` et `broken`). |
| L4-15 | F2.4 : deux chauffeurs ont le même camion habituel, ou le camion habituel est pris par un autre chauffeur pour la journée. | Une affectation du jour fait foi. Sinon le camion habituel revient au premier chauffeur affectable (ordre alphabétique) ; les autres n'ont pas de camion ce jour-là (`truck_id` nul). |
| L4-16 | F2.4 : comment dire « ce chauffeur n'a aucun camion aujourd'hui » ? | Pas de moyen dédié : `truck_id: null` supprime l'affectation du jour et rend le camion habituel. Pour écarter un chauffeur, le marquer indisponible. |
| L4-17 | F2.4 : peut-on affecter pour la journée un chauffeur bloqué par RM-03, ou un camion non affectable (RM-04) ? | Non : 409 `rule_violation` avec `details[].rule_code` = `RM-03` / `RM-04`. Un chauffeur seulement en repos / congé / marqué indisponible peut recevoir une affectation (il reste non affectable). |
| L4-18 | Marquer indisponible un camion ou un chauffeur déjà engagé dans un plan publié du jour. | Aucun contrôle ici : c'est le rôle des événements (F6.1, F6.2, lot L10). |
