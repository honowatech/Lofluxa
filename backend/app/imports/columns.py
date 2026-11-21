"""Description des fichiers d'import : colonnes, en-têtes, aide et lignes d'exemple.

Source unique de vérité pour **lire** un fichier (`ExcelImportSource`) et pour **générer** les fichiers
modèles (`app/imports/templates.py`, `scripts/gen_templates.py`) : un modèle téléchargé est donc toujours
lisible par l'import.

Structure retenue (simple à remplir, valable en xlsx comme en csv) : **une seule feuille de données par
fichier**. Pour les stations et les camions, une ligne par cuve / par compartiment : les colonnes de la
station (ou du camion) sont remplies sur la première ligne, puis on répète seulement le code station
(ou l'immatriculation) sur les lignes suivantes — les autres colonnes « station » peuvent y rester vides.
"""

import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, time
from functools import partial
from typing import Any

from app.core.enums import (
    CarrierType,
    DepotOperator,
    DriverStatus,
    ImportKind,
    OrderPriority,
    TruckSize,
    TruckStatus,
)
from app.imports import tabular as tab


@dataclass(frozen=True)
class Column:
    key: str  # champ de l'enregistrement normalisé
    header: str  # en-tête affiché dans le fichier modèle
    parse: Callable[[Any], Any]
    help: str
    required: bool = False
    aliases: tuple[str, ...] = ()  # autres en-têtes acceptés (forme normalisée)
    choices: tuple[str, ...] = ()  # liste déroulante du fichier modèle
    sub: bool = False  # colonne de sous-ligne (cuve, compartiment)
    width: int = 18


@dataclass(frozen=True)
class FileSpec:
    kind: ImportKind
    sheet: str
    title: str
    notes: tuple[str, ...]
    columns: tuple[Column, ...]
    examples: tuple[tuple[Any, ...], ...]

    def column(self, key: str) -> Column:
        return next(c for c in self.columns if c.key == key)

    def header(self, key: str) -> str:
        return self.column(key).header


def _parse_email(value: Any) -> str:
    text = tab.parse_text(value)
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", text) or len(text) > 160:
        raise tab.CellError("Adresse e-mail invalide.")
    return text.lower()


def _text(max_length: int) -> Callable[[Any], str]:
    def _parse(value: Any) -> str:
        text = tab.parse_text(value)
        if len(text) > max_length:
            raise tab.CellError(f"Texte trop long ({max_length} caractères au plus).")
        return text

    return _parse


SIZES = {"petit": TruckSize.SMALL, "moyen": TruckSize.MEDIUM, "grand": TruckSize.LARGE}
OPERATORS = {
    "SCDP": DepotOperator.SCDP,
    "interne": DepotOperator.INTERNAL,
    "tiers": DepotOperator.THIRD_PARTY,
}
CARRIER_TYPES = {"propre": CarrierType.OWN, "tiers": CarrierType.THIRD_PARTY}
TRUCK_STATUSES = {
    "disponible": TruckStatus.AVAILABLE,
    "maintenance": TruckStatus.MAINTENANCE,
    "en panne": TruckStatus.BROKEN,
    "réservé": TruckStatus.RESERVED,
}
DRIVER_STATUSES = {
    "disponible": DriverStatus.AVAILABLE,
    "repos": DriverStatus.REST,
    "congé": DriverStatus.LEAVE,
    "malade": DriverStatus.SICK,
}
PRIORITIES = {"normale": OrderPriority.NORMAL, "urgente": OrderPriority.URGENT}


def _choice(mapping: dict[str, Any], extra: dict[str, Any] | None = None) -> Callable[[Any], Any]:
    """Accepte les libellés français, les valeurs techniques (`small`…) et quelques variantes."""
    accepted = {**mapping, **{member.value: member for member in mapping.values()}, **(extra or {})}
    return tab.choice_parser(accepted, ", ".join(mapping))


_HOURS_HELP = (
    "Texte : « lun-ven 06:00-18:00 ; sam 06:00-12:00 ». Jours : lun mar mer jeu ven sam dim. "
    "Plusieurs plages : « 06:00-12:00, 14:00-18:00 ». Jour non cité = fermé. « 24h/24 » = toujours ouvert. "
    "Vide = non renseigné (ouvert en continu à la création, inchangé en mise à jour)."
)
_COMMON_NOTES = (
    "Ne modifiez pas la ligne d'en-tête. Supprimez les lignes d'exemple avant d'importer vos données.",
    "Les colonnes obligatoires sont en orange. L'ordre des colonnes est libre ; une colonne inconnue est "
    "ignorée (signalée par un avertissement).",
    "Une cellule vide laisse la valeur existante inchangée lors d'une mise à jour, et prend la valeur par "
    "défaut lors d'une création. L'import ne supprime jamais rien.",
    "Nombres : sans séparateur de milliers (30000 et non 30 000 ou 30.000) ; décimales avec une virgule "
    "ou un point.",
    "L'import se fait en deux temps : « Prévisualiser » affiche les erreurs ligne par ligne et les "
    "créations / mises à jour prévues, puis « Appliquer » enregistre. Un fichier contenant une erreur "
    "n'est pas appliqué : corrigez-le et prévisualisez à nouveau.",
    "Formats acceptés : .xlsx (cette feuille) ou .csv (mêmes en-têtes, séparateur point-virgule ou virgule).",
)

STATIONS = FileSpec(
    kind=ImportKind.STATIONS,
    sheet="Stations",
    title="Import des stations et de leurs cuves",
    notes=(
        "Une ligne par cuve. Remplissez les colonnes de la station sur sa première ligne ; pour chaque cuve "
        "supplémentaire, ajoutez une ligne en répétant seulement le code station, puis produit, capacité et "
        "stock de sécurité.",
        "Une station est reconnue par son code : code inconnu = création, code existant = mise à jour "
        "(annoncée dans la prévisualisation). Une cuve est reconnue par son produit.",
        "Les produits doivent exister dans le référentiel (codes : voir l'écran Référentiels > Produits).",
        *_COMMON_NOTES,
    ),
    columns=(
        Column(
            "code",
            "Code station",
            tab.parse_code,
            "Identifiant unique de la station (ex. ST-AKWA). À répéter sur chaque ligne de cuve.",
            required=True,
            aliases=("code", "station"),
        ),
        Column("name", "Nom", _text(160), "Nom de la station. Obligatoire à la création.", width=28),
        Column("region", "Région", _text(80), "Région administrative (ex. Littoral)."),
        Column("city", "Ville", _text(80), "Ville ou localité."),
        Column(
            "lat",
            "Latitude",
            tab.parse_lat,
            "Degrés décimaux (ex. 4.0511). Obligatoire à la création.",
            aliases=("lat",),
        ),
        Column(
            "lon",
            "Longitude",
            tab.parse_lon,
            "Degrés décimaux (ex. 9.7085). Obligatoire à la création.",
            aliases=("lon", "lng", "long"),
        ),
        Column(
            "opening_hours",
            "Horaires de réception",
            tab.parse_opening_hours,
            _HOURS_HELP,
            aliases=("horaires", "horaires_reception", "horaires_d_ouverture"),
            width=40,
        ),
        Column(
            "max_truck_size",
            "Gabarit max",
            _choice(SIZES),
            "Plus gros camion accepté : petit, moyen ou grand. Par défaut : grand.",
            aliases=("gabarit", "gabarit_maximal"),
            choices=tuple(SIZES),
        ),
        Column(
            "unload_time_min",
            "Temps de dépotage (min)",
            partial(tab.parse_int, maximum=1440),
            "Durée moyenne d'un dépotage, en minutes. Vide = valeur par défaut des paramètres.",
            aliases=("temps_depotage", "temps_depotage_min", "temps_de_depotage"),
        ),
        Column(
            "contact_name",
            "Contact",
            _text(160),
            "Nom du gérant ou du contact sur place.",
            aliases=("contact_nom", "gerant"),
        ),
        Column(
            "contact_phone", "Téléphone", _text(40), "Téléphone du contact.", aliases=("contact_telephone",)
        ),
        Column(
            "contact_email",
            "E-mail",
            _parse_email,
            "E-mail du contact (envoi de la fiche de chargement).",
            aliases=("email", "contact_email", "courriel"),
            width=26,
        ),
        Column(
            "active",
            "Active",
            tab.parse_bool,
            "oui ou non. Par défaut : oui.",
            aliases=("actif",),
            choices=("oui", "non"),
        ),
        Column(
            "product_code",
            "Produit",
            tab.parse_code,
            "Code produit de la cuve (ex. SUPER, GASOIL, PETROLE). Vide = ligne sans cuve.",
            sub=True,
            aliases=("code_produit",),
        ),
        Column(
            "capacity_l",
            "Capacité cuve (L)",
            tab.parse_positive,
            "Capacité de la cuve en litres. Obligatoire si un produit est indiqué.",
            sub=True,
            aliases=("capacite", "capacite_cuve"),
        ),
        Column(
            "safety_stock_l",
            "Stock de sécurité (L)",
            tab.parse_non_negative,
            "Stock de sécurité en litres. Par défaut : 0.",
            sub=True,
            aliases=("stock_securite", "stock_securite_l"),
        ),
    ),
    examples=(
        (
            "ST-AKWA",
            "OLA Akwa",
            "Littoral",
            "Douala",
            4.0511,
            9.7085,
            "lun-sam 06:00-20:00 ; dim 07:00-13:00",
            "moyen",
            45,
            "M. Ndongo",
            "+237 699 00 00 01",
            "akwa@example.cm",
            "oui",
            "SUPER",
            30000,
            3000,
        ),
        (
            "ST-AKWA",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            "GASOIL",
            40000,
            4000,
        ),
        (
            "ST-BONAB",
            "OLA Bonabéri",
            "Littoral",
            "Douala",
            4.0712,
            9.6601,
            "24h/24",
            "grand",
            None,
            "Mme Ewane",
            "+237 677 00 00 02",
            None,
            "oui",
            "GASOIL",
            50000,
            5000,
        ),
    ),
)

TRUCKS = FileSpec(
    kind=ImportKind.TRUCKS,
    sheet="Camions",
    title="Import des camions et de leurs compartiments",
    notes=(
        "Une ligne par compartiment. Remplissez les colonnes du camion sur sa première ligne ; pour chaque "
        "compartiment supplémentaire, ajoutez une ligne en répétant seulement l'immatriculation, puis le "
        "numéro du compartiment, sa capacité et les produits autorisés.",
        "Un camion est reconnu par son immatriculation, un compartiment par son numéro (position).",
        "Un transporteur inconnu est créé automatiquement (annoncé dans la prévisualisation).",
        "La somme des capacités des compartiments ne peut pas dépasser la capacité totale. Capacité totale "
        "vide à la création = somme des compartiments.",
        *_COMMON_NOTES,
    ),
    columns=(
        Column(
            "plate",
            "Immatriculation",
            tab.parse_plate,
            "Identifiant unique du camion (ex. LT 123 AB). À répéter sur chaque ligne de compartiment.",
            required=True,
            aliases=("immat", "camion"),
        ),
        Column(
            "carrier_name",
            "Transporteur",
            _text(160),
            "Nom du transporteur. Créé s'il n'existe pas.",
            width=24,
        ),
        Column(
            "carrier_type",
            "Type de transporteur",
            _choice(CARRIER_TYPES),
            "propre (flotte OLA) ou tiers. "
            "Utilisé seulement à la création du transporteur. Par défaut : tiers.",
            aliases=("type_transporteur",),
            choices=tuple(CARRIER_TYPES),
        ),
        Column(
            "size",
            "Gabarit",
            _choice(SIZES),
            "petit, moyen ou grand. Obligatoire à la création.",
            choices=tuple(SIZES),
        ),
        Column(
            "total_capacity_l",
            "Capacité totale (L)",
            tab.parse_positive,
            "Capacité totale en litres. Vide à la création = somme des compartiments.",
            aliases=("capacite", "capacite_totale"),
        ),
        Column(
            "avg_speed_kmh",
            "Vitesse moyenne (km/h)",
            tab.parse_positive,
            "Vitesse moyenne de référence. Vide = valeur par défaut des paramètres.",
            aliases=("vitesse", "vitesse_moyenne"),
        ),
        Column(
            "status",
            "Statut",
            _choice(TRUCK_STATUSES, {"panne": TruckStatus.BROKEN}),
            "disponible, maintenance, en panne ou réservé. Par défaut : disponible.",
            choices=tuple(TRUCK_STATUSES),
        ),
        Column(
            "cost_per_km",
            "Coût au km (FCFA)",
            tab.parse_int,
            "Coût kilométrique indicatif (facultatif).",
            aliases=("cout_km", "cout_km_fcfa", "cout_kilometrique"),
        ),
        Column("notes", "Notes", _text(2000), "Remarques libres.", width=28),
        Column(
            "position",
            "Compartiment",
            partial(tab.parse_int, minimum=1, maximum=20),
            "Numéro du compartiment (1 = le plus proche de la cabine). Vide = ligne sans compartiment.",
            sub=True,
            aliases=("position", "numero_compartiment", "compartiment_n"),
        ),
        Column(
            "capacity_l",
            "Capacité compartiment (L)",
            tab.parse_positive,
            "Capacité du compartiment en litres. Obligatoire si un numéro de compartiment est indiqué.",
            sub=True,
            aliases=("capacite_compartiment",),
            width=24,
        ),
        Column(
            "allowed_product_codes",
            "Produits autorisés",
            tab.parse_code_list,
            "Codes produit séparés "
            "par des virgules (ex. SUPER, GASOIL), ou « tous ». Vide = tous produits à la création.",
            sub=True,
            aliases=("produits", "produits_compatibles", "produit"),
            width=24,
        ),
    ),
    examples=(
        ("LT 123 AB", "Transcam", "tiers", "grand", 33000, 45, "disponible", 650, None, 1, 11000, "tous"),
        ("LT 123 AB", None, None, None, None, None, None, None, None, 2, 11000, "SUPER, GASOIL"),
        ("LT 123 AB", None, None, None, None, None, None, None, None, 3, 11000, "GASOIL"),
        (
            "LT 456 CD",
            "OLA Flotte",
            "propre",
            "petit",
            12000,
            None,
            "maintenance",
            None,
            "Révision annuelle",
            1,
            12000,
            "tous",
        ),
    ),
)

DRIVERS = FileSpec(
    kind=ImportKind.DRIVERS,
    sheet="Chauffeurs",
    title="Import des chauffeurs",
    notes=(
        "Une ligne par chauffeur. Un chauffeur est reconnu par son numéro de permis : numéro inconnu = "
        "création, numéro existant = mise à jour (annoncée dans la prévisualisation).",
        "Un transporteur inconnu est créé automatiquement (type « tiers »). Le camion habituel doit déjà "
        "exister : importez les camions d'abord.",
        *_COMMON_NOTES,
    ),
    columns=(
        Column(
            "license_no",
            "Numéro de permis",
            _text(64),
            "Identifiant unique du chauffeur.",
            required=True,
            aliases=("permis", "n_permis", "no_permis", "numero_permis"),
            width=20,
        ),
        Column(
            "full_name",
            "Nom complet",
            _text(160),
            "Nom et prénom. Obligatoire à la création.",
            aliases=("nom", "chauffeur"),
            width=28,
        ),
        Column("phone", "Téléphone", _text(40), "Téléphone du chauffeur."),
        Column(
            "license_expiry",
            "Expiration du permis",
            tab.parse_date,
            "Date (JJ/MM/AAAA). Un permis expiré rend le chauffeur non affectable.",
            aliases=("expiration_permis", "date_expiration_permis"),
            width=20,
        ),
        Column(
            "hazmat_cert",
            "Habilitation matières dangereuses",
            tab.parse_bool,
            "oui ou non. Par défaut : non (chauffeur non affectable sans habilitation).",
            aliases=("habilitation", "habilitation_md", "adr"),
            choices=("oui", "non"),
            width=30,
        ),
        Column(
            "hazmat_expiry",
            "Expiration de l'habilitation",
            tab.parse_date,
            "Date (JJ/MM/AAAA).",
            aliases=("expiration_habilitation", "expiration_de_l_habilitation"),
            width=24,
        ),
        Column(
            "carrier_name",
            "Transporteur",
            _text(160),
            "Nom du transporteur. Créé s'il n'existe pas.",
            width=24,
        ),
        Column(
            "status",
            "Statut",
            _choice(DRIVER_STATUSES, {"conge": DriverStatus.LEAVE}),
            "disponible, repos, congé ou malade. Par défaut : disponible.",
            choices=tuple(DRIVER_STATUSES),
        ),
        Column(
            "default_truck_plate",
            "Camion habituel",
            tab.parse_plate,
            "Immatriculation du camion habituel (facultatif).",
            aliases=("camion", "immatriculation"),
        ),
    ),
    examples=(
        (
            "CM-2020-0001",
            "Jean Mbarga",
            "+237 677 00 00 01",
            date(2028, 6, 30),
            "oui",
            date(2027, 12, 31),
            "Transcam",
            "disponible",
            "LT 123 AB",
        ),
        (
            "CM-2019-0457",
            "Paul Atangana",
            "+237 699 00 00 02",
            date(2027, 3, 15),
            "oui",
            date(2027, 9, 30),
            "OLA Flotte",
            "repos",
            None,
        ),
    ),
)

DEPOTS = FileSpec(
    kind=ImportKind.DEPOTS,
    sheet="Dépôts",
    title="Import des dépôts",
    notes=(
        "Une ligne par dépôt. Un dépôt est reconnu par son code : code inconnu = création, code existant = "
        "mise à jour (annoncée dans la prévisualisation).",
        *_COMMON_NOTES,
    ),
    columns=(
        Column(
            "code",
            "Code dépôt",
            tab.parse_code,
            "Identifiant unique du dépôt (ex. SCDP-DLA).",
            required=True,
            aliases=("code", "depot", "code_depot"),
        ),
        Column("name", "Nom", _text(160), "Nom du dépôt. Obligatoire à la création.", width=28),
        Column(
            "operator",
            "Exploitant",
            _choice(OPERATORS),
            "SCDP, interne ou tiers. Par défaut : SCDP.",
            choices=tuple(OPERATORS),
        ),
        Column(
            "lat",
            "Latitude",
            tab.parse_lat,
            "Degrés décimaux (ex. 4.0435). Obligatoire à la création.",
            aliases=("lat",),
        ),
        Column(
            "lon",
            "Longitude",
            tab.parse_lon,
            "Degrés décimaux (ex. 9.7043). Obligatoire à la création.",
            aliases=("lon", "lng", "long"),
        ),
        Column("address", "Adresse", _text(500), "Adresse ou repère.", width=28),
        Column(
            "opening_hours",
            "Horaires d'ouverture",
            tab.parse_opening_hours,
            _HOURS_HELP,
            aliases=("horaires", "horaires_ouverture"),
            width=40,
        ),
        Column(
            "avg_wait_min",
            "Attente moyenne (min)",
            partial(tab.parse_int, maximum=1440),
            "Temps moyen d'attente avant chargement, en minutes. Vide = valeur par défaut des paramètres.",
            aliases=("attente", "attente_moyenne", "temps_attente"),
        ),
        Column(
            "max_loadings_per_truck_day",
            "Chargements max par camion et par jour",
            partial(tab.parse_int, minimum=1, maximum=50),
            "Vide = valeur par défaut des paramètres.",
            aliases=("chargements_max", "chargements_max_par_camion"),
            width=34,
        ),
        Column(
            "active",
            "Actif",
            tab.parse_bool,
            "oui ou non. Par défaut : oui.",
            aliases=("active",),
            choices=("oui", "non"),
        ),
    ),
    examples=(
        (
            "SCDP-DLA",
            "SCDP Douala",
            "SCDP",
            4.0435,
            9.7043,
            "Zone portuaire, Douala",
            "lun-sam 06:00-18:00",
            90,
            2,
            "oui",
        ),
        (
            "SCDP-YDE",
            "SCDP Yaoundé",
            "SCDP",
            3.8312,
            11.5321,
            "Nsam, Yaoundé",
            "lun-ven 06:00-17:00 ; sam 06:00-12:00",
            60,
            2,
            "oui",
        ),
    ),
)

ORDERS = FileSpec(
    kind=ImportKind.ORDERS,
    sheet="Commandes",
    title="Import des commandes du jour",
    notes=(
        "Une ligne par commande (une station, un produit, un volume). Les commandes importées sont créées "
        "à l'état « brouillon » : elles restent à confirmer à l'écran Commandes.",
        "Ré-import : une commande existante pour la même date, la même station et le même produit est mise "
        "à jour si elle est encore en brouillon (annoncé dans la prévisualisation) ; si elle est déjà "
        "confirmée ou planifiée, la ligne est refusée.",
        "Les stations et les produits doivent exister dans les référentiels.",
        *_COMMON_NOTES,
    ),
    columns=(
        Column(
            "day",
            "Date",
            tab.parse_date,
            "Jour de livraison (JJ/MM/AAAA).",
            required=True,
            aliases=("jour", "date_livraison"),
        ),
        Column(
            "station_code",
            "Code station",
            tab.parse_code,
            "Code de la station à livrer.",
            required=True,
            aliases=("station", "code"),
        ),
        Column(
            "product_code",
            "Produit",
            tab.parse_code,
            "Code produit (ex. SUPER, GASOIL, PETROLE).",
            required=True,
            aliases=("code_produit",),
        ),
        Column(
            "requested_l",
            "Volume (L)",
            tab.parse_positive,
            "Volume demandé en litres.",
            required=True,
            aliases=("volume", "volume_demande", "quantite", "quantite_l"),
        ),
        Column(
            "priority",
            "Priorité",
            _choice(PRIORITIES),
            "normale ou urgente. Par défaut : normale.",
            choices=tuple(PRIORITIES),
        ),
        Column(
            "window_start",
            "Fenêtre début",
            tab.parse_time,
            "Début de la fenêtre de livraison souhaitée (HH:MM, heure locale). Facultatif.",
            aliases=("debut", "fenetre_debut", "heure_debut"),
        ),
        Column(
            "window_end",
            "Fenêtre fin",
            tab.parse_time,
            "Fin de la fenêtre de livraison souhaitée (HH:MM, heure locale). Facultatif.",
            aliases=("fin", "fenetre_fin", "heure_fin"),
        ),
        Column("comment", "Commentaire", _text(2000), "Remarque libre.", width=32),
    ),
    examples=(
        (date(2027, 1, 12), "ST-AKWA", "SUPER", 12000, "normale", time(8, 0), time(12, 0), None),
        (date(2027, 1, 12), "ST-AKWA", "GASOIL", 15000, "urgente", None, None, "Rupture annoncée"),
        (date(2027, 1, 12), "ST-BONAB", "GASOIL", 20000, "normale", None, None, None),
    ),
)

SPECS: dict[ImportKind, FileSpec] = {s.kind: s for s in (STATIONS, TRUCKS, DRIVERS, DEPOTS, ORDERS)}
