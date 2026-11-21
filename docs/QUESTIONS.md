# Questions ouvertes

Les questions soulevées pendant le développement sont consignées par lot dans `docs/questions/<lot>.md`,
puis consolidées ici à chaque intégration. Aucune ne bloque le développement : une valeur par défaut est
adoptée et notée.

## Questions de la spec (§15) — à trancher avec OLA

| # | Question | Valeur adoptée en attendant |
|---|---|---|
| Q1 | « Dépotage à température ambiante » : s'agit-il bien de la correction de volume à 15 °C avec coefficients par produit ? | Oui (RM-12) |
| Q2 | Nombre max de chargements par camion et par jour au SCDP Douala, temps d'attente moyen observé ? | 2 chargements/jour, attente 90 min |
| Q3 | Volumes de commande en litres observés ou à 15 °C ? | Litres observés |
| Q4 | Stations livrables uniquement depuis un dépôt donné ? | Non |
| Q5 | Chauffeurs liés à un camion fixe ou interchangeables au sein d'un transporteur ? | Interchangeables au sein du transporteur |
| Q6 | Format de la journée de référence A : qu'existe-t-il réellement (km réels, heures) ? | Modèle `reference_day.xlsx`, km et heures facultatifs |

## Questions soulevées par le socle

| # | Constat | Décision provisoire |
|---|---|---|
| S1 | F3.4 parle du « stock station renseigné », mais le modèle de données (§5) n'a aucun champ de stock courant en station. | Contrôle à la confirmation : volume ≤ capacité de cuve − stock de sécurité si la cuve est définie pour (station, produit) ; sinon avertissement non bloquant. |
| S2 | F2.4 (affectation chauffeur ↔ camion du jour) n'a pas de table dans §5. | Table ajoutée : `daily_truck_drivers(day, truck_id, driver_id)`. |
| S3 | La feuille de route (§11) affiche le « contact station » et F7.3 envoie la fiche par e-mail aux gérants, mais `stations` n'a pas de contact. | Colonnes ajoutées : `contact_name`, `contact_phone`, `contact_email`. |
| S4 | §7.2 demande un drapeau `approximate` sur le plan, F8.4 un temps de préparation saisi, §7.4 des métriques et un journal de résolution : absents de `plans`. | Colonnes ajoutées : `approximate`, `prep_time_s`, `metrics`, `solver_log`, `label`, `root_plan_id` (lignée des versions). |
| S5 | Le temps de chargement au dépôt (§7.3 « paramètre ») est distinct du temps d'attente (F1.2). | Deux paramètres : `default_depot_wait_min` (90) et `depot_loading_time_min` (45). À confirmer avec OLA. |
| S6 | RM-11 : la durée de service court-elle depuis l'arrivée au dépôt ou depuis le départ du dépôt ? La spec dit « départ dépôt → retour dépôt ». | Durée = retour − départ du dépôt (attente et chargement exclus). À confirmer avec OLA. |
| S7 | RM-16 : la part non livrée d'une commande partielle « reste `confirmed` », mais une commande n'a qu'un statut. | À préciser par le lot L5 (reliquat = demandé − planifié dans le plan publié). |
