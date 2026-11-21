/** Textes de l'écran « events » (vague 2). Seul le lot propriétaire de l'écran modifie ce fichier. */
const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);

export const eventsTexts = {
  subtitle: (day: string, count: number) => `${day} — ${count} ${plural(count, "événement", "événements")}`,
  readOnlyNotice:
    "Lecture seule : la réaffectation et le traitement d'une pénurie sont réservés au dispatcher, la déclaration d'une pénurie à Supply.",
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
    manual_edit: "Modification du plan",
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
    reason: (text: string) => `Motif : ${text}`,
    comment: (text: string) => `Commentaire : ${text}`,
    shortageStatus: { open: "À traiter", resolved: "Résolue", no_impact: "Sans impact" },
    resolve: "Traiter la pénurie",
    viewImpact: "Voir l'impact",
    links: {
      plan: "Voir le plan",
      trip: "Suivre la tournée",
      loading: "Voir le chargement",
    },
  },

  actions: {
    reassign: "Assistant de réaffectation",
    shortage: "Déclarer une pénurie",
  },

  /** Phrases communes aux écrans de fin (réaffectation, résolution). */
  planResult: {
    published: (version: number) => `Version ${version} du plan publiée.`,
    draftBlocked: (version: number, blocking: number) =>
      `Version ${version} du plan laissée en brouillon : ${blocking} ${plural(blocking, "violation bloquante", "violations bloquantes")} à corriger avant publication. La version publiée précédente reste la référence du terrain.`,
    draft: (version: number) =>
      `Version ${version} du plan en brouillon (un brouillon était déjà en préparation) : à publier depuis l'écran du plan.`,
    openPlan: (version: number) => `Ouvrir le plan (v${version})`,
    violationsTitle: "Violations de la nouvelle version",
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
      truckHint:
        "Les arrêts non livrés passent sur une nouvelle tournée du camion de remplacement, à recharger au dépôt.",
      driver: "Chauffeur indisponible",
      driverHint: "La tournée garde son camion et son chargement ; un autre chauffeur la reprend.",
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
      checking: "Vérification de la tournée…",
      draftInProgress: (version: number) =>
        `Une version ${version} du plan est déjà en préparation : la réaffectation s'y ajoutera, sans publication automatique.`,
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
      driverForTruck: (plate: string) => `Chauffeur de la tournée de remplacement (${plate})`,
      driverRequired: "Ce camion n'a pas de chauffeur pour la journée : choisissez un chauffeur.",
      defaultDriver: (name: string | null) =>
        name ? `Chauffeur proposé : ${name}` : "Chauffeur proposé par le serveur",
      defaultDriverHint: "Chauffeur affecté au camion pour la journée, sinon celui de la tournée d'origine.",
      loading: "Recherche des remplaçants disponibles…",
      evaluating: "Évaluation des chauffeurs pour ce camion…",
      noTruck: "Aucun camion de remplacement n'est connu pour cette tournée.",
      noDriver: "Aucun chauffeur de remplacement n'est connu pour cette tournée.",
      capacity: (liters: string) => `Capacité ${liters}`,
      assignedDriver: (name: string) => `Chauffeur du jour : ${name}`,
      assignedTruck: (plate: string) => `Camion du jour : ${plate}`,
      otherTrips: (seqs: number[]) =>
        `Déjà sur ${plural(seqs.length, "la tournée", "les tournées")} n° ${seqs.join(", ")}`,
      ineligible: "Non éligible",
    },
    reason: "Motif",
    reasonPlaceholder: "Ex. : crevaison sur l'axe Ndokoti",
    recap: {
      title: "Récapitulatif",
      incident: "Incident",
      trip: "Tournée",
      currentTruck: "Camion en panne",
      currentDriver: "Chauffeur indisponible",
      newTruck: "Camion de remplacement",
      newDriver: "Chauffeur de remplacement",
      stops: "Arrêts à reprendre",
      effect:
        "La réaffectation crée une nouvelle version du plan, la recontrôle et inscrit l'événement au journal. Sans violation bloquante, elle est publiée aussitôt.",
    },
    done: {
      title: "Réaffectation enregistrée",
      transferred: (moved: number, kept: number) =>
        `${moved} ${plural(moved, "arrêt transféré", "arrêts transférés")}` +
        (kept > 0
          ? `, ${kept} ${plural(kept, "conservé", "conservés")} sur la tournée d'origine (RM-19).`
          : "."),
      otherTrips: (seqs: number[]) =>
        `${plural(seqs.length, "Une autre tournée", "D'autres tournées")} du jour ${plural(seqs.length, "utilise", "utilisent")} encore la ressource indisponible (n° ${seqs.join(", ")}) : déclarez l'incident pour ${plural(seqs.length, "elle", "chacune")} ou réaffectez dans l'écran du plan.`,
      toast: "Réaffectation enregistrée",
    },
    failed: "Réaffectation refusée",
    conflictHint:
      "Le serveur a refusé la réaffectation : la tournée ou le remplaçant a changé d'état, ou une règle métier s'y oppose. Corrigez le choix puis réessayez.",
  },

  shortage: {
    title: "Déclarer une pénurie produit",
    description:
      "Supply met à jour le stock du jour d'un produit au dépôt : les tournées que le stock restant ne couvre plus sont signalées au dispatcher.",
    depot: "Dépôt",
    product: "Produit",
    choose: "Choisir…",
    newStock: "Nouveau stock disponible",
    newStockHint:
      "Stock total du jour, en litres, y compris ce qui est déjà chargé. Il ne peut pas être inférieur au volume déjà chargé.",
    submit: "Déclarer",
    submitting: "Déclaration…",
    failed: "Déclaration refusée",
    required: "Dépôt, produit et stock sont obligatoires.",
    done: {
      title: "Stock mis à jour",
      toast: "Pénurie déclarée",
      none: "Aucune tournée impactée : le stock restant couvre les volumes encore à charger.",
      toResolve:
        "Le dispatcher doit maintenant réduire, reporter ou changer de dépôt pour chaque tournée impactée.",
      another: "Déclarer une autre pénurie",
    },
  },

  impact: {
    title: "Pénurie produit — tournées impactées",
    stock: (product: string, depot: string) => `${product} au dépôt ${depot}`,
    figures: {
      available: "Stock du jour",
      loaded: "Déjà chargé",
      remaining: "Reste",
      toLoad: "Encore à charger",
      shortfall: "Manque",
    },
    status: { open: "À traiter", resolved: "Résolue", no_impact: "Sans impact" },
    impactedTitle: (n: number) => `${n} ${plural(n, "tournée impactée", "tournées impactées")}`,
    none: "Plus aucune tournée n'est impactée par cette pénurie.",
    planned: "Prévu",
    covered: "Couvert",
    shortfall: "Manque",
    orders: (n: number) => `${n} ${plural(n, "commande", "commandes")} du produit`,
    decision: (seq: number) => `Décision pour la tournée n° ${seq}`,
    later: "Ne pas traiter maintenant",
    actions: {
      reduce: "Réduire au volume couvert",
      postpone: "Reporter les commandes du produit",
      change_depot: "Changer de dépôt",
    },
    actionHints: {
      reduce:
        "Réduction proportionnelle de toutes les livraisons du produit ; le reliquat redevient à planifier.",
      postpone: "Toutes les commandes du produit de la tournée passent « reportée », dès la décision.",
      change_depot:
        "Toute la tournée charge au nouveau dépôt (RM-01) ; horaires et stock y sont recontrôlés.",
    },
    newDepot: (seq: number) => `Nouveau dépôt pour la tournée n° ${seq}`,
    depotOption: (code: string, name: string, remaining: string | null, sufficient: boolean | null) =>
      `${code} — ${name}` +
      (remaining !== null ? ` · reste ${remaining}` : " · stock non renseigné") +
      (sufficient === true ? " · suffisant" : sufficient === false ? " · insuffisant" : ""),
    insufficientDepot:
      "Le stock de ce dépôt ne couvre pas la tournée : la nouvelle version restera bloquée (RM-08).",
    noAlternative: "Aucun autre dépôt actif.",
    alreadyDecided: (text: string) => `Décision enregistrée : ${text}`,
    nothingChosen: "Choisissez une décision pour au moins une tournée.",
    depotRequired: "Choisissez le nouveau dépôt.",
    submit: "Appliquer les décisions",
    submitting: "Application…",
    failed: "Décisions refusées",
    readOnly: "Le traitement d'une pénurie est réservé au dispatcher.",
    done: {
      title: "Décisions appliquées",
      toast: "Pénurie traitée",
      resolved: "La pénurie est résolue : plus aucune tournée n'est impactée.",
      stillOpen: (n: number) =>
        `${n} ${plural(n, "tournée reste impactée", "tournées restent impactées")} : poursuivez le traitement.`,
      continue: "Traiter les tournées restantes",
    },
  },
} as const;
