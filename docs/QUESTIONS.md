# Questions ouvertes

Les questions soulevées pendant le développement sont consignées par lot dans `docs/questions/<lot>.md`,
puis consolidées ici à chaque intégration. Aucune ne bloque le développement : une valeur par défaut est
adoptée et notée.

## À trancher avec OLA en priorité

Synthèse des points qui changent ce que voit ou fait un utilisateur d'OLA, ou le résultat du test A/B.
Chaque ligne renvoie à la question détaillée du lot qui l'a soulevée. La valeur indiquée est celle que le
prototype applique aujourd'hui.

### Avant le test A/B

| Sujet | Question | Appliqué aujourd'hui | Détail |
|---|---|---|---|
| Unité des commandes | Les volumes commandés sont-ils en litres observés ou en litres à 15 °C ? | Litres observés | Q3 |
| Avertissement d'écart de chargement | RM-13 compare un volume chargé corrigé à 15 °C à un volume planifié en litres observés : à 24–30 °C, la seule correction de température représente 1,1 à 1,8 % pour une tolérance de 2 %. Faut-il comparer à unités égales, ou relever la tolérance ? | Règle appliquée à la lettre ; l'écran et la fiche expliquent la part due à la température | L6-4, L13 |
| Base du verdict A/B | Le gain kilométrique se mesure-t-il sur les km estimés des deux plans (même matrice) ou sur les km réels du plan manuel ? | Km estimés des deux plans ; km réels affichés à titre indicatif | L7-1 |
| Contenu de la journée A | Le fichier d'OLA contiendra-t-il les commandes demandées mais non livrées ? Sinon « autant de commandes servies » est vrai par construction. | Si absentes : demandé = livré, avec avertissement | L7-2 |
| Ressources du rejeu | Le rejeu doit-il se limiter aux camions réellement utilisés ce jour-là ? | Toute la flotte disponible du jour | L7-4 |
| Seuil de calcul | Les 60 secondes portent-elles sur le moteur seul ou sur tout le calcul, matrice de distances comprise ? | Les deux sont mesurés ; à l'échelle sans serveur de routage : environ 20 à 25 s | L15 |
| Coût fixe | Compte-t-on un coût fixe par tournée ou par camion sorti ? Le moteur ne cherche pas aujourd'hui à sortir moins de camions, alors que c'est un indicateur du test. | Par tournée (lecture littérale de la spec) | L2 M3 |
| Deux dépôts le même jour | Un camion peut-il charger dans deux dépôts différents le même jour ? | Non | L2 M1 |
| Livraison partielle | Le moteur peut-il proposer d'office une livraison partielle quand une commande ne tient pas en entier ? Le seuil de 50 % s'applique-t-il au reliquat ou à la commande d'origine ? | Oui, proposée d'office ; seuil appliqué au reliquat | L2 M4, L5 |
| Profil camion | Gabarit et vitesses du profil de routage (4,0 m, 40 t, vitesses voiture × 0,8, plafond 80 km/h), un seul profil pour tous les camions. | Ces valeurs, non essayées sur un vrai serveur de routage | L8 |

### Règles d'exploitation

| Sujet | Question | Appliqué aujourd'hui | Détail |
|---|---|---|---|
| Panne de camion | Le produit du camion en panne est-il transbordé ou le camion de remplacement recharge-t-il au dépôt ? | Rechargement au dépôt | L10-1 |
| Publication après un événement | La nouvelle version créée par une panne ou une pénurie est-elle publiée d'office ? | Oui si elle n'a aucune violation bloquante, sinon brouillon à valider | L10 |
| Camion en panne | Passe-t-il « en panne » dans le référentiel ou seulement indisponible pour la journée ? | Indisponible pour la journée | L10-3 |
| Stock lors d'une pénurie | La valeur saisie par Supply est-elle le stock total du jour ou le restant ? | Stock total du jour | L10-14 |
| Report d'une commande | Un report crée-t-il une commande à une autre date, avec un motif ? | Non : statut final | L4-4 |
| Arrêt sauté | Une commande dont l'arrêt est sauté, ou livré à 0 litre, repart-elle à replanifier ? | Oui | L6-16 |
| Camion « réservé » | Est-il affectable ? | Non | L1 R3 |
| Volume livré supérieur au demandé | Blocage ou simple avertissement ? | Avertissement (tableau de la spec, RM-16) | L1 R11 |
| Horaires du dépôt | Faut-il contrôler aussi le retour après la fermeture ? | Seule l'arrivée au dépôt est contrôlée | L1 R6 |
| Durée de service | Court-elle depuis l'arrivée au dépôt ou depuis le départ ? | Depuis le départ du dépôt | S6 |
| Chauffeur sans date d'expiration | Permis ou habilitation sans date : bloquant ? Habilitation absente : bloquant ? | Date absente : non bloquant ; habilitation absente : non affectable | S8 |
| Stocks attendus chaque matin | Supply saisit-il tous les dépôts actifs × tous les produits ? Peut-il effacer une saisie ? | Oui aux deux | L4-11, L4-19 |
| Ré-import de commandes | Une commande est identifiée par (date, station, produit) ; une ligne qui modifie une commande déjà confirmée est refusée. | Ces règles | L3-15 |
| Somme des compartiments | Doit-elle être égale à la capacité totale du camion, ou seulement inférieure ou égale ? | Inférieure ou égale, avertissement si inférieure | L3-1 |

### Mise en service

| Sujet | Question | Appliqué aujourd'hui | Détail |
|---|---|---|---|
| Limite de connexions | 10 connexions par minute et par adresse IP : si les postes d'OLA sortent par une même adresse, le quota est partagé. Plafond par compte, ou seuil relevé ? | 10 par minute et par adresse | L8, L9 |
| Sauvegardes hors serveur | Stockage au nom d'OLA ou de Honowa ? | Copie hebdomadaire désactivée tant que ce n'est pas décidé | L8 |
| Politique de mot de passe | 8 caractères minimum, sans autre règle : suffisant ? | Ces règles | L8 |
| Écrans par rôle | Quels écrans chaque rôle voit-il ? (ex. Supply et le Journal des événements pour déclarer une pénurie) | Table des droits de l'interface, alignée sur les rôles exigés par l'API | L9, L13 |
| Alerte de sauvegarde | Faut-il prévenir quelqu'un si une sauvegarde échoue ? | Aucune alerte | L8 |

## Détail par lot

| Fichier | Lot |
|---|---|
| [`questions/l1-regles.md`](questions/l1-regles.md) | Règles métier |
| [`questions/l2-moteur.md`](questions/l2-moteur.md) | Moteur de tournées |
| [`questions/l3-referentiels.md`](questions/l3-referentiels.md) | Référentiels et imports |
| [`questions/l4-commandes.md`](questions/l4-commandes.md) | Commandes et disponibilité |
| [`questions/l5-plans.md`](questions/l5-plans.md) | Service de plans |
| [`questions/l6-chargement.md`](questions/l6-chargement.md) | Chargement et livraisons |
| [`questions/l7-comparaison.md`](questions/l7-comparaison.md) | Comparaison A/B |
| [`questions/l8-admin-infra.md`](questions/l8-admin-infra.md) | Administration et infrastructure |
| [`questions/l9-frontend.md`](questions/l9-frontend.md) | Socle de l'interface |
| [`questions/l10-evenements.md`](questions/l10-evenements.md) | Événements du jour |
| [`questions/l11-ecrans.md`](questions/l11-ecrans.md) | Écrans Journée, Commandes, Disponibilité |
| [`questions/l12-ecran-plan.md`](questions/l12-ecran-plan.md) | Écran Plan de tournées |
| [`questions/l13-ecrans.md`](questions/l13-ecrans.md) | Écrans Chargement, Suivi, Journal |
| [`questions/l14-ecran-comparaison.md`](questions/l14-ecran-comparaison.md) | Écran Comparaison |
| [`questions/l15-demo.md`](questions/l15-demo.md) | Démonstration de bout en bout |

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
| S7 | RM-16 : la part non livrée d'une commande partielle « reste `confirmed` », mais une commande n'a qu'un statut. | Tranché par le lot L5 : reliquat = demandé − planifié dans les plans publiés ; une commande entièrement planifiée passe `planned`, une commande partielle reste `confirmed` et son reliquat est repris au calcul suivant. |
| S8 | RM-03 : que faire d'un chauffeur dont la date d'expiration du permis ou de l'habilitation n'est pas renseignée, ou sans habilitation matières dangereuses ? | Date non renseignée : non bloquant. Habilitation absente (`hazmat_cert = false`) : non affectable. À confirmer avec OLA. |
