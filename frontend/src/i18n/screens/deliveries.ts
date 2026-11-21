/** Textes de l'écran « deliveries » (vague 2). Seul le lot propriétaire de l'écran modifie ce fichier. */
export const deliveriesTexts = {
  subtitle:
    "Réalisations par tournée du plan publié : heures réelles, volumes livrés, arrêts sautés, clôture.",
  readOnly: "Lecture seule : la saisie des livraisons est réservée aux rôles Dispatcher et Fleet.",

  filters: {
    status: "Statut de la tournée",
    all: "Toutes",
  },

  list: {
    title: "Tournées du plan publié",
    trip: (seq: number) => `Tournée ${seq}`,
    noDriver: "Chauffeur non affecté",
    progress: (done: number, total: number) => `${done} / ${total} arrêt${total > 1 ? "s" : ""}`,
    progressLabel: (done: number, total: number) =>
      `${done} arrêt${done > 1 ? "s" : ""} traité${done > 1 ? "s" : ""} sur ${total}`,
    count: (shown: number, total: number) =>
      shown === total
        ? `${total} tournée${total > 1 ? "s" : ""}`
        : `${shown} sur ${total} tournée${total > 1 ? "s" : ""}`,
    emptyTitle: "Aucune tournée publiée ce jour",
    emptyHint: "Le suivi commence dès que le plan du jour est publié.",
    emptyFiltered: "Aucune tournée ne correspond au filtre.",
    selectHint: "Sélectionnez une tournée pour suivre ses livraisons.",
  },

  delay: {
    late: (duration: string) => `Retard ${duration}`,
    early: (duration: string) => `Avance ${duration}`,
    onTime: "À l'heure",
    overdue: (duration: string) => `Attendu depuis ${duration}`,
    label: "Écart sur l'horaire prévu",
  },

  trip: {
    depot: "Dépôt",
    plannedDepart: "Départ prévu",
    actualDepart: "Départ réel",
    plannedReturn: "Retour prévu",
    actualReturn: "Retour réel",
    distance: "Distance prévue",
    actualDistance: "Distance réelle",
    progress: "Avancement",
    delivered: (liters: string, planned: string) => `${liters} livrés sur ${planned} prévus`,
    routeSheet: "Feuille de route",
    toLoading: "Ouvrir le chargement",
  },

  /** Pourquoi la saisie n'est pas (ou plus) possible, selon le statut de la tournée. */
  gate: {
    planned:
      "La tournée n'a pas encore quitté le dépôt : une livraison ne se saisit que sur une tournée « En cours ». Les étapes arrivée au dépôt, chargement et départ se font dans l'écran Chargement.",
    at_depot:
      "Le camion est au dépôt : une livraison ne se saisit que sur une tournée « En cours ». Enregistrez le chargement puis le départ dans l'écran Chargement.",
    loaded:
      "Le camion est chargé mais pas encore parti : enregistrez le départ du dépôt dans l'écran Chargement pour saisir les livraisons.",
    completed: "Tournée terminée : les heures, volumes et kilomètres réels ne sont plus modifiables.",
  } as Record<string, string>,

  stop: {
    title: (seq: number, name: string) => `Arrêt ${seq} — ${name}`,
    planned: "Prévu",
    plannedWindow: (arrival: string, departure: string) => `${arrival} → ${departure}`,
    actual: "Réel",
    arrival: "Arrivée réelle",
    departure: "Départ réel",
    arrivalFor: (seq: number) => `Arrivée réelle, arrêt ${seq}`,
    departureFor: (seq: number) => `Départ réel, arrêt ${seq}`,
    now: "Maintenant",
    nowFor: (label: string) => `Heure actuelle : ${label}`,
    volumes: "Volumes livrés",
    volumeFor: (product: string, seq: number) => `Volume livré ${product}, arrêt ${seq}`,
    plannedVolume: (liters: string) => `prévu ${liters}`,
    litersUnit: "L",
    zeroHint: "0 L : la commande repart à replanifier.",
    save: "Enregistrer la livraison",
    update: "Corriger la livraison",
    edit: "Corriger",
    open: "Saisir la livraison",
    skip: "Arrêt sauté…",
    skipTitle: "Arrêt sauté",
    skipReason: "Motif (obligatoire)",
    skipReasonFor: (seq: number) => `Motif de l'arrêt sauté, arrêt ${seq}`,
    skipPlaceholder: "Station fermée, cuve pleine, accès impossible…",
    skipConfirm: "Confirmer l'arrêt sauté",
    skipWarning: "Non réversible : les commandes de l'arrêt repartent à replanifier.",
    skippedBecause: (reason: string) => `Motif : ${reason}`,
    skippedLocked:
      "Arrêt sauté : non réversible. Ses commandes sont reparties à replanifier (statut « Confirmée »).",
    deliveredLocked:
      "Livraison enregistrée : les heures et volumes restent corrigeables tant que la tournée est en cours, mais l'arrêt ne peut plus être marqué « sauté ».",
    saved: (seq: number) => `Livraison de l'arrêt ${seq} enregistrée`,
    skipped: (seq: number) => `Arrêt ${seq} marqué comme sauté`,
    failed: "Saisie refusée",
    orderStatus: "Commande",
  },

  validation: {
    arrival: "Heure d'arrivée réelle obligatoire (HH:mm).",
    time: "Heure invalide (HH:mm).",
    order: "Le départ ne peut pas précéder l'arrivée.",
    volume: "Volume livré obligatoire pour chaque commande (nombre ≥ 0).",
    reason: "Le motif est obligatoire pour un arrêt sauté.",
    distance: "Kilométrage invalide (nombre ≥ 0).",
  },

  close: {
    title: "Clôture de la tournée",
    returnAt: "Heure de retour au dépôt",
    returnHint: "Vide : heure de l'enregistrement.",
    distance: "Kilomètres réels",
    distanceUnit: "km",
    distanceHint: (planned: string) => `Prévu : ${planned}`,
    submit: "Clôturer la tournée",
    pending: (n: number) =>
      `Clôture impossible : ${n} arrêt${n > 1 ? "s" : ""} ni livré${n > 1 ? "s" : ""} ni sauté${n > 1 ? "s" : ""}.`,
    ready: "Tous les arrêts sont traités : la tournée peut être clôturée.",
    confirmTitle: "Clôturer la tournée ?",
    confirmDescription:
      "Une fois terminée, la tournée n'est plus modifiable (heures, volumes et kilomètres réels).",
    done: (seq: number) => `Tournée ${seq} terminée`,
    failed: "Clôture refusée",
  },

  /** Explication des refus de l'API, par code d'erreur. */
  errors: {
    trip_not_in_progress: "Une livraison se saisit uniquement sur une tournée « En cours ».",
    invalid_order_transition:
      "Changement impossible : une commande déjà livrée est définitive (livré ↔ sauté n'est pas réversible).",
    invalid_deliveries: "Les volumes livrés doivent couvrir exactement les commandes de l'arrêt.",
    stops_pending: "La tournée ne peut pas être terminée : des arrêts ne sont ni livrés ni sautés.",
    invalid_transition:
      "Cette étape n'est plus possible : la tournée a déjà changé de statut. La page a été rechargée.",
    invalid_times: "Heures incohérentes : le retour ne peut pas précéder le départ du dépôt.",
    plan_not_published: "Le plan de cette tournée n'est plus publié (nouvelle version en cours ou archivée).",
    forbidden: "Votre rôle ne permet pas cette action.",
  } as Record<string, string>,
} as const;
