/** Textes de l'écran « events » (vague 2). Seul le lot propriétaire de l'écran modifie ce fichier. */
const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);

export const eventsTexts = {
  subtitle: (day: string, count: number) => `${day} — ${count} ${plural(count, "événement", "événements")}`,
  readOnlyNotice:
    "Lecture seule : la déclaration d'un incident (panne, chauffeur indisponible, pénurie) est réservée au dispatcher.",
  feedLabel: "Fil des événements de la journée",
  refresh: "Actualiser",
  empty: {
    title: "Aucun événement ce jour",
    description:
      "Les pannes, réaffectations, pénuries, modifications du plan, publications, chargements et livraisons apparaîtront ici, dans l'ordre où ils se produisent.",
    filteredTitle: "Aucun événement pour ces filtres",
    filteredDescription: "Élargissez la sélection des types d'événements.",
    resetFilters: "Afficher tous les types",
  },

  filters: {
    label: "Filtrer par type d'événement",
    all: "Tous",
  },

  types: {
    truck_breakdown: "Panne de camion",
    driver_unavailable: "Chauffeur indisponible",
    product_shortage: "Pénurie produit",
    manual_edit: "Modification manuelle",
    publish: "Publication",
    replan: "Recalcul",
    loading_recorded: "Chargement",
    delivery_recorded: "Livraison",
  },

  feed: {
    by: (name: string) => `par ${name}`,
    system: "Système",
    trip: (seq: number | null | undefined, plate: string | null | undefined) =>
      [seq != null ? `Tournée n° ${seq}` : "Tournée", plate].filter(Boolean).join(" · "),
    planVersion: (version: number) => `Plan v${version}`,
    rm13: "Écart hors tolérance (RM-13)",
    links: {
      plan: "Voir le plan",
      newPlan: "Voir la nouvelle version",
      trip: "Suivre la tournée",
      loading: "Voir le chargement",
    },
  },

  /** Résumés construits à partir de `payload` quand le serveur ne fournit pas de phrase toute faite. */
  summary: {
    truckBreakdown: (truck: string | null, replacement: string | null) =>
      replacement
        ? `Camion ${truck ?? "de la tournée"} en panne, remplacé par ${replacement}.`
        : `Camion ${truck ?? "de la tournée"} en panne.`,
    driverUnavailable: (driver: string | null, replacement: string | null) =>
      replacement
        ? `${driver ?? "Chauffeur de la tournée"} indisponible, remplacé par ${replacement}.`
        : `${driver ?? "Chauffeur de la tournée"} indisponible.`,
    withDriver: (name: string) => `Nouveau chauffeur : ${name}.`,
    transferred: (moved: number, kept: number | null) =>
      `${moved} ${plural(moved, "arrêt transféré", "arrêts transférés")}` +
      (kept
        ? ` ; ${kept} déjà ${plural(kept, "livré reste", "livrés restent")} sur la tournée d'origine (RM-19).`
        : "."),
    shortage: (product: string | null, depot: string | null, liters: string) =>
      `Stock de ${product ?? "produit"} au dépôt ${depot ?? "—"} ramené à ${liters}.`,
    shortagePrevious: (liters: string) => `Stock précédent : ${liters}.`,
    impacted: (n: number) =>
      n === 0
        ? "Aucune tournée impactée."
        : `${n} ${plural(n, "tournée impactée", "tournées impactées")} (volume prévu supérieur au stock restant).`,
    manualEdit: "Plan modifié manuellement.",
    publish: (version: number | null) => (version != null ? `Version ${version} publiée.` : "Plan publié."),
    replan: "Plan recalculé.",
    loading: (updated: boolean, ticket: string | null) =>
      `${updated ? "Chargement corrigé" : "Chargement enregistré"}${ticket ? ` (bon n° ${ticket})` : ""}.`,
    loadingVolumes: (loaded: string, planned: string, gap: string | null) =>
      `${loaded} à 15 °C pour ${planned} planifiés${gap ? ` (${gap})` : ""}.`,
    delivered: (seq: number | null, station: string | null) =>
      `Arrêt ${seq ?? "—"}${station ? ` — ${station}` : ""} livré.`,
    deliveredVolumes: (actual: string, planned: string) => `${actual} livrés sur ${planned} prévus.`,
    skipped: (seq: number | null, station: string | null) =>
      `Arrêt ${seq ?? "—"}${station ? ` — ${station}` : ""} sauté.`,
    skipReason: (reason: string) => `Motif : ${reason}`,
  },

  actions: {
    reassign: "Assistant de réaffectation",
    shortage: "Déclarer une pénurie",
  },

  assistant: {
    title: "Assistant de réaffectation",
    description: "Panne de camion ou chauffeur indisponible sur une tournée publiée.",
    stepOf: (step: number, total: number) => `Étape ${step} sur ${total}`,
    steps: {
      kind: "Incident",
      trip: "Tournée concernée",
      replacement: "Remplaçant",
      confirm: "Confirmation",
    },
    next: "Suivant",
    previous: "Retour",
    confirm: "Confirmer la réaffectation",
    confirming: "Réaffectation…",
    kinds: {
      label: "Type d'incident",
      truck: "Camion en panne",
      truckHint: "Les arrêts non livrés passent sur un camion de remplacement (et son chauffeur, au besoin).",
      driver: "Chauffeur indisponible",
      driverHint: "La tournée garde son camion ; un autre chauffeur la reprend.",
    },
    trips: {
      label: "Tournée concernée",
      loadingPlans: "Chargement des tournées publiées…",
      none: "Aucun plan publié ce jour : il n'y a aucune tournée à réaffecter.",
      nonePending: "aucun arrêt à transférer",
      option: (seq: number, plate: string | null, driver: string | null) =>
        `Tournée n° ${seq} — ${plate ?? "camion ?"} — ${driver ?? "sans chauffeur"}`,
      stops: (pending: number, total: number) =>
        `${pending} ${plural(pending, "arrêt", "arrêts")} à livrer sur ${total}`,
    },
    rm19: {
      title: "RM-19 — seuls les arrêts « à livrer » sont transférés",
      toTransfer: (n: number) => `${plural(n, "Arrêt transféré", "Arrêts transférés")} (${n})`,
      kept: (n: number) =>
        `${plural(n, "Arrêt déjà traité, conservé", "Arrêts déjà traités, conservés")} sur la tournée d'origine (${n})`,
      noneKept: "Aucun arrêt n'a encore été livré : toute la tournée est transférée.",
    },
    replacement: {
      truckLabel: "Camion de remplacement",
      driverLabel: "Chauffeur de remplacement",
      driverOptional: "Chauffeur",
      keepDriver: (name: string | null) => `Conserver le chauffeur actuel${name ? ` (${name})` : ""}`,
      loading: "Recherche des remplaçants disponibles…",
      noTruck: "Aucun camion de remplacement disponible pour cette tournée.",
      noDriver: "Aucun chauffeur de remplacement disponible pour cette tournée.",
      capacity: (liters: string) => `Capacité ${liters}`,
      unsuitable: "Non affectable",
    },
    recap: {
      title: "Récapitulatif",
      incident: "Incident",
      trip: "Tournée",
      currentTruck: "Camion en panne",
      currentDriver: "Chauffeur indisponible",
      newTruck: "Camion de remplacement",
      newDriver: "Chauffeur de remplacement",
      unchangedDriver: "Inchangé",
      stops: "Arrêts transférés",
      effect:
        "La réaffectation crée une nouvelle version du plan, la recalcule et inscrit l'événement au journal.",
    },
    done: {
      title: "Réaffectation enregistrée",
      newVersion: (version: number | null) =>
        version != null
          ? `Une nouvelle version du plan (v${version}) a été créée.`
          : "Une nouvelle version du plan a été créée.",
      transferred: (n: number) => `${n} ${plural(n, "arrêt transféré", "arrêts transférés")}.`,
      openPlan: "Ouvrir la nouvelle version du plan",
      toast: "Réaffectation enregistrée",
    },
    failed: "Réaffectation refusée",
    conflictHint:
      "Le serveur a refusé la réaffectation : la tournée ou le remplaçant a changé d'état, ou une règle métier s'y oppose. Corrigez le choix puis réessayez.",
  },

  shortage: {
    title: "Déclarer une pénurie produit",
    description:
      "Mettez à jour le stock disponible au dépôt : les tournées dont le volume prévu dépasse le stock restant sont signalées.",
    depot: "Dépôt",
    product: "Produit",
    choose: "Choisir…",
    newStock: "Nouveau stock disponible",
    newStockHint: "En litres. Saisir un stock revenu à la normale lève l'alerte (aucune tournée impactée).",
    submit: "Déclarer",
    submitting: "Déclaration…",
    failed: "Déclaration refusée",
    required: "Dépôt, produit et stock sont obligatoires.",
    done: {
      title: "Stock mis à jour",
      toast: "Pénurie déclarée",
      stock: (product: string, depot: string, liters: string) =>
        `${product} au dépôt ${depot} : ${liters} disponibles.`,
      none: "Aucune tournée impactée : le stock restant couvre les volumes prévus.",
      impactedTitle: (n: number) =>
        `${n} ${plural(n, "tournée impactée", "tournées impactées")} — volume prévu supérieur au stock restant`,
      planned: "Prévu",
      shortfall: "Manque",
      choicesHint:
        "Pour chaque tournée, le dispatcher choisit : réduire les volumes, reporter des commandes, ou changer de dépôt.",
      reduce: "Réduire",
      postpone: "Reporter",
      changeDepot: "Changer de dépôt",
      another: "Déclarer une autre pénurie",
    },
  },
} as const;
