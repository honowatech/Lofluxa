# Questions du lot L3 — Référentiels et imports

Zones d'ombre rencontrées, avec la valeur par défaut adoptée dans le code. Aucune ne bloque.

## Référentiels

| # | Question | Valeur adoptée en attendant |
|---|---|---|
| L3-1 | « Capacité totale cohérente avec les compartiments » (F1.4) : la somme des compartiments doit-elle être **égale** à la capacité totale, ou seulement ne pas la dépasser ? | La somme ne peut pas **dépasser** la capacité totale (erreur 422 à l'API, erreur à l'import). Une somme inférieure est acceptée (avertissement à l'import). Capacité totale omise à la création = somme des compartiments. |
| L3-2 | Un code (station, dépôt, produit), une immatriculation ou un numéro de permis d'un élément **supprimé** peut-il être réutilisé ? La contrainte d'unicité de la base est globale. | Non par l'API (409 explicite). Par l'import, la clé d'un élément supprimé le **réactive** (annoncé « supprimé → réactivé »). Pas de route de restauration dans l'API. |
| L3-3 | Peut-on supprimer un transporteur qui a encore des camions ou des chauffeurs, un produit utilisé par des cuves ? | Refus 409 (`in_use`). Station, dépôt, camion, chauffeur : suppression logique sans contrôle (les commandes et plans existants gardent leurs références). |
| L3-4 | Cuves et compartiments n'ont pas de `deleted_at` dans le schéma. | Suppression physique ; refus 409 si un plan ou un chargement y fait référence (contrainte de clé étrangère). |
| L3-5 | Un compartiment dont la liste de produits autorisés est vide (`[]`) : aucun produit, ou tous ? | Refusé (422) : `null` = tous produits, sinon liste non vide. |
| L3-6 | Le camion habituel d'un chauffeur doit-il appartenir au même transporteur que lui (Q5 de la spec) ? | Non contrôlé. |
| L3-7 | Faut-il borner les coordonnées GPS au Cameroun (détection d'une inversion latitude / longitude) ? | Non : seules les bornes générales (−90..90, −180..180) sont contrôlées. Une emprise paramétrable pourrait être ajoutée. |
| L3-8 | La spec dit « CRUD » sans préciser `PUT` ou `PATCH`. | Les deux sont acceptés et équivalents : mise à jour partielle (champ absent = inchangé). `tanks` / `compartments` fournis dans un `PUT` remplacent la liste entière. |

## Imports

| # | Question | Valeur adoptée en attendant |
|---|---|---|
| L3-9 | Structure des fichiers stations / camions (« puis une ligne par cuve » §14) : feuille dédiée ou lignes répétées ? | **Une seule feuille, une ligne par cuve / compartiment**, code station ou immatriculation répété ; les autres colonnes « station » peuvent rester vides sur les lignes suivantes (une valeur contradictoire est une erreur). Même structure en xlsx et en csv. |
| L3-10 | Que signifie une cellule vide lors d'une mise à jour ? | **Inchangé.** L'import ne vide jamais une valeur et ne supprime jamais rien (cuves / compartiments absents du fichier conservés ; éléments absents du fichier intacts). Pour vider ou supprimer : écran Référentiels. |
| L3-11 | Statut d'un lot prévisualisé avec erreurs (l'énumération a `previewed`, `applied`, `rejected`). | `rejected` dès qu'il y a au moins une erreur : il ne s'applique pas, il faut corriger le fichier et prévisualiser à nouveau. Les avertissements ne bloquent pas. |
| L3-12 | Que faire si la base change entre « prévisualiser » et « appliquer » ? | À l'application, le plan d'import est recalculé ; s'il diffère de ce qui a été annoncé, refus 409 `stale_preview` et rien n'est écrit. |
| L3-13 | Transporteur inconnu dans le fichier camions ou chauffeurs (F1.4 : « transporteur (propre / tiers + nom) »). | Créé automatiquement, annoncé par un avertissement. Type : colonne « Type de transporteur » du fichier camions, sinon `tiers`. Le type d'un transporteur existant n'est jamais modifié par l'import. |
| L3-14 | Clé d'identification d'un chauffeur à l'import (pas de code dans le modèle). | Le **numéro de permis**, obligatoire dans le fichier (il reste facultatif à la saisie par l'API). |
| L3-15 | Ré-import de commandes : une commande n'a pas de clé naturelle. Deux commandes le même jour pour la même station et le même produit sont-elles possibles ? | Clé d'import = (date, station, produit) parmi les commandes non annulées / non reportées. Existante en `draft` et différente → mise à jour annoncée ; identique → inchangée ; déjà confirmée / planifiée et différente → ligne refusée ; deux lignes du fichier sur la même clé → erreur ; plusieurs commandes existantes sur la clé → erreur (à traiter à l'écran). |
| L3-16 | Commande importée pour une station inactive, ou pour un produit sans cuve dans la station (cf. S1). | Avertissements non bloquants. Le contrôle de volume F3.4 reste à la confirmation (lot L4). |
| L3-17 | Fenêtre de livraison (§14 : une colonne « fenêtre »). | Deux colonnes « Fenêtre début » / « Fenêtre fin » (HH:MM, heure locale), facultatives. |
| L3-18 | Format des horaires dans Excel. | Une colonne texte : « lun-ven 06:00-18:00 ; sam 06:00-12:00 » (jours non cités = fermé), « 24h/24 » = toujours ouvert, vide = non renseigné (donc ouvert en continu, comme `app.core.time`). |
| L3-19 | Nombres saisis avec séparateur de milliers (« 30.000 », « 30,000 ») dans un CSV. | Refusés comme ambigus pour les quantités (message explicite) ; décimales acceptées avec virgule ou point. |
| L3-20 | `ImportSource` (§8.3) n'a pas de `fetch_depots`, alors que F1.6 importe aussi les dépôts. | Protocole laissé tel que la spec ; `ExcelImportSource` offre `fetch_depots()` en plus. À ajouter au protocole si ACCPAC / SAP doivent fournir les dépôts. `fetch_orders(day)` accepte aussi `day=None` (toutes les dates du fichier). |
| L3-21 | Taille maximale d'un fichier importé. | Paramètre `import_max_file_mb` (10 Mo par défaut), ajouté à `settings`. |
