/** Textes de l'écran « plan » (vague 2, lot L12). Seul le lot propriétaire de l'écran modifie ce fichier. */
const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);

export const planTexts = {
  title: "Plan de tournées",

  selector: {
    label: "Plan et version affichés",
    /** Nature d'un plan : dit toujours de quoi il s'agit, dans la liste comme en tête d'écran. */
    natures: { computed: "Plan du jour", manual_reference: "Journée de référence", replay: "Rejeu" },
    /** Groupe de la liste : une lignée (un plan et ses versions). */
    lineage: (nature: string, index: number | null, detail: string | null) =>
      `${nature}${index ? ` ${index}` : ""}${detail ? ` — ${detail}` : ""}`,
    trips: (n: number) => `${n} ${plural(n, "tournée", "tournées")}`,
    named: (label: string) => `« ${label} »`,
    /** Option : nature, version, statut, heure — complète même quand la liste est repliée. */
    option: (nature: string, version: number, status: string, time: string) =>
      `${nature} · Version ${version} · ${status} · ${time}`,
    /** Plusieurs plans de même nature le même jour : « Plan du jour 2 (1 tournée) ». */
    ranked: (nature: string, index: number, trips: string | null) =>
      `${nature} ${index}${trips ? ` (${trips})` : ""}`,
    severalInForce: (n: number) => `${n} plans du jour publiés ce jour : chacun a ses propres tournées.`,
    inForce: "en vigueur",
    inForceBadge: "En vigueur",
    inForceHint: "Version de référence du terrain pour ce plan.",
    single: (nature: string, version: number) => `${nature} · Version ${version}`,
  },

  header: {
    approximate: "Distances approchées",
    approximateHint:
      "Le serveur de distances routières n'a pas répondu : distances et durées estimées à vol d'oiseau corrigé.",
    computedAt: (time: string, duration: string | null, engine: string | null | undefined) =>
      `Calculé à ${time}${duration ? ` en ${duration}` : ""}${engine ? ` · moteur ${engine}` : ""}`,
    createdBy: (name: string) => `par ${name}`,
    viewLabel: "Vue du plan",
    viewMap: "Carte",
    viewTable: "Tableau",
    history: "Historique",
    recompute: "Recalculer en conservant",
    publish: "Publier",
    routeSheets: "Feuilles de route",
    routeSheet: "Feuille de route",
    saving: "Enregistrement…",
    saved: "Plan à jour",
  },

  metrics: {
    trips: (n: number) => `${n} ${plural(n, "tournée", "tournées")}`,
    distance: "Distance",
    duration: "Durée",
    fill: "Remplissage moyen",
    served: "Commandes servies",
    servedValue: (served: number, total: number) => `${served} / ${total}`,
    volume: "Volume planifié",
    trucks: "Camions",
  },

  empty: {
    title: "Aucun plan pour cette journée",
    body: (day: string) =>
      `Aucun plan n'a encore été calculé pour le ${day}. Confirmez les commandes et lancez le calcul depuis l'écran Journée.`,
    action: "Aller à la journée",
    noTrips: "Ce plan ne contient aucune tournée.",
    noTripsHint: "Toutes les commandes figurent dans les non servies, avec la raison.",
  },

  readOnly: {
    role: "Lecture seule : votre rôle ne permet pas de modifier le plan.",
    reference: "Journée de référence importée : ce plan est en lecture seule.",
    archived: "Version archivée, en lecture seule. Pour repartir d'elle : Historique → Restaurer.",
    publishedWithDraft: (version: number) =>
      `Ce plan est publié et une version ${version} est déjà en préparation : les modifications se font sur le brouillon.`,
    openDraft: "Ouvrir le brouillon",
    published:
      "Plan publié. Toute modification crée une nouvelle version brouillon ; la version publiée reste la référence du terrain jusqu'à la publication de la nouvelle (RM-18).",
    draftOfPublished: (draft: number, published: number) =>
      `Version ${draft} — brouillon. La version ${published} publiée reste la référence du terrain tant que ce brouillon n'est pas publié.`,
    openPublished: "Voir la version publiée",
    replay: "Rejeu de comparaison : modifiable, mais non publiable.",
    eventDraft: (version: number, blocking: number) =>
      blocking > 0
        ? `Version ${version} créée par un événement : ${blocking} ${plural(blocking, "violation bloquante", "violations bloquantes")} à corriger avant publication.`
        : `Version ${version} créée par un événement : aucune violation bloquante, elle prendra effet à sa publication.`,
    eventDraftReference: (published: number) =>
      `La version ${published} publiée reste la référence du terrain d'ici là.`,
    eventDraftOrigin: (type: string, time: string) => `${type} · ${time}`,
    superseded: (current: number) =>
      `Cette version a été remplacée : la version ${current} est en vigueur (publiée). Celle-ci est archivée, en lecture seule.`,
    supersededNow: (shown: number, current: number) =>
      `La version ${shown} affichée vient d'être archivée : la version ${current} est maintenant en vigueur.`,
    supersededTitle: "Le plan a changé de version",
    openCurrent: "Afficher la version en vigueur",
    toEvents: "Journal des événements",
  },

  trips: {
    title: "Tournées",
    listLabel: "Liste des tournées",
    trip: (seq: number) => `Tournée ${seq}`,
    tripShort: (seq: number) => `T${seq}`,
    noDriver: "Sans chauffeur",
    stops: (n: number) => `${n} ${plural(n, "arrêt", "arrêts")}`,
    fill: "Remplissage",
    fillOf: (planned: string, capacity: string) => `${planned} sur ${capacity}`,
    schedule: (start: string, end: string) => `${start} → ${end}`,
    locked: "Verrouillée : conservée par « Recalculer en conservant »",
    lock: (seq: number) => `Verrouiller la tournée ${seq}`,
    unlock: (seq: number) => `Déverrouiller la tournée ${seq}`,
    lockShort: "Verrouiller",
    unlockShort: "Déverrouiller",
    blocking: (n: number) => `${n} ${plural(n, "violation bloquante", "violations bloquantes")}`,
    warnings: (n: number) => `${n} ${plural(n, "avertissement", "avertissements")}`,
    dropHere: "Déposer ici pour ajouter l'arrêt en fin de tournée",
    select: (seq: number) => `Afficher la tournée ${seq}`,
    stale: "Recalcul en cours…",
  },

  detail: {
    title: "Détail de la tournée",
    none: "Sélectionnez une tournée",
    noneHint:
      "Cliquez une tournée dans la liste ou un arrêt sur la carte pour afficher ses arrêts et son chargement.",
    truck: "Camion",
    driver: "Chauffeur",
    depot: "Dépôt",
    noDriverOption: "— Sans chauffeur —",
    notAssignable: (reason: string | null | undefined) => (reason ? ` — ${reason}` : " — non affectable"),
    outOfList: " — hors liste du jour",
    truckOption: (plate: string, capacity: string) => `${plate} · ${capacity}`,
    depotArrival: "Arrivée dépôt",
    depotDeparture: "Départ dépôt",
    depotReturn: "Retour dépôt",
    distance: "Distance",
    duration: "Durée",
    volume: "Volume",
    stopsTitle: "Arrêts",
    stopsHint: "Glisser la poignée, ou Alt + ↑ / ↓ sur un arrêt.",
    loadsTitle: "Plan de chargement",
    noLoads: "Aucun plan de chargement : les volumes ne tiennent pas dans les compartiments (voir RM-05).",
    loadsPending: "Plan de chargement recalculé par le serveur…",
    compartment: (position: number | null | undefined) => `C${position ?? "?"}`,
    compartmentLabel: (
      position: number | null | undefined,
      product: string,
      planned: string,
      capacity: string,
    ) => `Compartiment ${position ?? "?"} : ${product}, ${planned} sur ${capacity}`,
    emptyCompartment: "vide",
    emptyCompartmentLabel: (position: number | null | undefined, capacity: string) =>
      `Compartiment ${position ?? "?"} : vide, ${capacity}`,
    toLoading: "Chargement",
    toDeliveries: "Suivi",
    toLoadingLabel: (seq: number) => `Ouvrir le chargement de la tournée ${seq}`,
    toDeliveriesLabel: (seq: number) => `Ouvrir le suivi des livraisons de la tournée ${seq}`,
    sizes: { small: "Petit gabarit", medium: "Gabarit moyen", large: "Grand gabarit" },
  },

  stops: {
    stop: (seq: number, station: string) => `Arrêt ${seq} : ${station}`,
    handle: (station: string) =>
      `Déplacer l'arrêt ${station} (Espace pour saisir, flèches, Espace pour poser)`,
    arrival: "Arrivée",
    departure: "Départ",
    window: (arrival: string, departure: string) => `${arrival} – ${departure}`,
    fromPrevious: (distance: string) => `+ ${distance}`,
    urgent: "Urgent",
    moveMenu: (station: string) => `Déplacer l'arrêt ${station} vers une autre tournée`,
    moveTo: "Déplacer vers…",
    moveUp: "Monter d'un cran",
    moveDown: "Descendre d'un cran",
    moveToTrip: (seq: number, plate: string | null | undefined) =>
      `Tournée ${seq}${plate ? ` — ${plate}` : ""} (en fin)`,
    noOtherTrip: "Aucune autre tournée modifiable",
    notMovable: "Arrêt déjà livré ou sauté : il ne peut plus être déplacé.",
    keyboardHint: "Alt + ↑ / ↓ : déplacer l'arrêt · Entrée : sélectionner",
    insertBefore: "Insérer ici",
  },

  table: {
    caption: "Plan de tournées — vue tableau",
    seq: "N°",
    station: "Station",
    arrival: "Arrivée",
    departure: "Départ",
    deliveries: "Livraisons",
    volume: "Volume",
    distance: "Depuis préc.",
    status: "Statut",
    actions: "Actions",
    hint: "Glisser un arrêt d'une tournée à l'autre, ou Alt + ↑ / ↓ : au bord d'une tournée, l'arrêt passe à la tournée voisine.",
    returnDepot: (time: string) => `Retour dépôt ${time}`,
  },

  map: {
    label: "Carte du plan de tournées",
    depot: (code: string | null | undefined) => `Dépôt ${code ?? ""}`.trim(),
    unserved: "Commande non servie",
    stopTime: (arrival: string, departure: string) => `Arrivée ${arrival} · départ ${departure}`,
    tripLine: (seq: number, plate: string | null | undefined) =>
      `Tournée ${seq}${plate ? ` · ${plate}` : ""}`,
    legendTitle: "Tournées",
    showAll: "Toutes les tournées",
  },

  unserved: {
    title: "Commandes non servies",
    count: (n: number) => `${n} ${plural(n, "commande non servie", "commandes non servies")}`,
    urgentCount: (n: number) => `dont ${n} ${plural(n, "urgente", "urgentes")} à traiter (RM-15)`,
    urgent: "Urgente",
    postponed: "Reportée",
    cancelled: "Annulée",
    postpone: "Reporter",
    postponeLabel: (station: string) => `Reporter la commande de ${station}`,
    postponeTitle: "Reporter cette commande ?",
    postponeBody: (station: string, product: string, volume: string) =>
      `La commande ${product} ${volume} de ${station} sera marquée « reportée » : elle sort du plan du jour et ne bloque plus la publication (RM-15).`,
    postponeDone: (station: string) => `Commande de ${station} reportée`,
    postponeFailed: "Report impossible",
    expand: "Tout afficher",
    collapse: "Réduire",
    reasons: {
      no_truck: "Aucun camion disponible",
      no_driver: "Aucun chauffeur disponible",
      depot_stock: "Stock dépôt insuffisant",
      time_window: "Fenêtre horaire impossible",
      truck_size: "Aucun camion du gabarit accepté",
      compartment: "Aucun compartiment compatible",
      service_duration: "Durée de service dépassée",
      other: "Autre raison",
    },
  },

  violations: {
    title: "Violations du plan",
  },

  edit: {
    failed: "Modification refusée",
    conflictReload: "Le plan a changé entre-temps : il a été rechargé.",
    done: "Plan mis à jour.",
    newVersionTitle: (version: number) => `Nouvelle version brouillon (version ${version})`,
    newVersionBody: (published: number) =>
      `Le plan publié (version ${published}) n'a pas été modifié : vos changements sont dans ce brouillon, à publier pour qu'ils prennent effet.`,
    draftExistsTitle: "Une version brouillon existe déjà",
    draftExistsBody: (version: number | undefined) =>
      `Ce plan publié a déjà une version ${version ?? "brouillon"} en préparation. Ouvrez-la pour continuer les modifications.`,
    draftExistsAction: "Ouvrir le brouillon",
    readOnlyTitle: "Plan en lecture seule",
  },

  publish: {
    confirmTitle: "Publier ce plan ?",
    confirmBody: (trips: number, version: number) =>
      `La version ${version} (${trips} ${plural(trips, "tournée", "tournées")}) sera figée, les commandes servies passeront à « planifiée » et les feuilles de route seront disponibles.`,
    confirmWarnings: (n: number) =>
      `${n} ${plural(n, "avertissement subsiste", "avertissements subsistent")} : ils n'empêchent pas la publication.`,
    confirmUnserved: (n: number) =>
      `${n} ${plural(n, "commande reste non servie", "commandes restent non servies")}.`,
    confirmArchive: (version: number) => `La version ${version} actuellement publiée sera archivée.`,
    done: (version: number) => `Plan publié (version ${version})`,
    doneHint: "Les feuilles de route sont disponibles.",
    failed: "Publication impossible",
    blockedTitle: "Publication refusée",
    blockedRules: (codes: string) => `Règles en cause : ${codes}`,
    disabled: {
      blocking: (n: number) =>
        `Publication impossible : ${n} ${plural(n, "violation bloquante", "violations bloquantes")} à corriger.`,
      published: "Ce plan est déjà publié.",
      archived: "Version archivée : restaurez-la pour pouvoir la publier.",
      kind: "Seul un plan calculé se publie.",
    },
  },

  recompute: {
    confirmTitle: "Recalculer en conservant ?",
    confirmBody: (locked: number, free: number) =>
      locked === 0
        ? `Aucune tournée n'est verrouillée : les ${free} tournées seront toutes recalculées et vos ajustements manuels perdus.`
        : `${locked} ${plural(locked, "tournée verrouillée sera conservée", "tournées verrouillées seront conservées")} telle${locked > 1 ? "s" : ""} quelle${locked > 1 ? "s" : ""} (RM-17) ; les ${free} autres seront recalculées.`,
    confirmPublished: "Le plan étant publié, le recalcul produira une nouvelle version brouillon.",
    confirm: "Recalculer",
    running: "Recalcul en cours",
    progress: (percent: number) => `${percent} %`,
    waiting: "En attente du moteur de calcul…",
    stop: "Ne plus suivre",
    done: "Plan recalculé",
    doneNewVersion: (version: number) => `Plan recalculé : nouvelle version brouillon (version ${version})`,
    failed: "Recalcul en échec",
    startFailed: "Recalcul impossible",
  },

  versions: {
    title: "Historique des versions",
    subtitle: "Qui a changé quoi, quand. Restaurer une version crée un nouveau brouillon, à publier.",
    version: (n: number) => `Version ${n}`,
    current: "Référence",
    displayed: "Affichée",
    createdBy: (name: string | null | undefined, when: string) =>
      `Créée le ${when}${name ? ` par ${name}` : ""}`,
    publishedBy: (name: string | null | undefined, when: string) =>
      `Publiée le ${when}${name ? ` par ${name}` : ""}`,
    summary: (trips: unknown, km: string) => `${trips ?? "—"} tournées · ${km}`,
    noChanges: "Aucune modification enregistrée.",
    changes: (n: number) => `${n} ${plural(n, "modification", "modifications")}`,
    open: "Afficher",
    restore: "Restaurer",
    restoreLabel: (n: number) => `Restaurer la version ${n}`,
    openLabel: (n: number) => `Afficher la version ${n}`,
    restoreTitle: (n: number) => `Restaurer la version ${n} ?`,
    restoreBody:
      "Une nouvelle version brouillon, copie de celle-ci, sera créée et recontrôlée avec les données du moment. Elle ne prend effet qu'à sa publication.",
    restoreDraftAbandoned: (n: number) =>
      `Le brouillon en cours (version ${n}) sera abandonné (archivé, jamais supprimé).`,
    restoreConfirm: "Restaurer",
    restored: (from: number, to: number) =>
      `Version ${from} restaurée dans un nouveau brouillon (version ${to})`,
    restoreFailed: "Restauration impossible",
    unknownActor: "Système",
    types: { manual_edit: "Modification", replan: "Recalcul", publish: "Publication" } as Record<
      string,
      string
    >,
  },

  alerts: {
    blocking: (n: number) => `Plan : ${n} ${plural(n, "violation bloquante", "violations bloquantes")}`,
    urgentUnserved: (n: number) =>
      `Plan : ${n} ${plural(n, "commande urgente non servie", "commandes urgentes non servies")}`,
  },
} as const;
