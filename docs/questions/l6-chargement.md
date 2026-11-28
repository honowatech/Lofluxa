# Questions du lot L6 — Chargement au dépôt et livraisons

Zones d'ombre rencontrées, valeur par défaut adoptée en attendant la réponse d'OLA. Aucune ne bloque.

## Conversion à 15 °C et écart (RM-12, RM-13)

| # | Question | Valeur adoptée |
|---|---|---|
| L6-1 | RM-12 : quelle précision et quel arrondi pour le volume à 15 °C ? | Centième de litre (précision de `numeric(12,2)`), arrondi « demi vers le haut » (102,485 → 102,49). Calcul en `Decimal`. |
| L6-2 | RM-13 : l'écart se juge-t-il par compartiment, par produit ou au total de la tournée ? | **Par compartiment et au total de la tournée.** Un seul avertissement RM-13 par tournée dès qu'un compartiment ou le total sort de la tolérance ; le message détaille les compartiments en cause. Un compartiment planifié mais non chargé compte pour 0 L. |
| L6-3 | RM-13 : « au-delà de la tolérance » est-il strict ? L'écart vaut-il dans les deux sens ? | Strict (un écart de 2,00 % pile n'alerte pas), en valeur absolue (sur- et sous-chargement). Pourcentage rapporté au volume planifié. |
| L6-4 | RM-13 / Q3 : les volumes planifiés viennent des commandes, supposées en litres observés (Q3), alors que RM-13 les compare à un volume **à 15 °C**. Faut-il comparer à iso-unité ? | Application littérale de RM-13 : volume à 15 °C chargé contre volume planifié tel quel. À revoir avec la réponse à Q3 (par forte chaleur, la seule correction de température peut approcher la tolérance : ≈ 1,8 % pour du super à 30 °C). En attendant, la réponse du chargement et la fiche PDF décomposent l'écart (part de la correction de température, part de l'écart de volume observé) pour expliquer un avertissement ; la règle est inchangée. |
| L6-5 | Un chargement sur un compartiment du camion qui n'est pas prévu au plan de chargement, ou avec un autre produit que celui prévu, est-il acceptable ? | Refusé (422) : le compartiment doit appartenir au camion **et** figurer au plan de chargement avec le même produit. Si le dépôt change réellement l'affectation, le dispatcher corrige le plan. |
| L6-6 | Le chargement doit-il couvrir tous les compartiments planifiés ? | Non : saisie partielle acceptée, mais le manque ressort en écart RM-13 (compartiment et total). |
| L6-7 | Le numéro de bon de chargement dépôt est-il unique par tournée ou propre à chaque compartiment / produit ? | Un numéro par chargement (colonne `loadings.depot_ticket_no` du schéma §5), pas par ligne. |
| L6-8 | Les trois heures (arrivée, début, fin de chargement) sont-elles obligatoires ? | Facultatives (colonnes nullables) ; celles qui sont renseignées doivent être ordonnées (arrivée ≤ début ≤ fin). |
| L6-9 | La tolérance RM-13 affichée à la relecture est-elle celle du moment de l'enregistrement ou la valeur courante ? | L'avertissement (`constraint_violations`) est écrit à l'enregistrement ; les écarts relus par l'API et sur la fiche utilisent la valeur courante de `loading_tolerance_pct`. |
| L6-26 | RM-13 : après un événement qui réduit le plan d'une tournée déjà chargée (panne : arrêts transférés), à quoi compare-t-on le chargement ? | Au planifié **du moment du chargement**, conservé sur `loading_lines.planned_l` et recopié de version en version. Tant que le plan de chargement n'a pas changé pour les compartiments chargés, c'est le plan courant qui sert (il compte aussi les compartiments planifiés non chargés, L6-6). Un ré-enregistrement du chargement reprend le plan courant comme référence. |
| L6-10 | L'avertissement RM-13 est ajouté à un plan `published` : est-ce une « modification du plan » au sens de RM-18 ? | Non : les réalisations (chargement, statuts, livraisons, avertissement RM-13) ne créent pas de nouvelle version. **Attention intégration** : `recheck_plan` (lot L5) ne doit pas effacer les lignes `rule_code = "RM-13"`. |

## Statuts et livraisons (F7.4)

| # | Question | Valeur adoptée |
|---|---|---|
| L6-11 | Enregistrer le chargement fait-il passer automatiquement la tournée à `loaded` ? | Non : le statut ne change que par `PUT /trips/{id}/status`. Le chargement se saisit ou se corrige tant que la tournée est `planned`, `at_depot` ou `loaded` ; il est figé ensuite (409). |
| L6-12 | Peut-on revenir en arrière ou sauter un statut de tournée ? | Non : un seul pas en avant ; tout le reste → 409. Pas de correction possible des heures / km réels une fois `completed` (à prévoir si OLA le demande). |
| L6-13 | Dans quel état de tournée saisit-on une livraison ? Peut-on corriger une saisie ? | Uniquement `in_progress` (sinon 409). Tant que la tournée est en cours, volumes, heures et même livré ↔ sauté restent corrigeables, sauf si la correction ferait repasser sous le seuil une commande déjà `delivered` (statut définitif chez L4 : 409 `invalid_order_transition`). |
| L6-14 | Arrêt livré : faut-il un volume pour chaque commande de l'arrêt ? Les heures sont-elles obligatoires ? | Oui, un volume (≥ 0) pour chaque commande de l'arrêt, ni plus ni moins. Heure d'arrivée obligatoire, heure de départ facultative. |
| L6-15 | Un volume livré peut-il dépasser le volume planifié ou demandé (RM-16) ? | Pas de contrôle à la saisie des réalisations (RM-16 est une règle de planification) : le volume réel est enregistré tel quel. |
| L6-16 | Que devient une commande dont le volume livré est 0, ou dont l'arrêt est sauté ? | Elle repart à replanifier : `confirmed` ; `actual_l` = 0 (livré à 0) ou vide (arrêt sauté). |
| L6-17 | Répercussion sur les commandes (RM-16) ? | `loaded` : les commandes `planned` de la tournée (une commande planifiée en partie, restée `confirmed`, garde son statut ; annulées et reportées ne sont pas touchées). À la livraison, jamais de refus pour une livraison partielle : la commande passe `delivered` seulement si elle est **entièrement livrée** (somme des `actual_l` des arrêts livrés des plans calculés publiés ≥ volume demandé, à la tolérance près, voir L6-24) ; sinon elle garde son statut si le reste est déjà planifié sur un arrêt en attente d'un plan publié, et repart en `confirmed` (reliquat à replanifier) dans le cas contraire. Transitions par `app/orders/service.py` (`mark_loaded`, `mark_fully_delivered`, `release_to_confirmed`). |
| L6-18 | Heures réelles non saisies au changement de statut ? | `actual_depart_at` (passage à `in_progress`) prend l'heure courante à défaut. `actual_return_at` (passage à `completed`) prend le plus tardif de l'heure courante et de la dernière heure réelle connue de la tournée (départ, arrêts), pour rester cohérent sur une journée datée dans le futur ; une valeur fournie reste contrôlée (retour ≥ départ). `actual_distance_m` reste vide. |
| L6-19 | Les changements de statut doivent-ils figurer au journal des événements ? | Non : §5 ne prévoit pas de type d'événement pour cela ; ils sont tracés par le journal d'audit (`trips`). Seuls `loading_recorded` et `delivery_recorded` sont journalisés. |
| L6-24 | À partir de quel volume une commande est-elle « entièrement livrée » ? Un compteur de station ne donne jamais exactement le volume demandé. | Volume réellement livré ≥ volume demandé × (1 − `loading_tolerance_pct`), soit 2 % par défaut : la tolérance d'écart de volume existante est réutilisée plutôt que d'ajouter un paramètre. À confirmer avec OLA (faut-il un paramètre distinct ?). |
| L6-25 | Une commande planifiée en entier mais livrée sous ce seuil (ex. 7 000 L sur 10 000) repasse `confirmed` : son reliquat réel est-il replanifié ? | Pas aujourd'hui : le service de plans calcule le reliquat sur le volume **planifié** des arrêts livrés (`planning/mapping.py::planned_elsewhere`), donc 0. Défaut figé par un test `xfail(strict)` (`test_reliquat_d_une_commande_sous_livree_repris_par_le_service_de_plans`) ; correction attendue côté L5 : pour un arrêt `delivered`, compter `coalesce(actual_l, planned_l)`. |

## Fiche de chargement (F7.3, §11)

| # | Question | Valeur adoptée |
|---|---|---|
| L6-20 | La fiche peut-elle être éditée avant l'enregistrement du chargement ? | Non : 409 (`loading_missing`). Avant chargement, c'est la feuille de route (lot L5) qui sert. |
| L6-21 | Qui signe la fiche de chargement ? | Trois zones : chauffeur, agent Fleet (dépôt), gérant de station. |
| L6-22 | « Heure de départ » de la fiche : prévue ou réelle ? | Réelle si elle est saisie, sinon prévue (le libellé le précise). |
| L6-23 | Envoi par e-mail : un message par station ou un seul ? Que faire des stations sans adresse ? | Un seul message à tous les gérants de la tournée (`stations.contact_email`, dédoublonnées), ou aux destinataires fournis dans la requête. Les stations sans adresse sont renvoyées dans `stations_without_email` ; aucun destinataire → 422. Envoi synchrone ; échec SMTP → 502. |

## Ajouts à l'API (hors liste de la spec §9)

- `GET /loadings?day=&depot_id=` — vue Fleet (écran 7) : tournées des plans publiés du jour (défaut : aujourd'hui,
  heure locale), filtrables par dépôt, avec libellés, avancement des arrêts et résumé du chargement. Paginé.
  Seules les versions en vigueur sont listées (plans `published`, jamais `archived`) ; chaque ligne porte `plan_id`,
  `plan_version` et `plan_label` pour distinguer deux plans publiés le même jour.
- `GET /trips/{id}/loading` — relecture du chargement enregistré (404 `loading_not_found` s'il n'existe pas).

## Remarques pour le socle

- `app/core/pdf.py` annonce le raccourci de gabarit `"<module>/x.html"` (ex. `render_pdf("loading/loading_sheet.html")`),
  mais le chargeur Jinja2 ne le résout pas : il faut `"loading/templates/loading_sheet.html"`. Non modifié (hors périmètre).
