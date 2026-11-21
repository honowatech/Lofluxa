/** Textes de l'écran « day » (vague 2). Seul le lot propriétaire de l'écran modifie ce fichier. */
const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

export const dayTexts = {
  subtitle: (day: string) => `Préparation et suivi de la journée du ${day}`,
  readOnly: "Lecture seule : votre rôle ne permet pas de lancer le calcul du plan.",
  refresh: "Actualiser",

  summary: {
    title: "Résumé du jour",
    orders: {
      title: "Commandes",
      total: (n: number) => plural(n, "commande", "commandes"),
      none: "Aucune commande saisie pour ce jour.",
      urgentPending: (n: number) =>
        n === 1 ? "1 commande urgente en attente" : `${n} commandes urgentes en attente`,
      noUrgent: "Aucune urgente en attente",
      drafts: (n: number) => (n === 1 ? "1 brouillon à confirmer" : `${n} brouillons à confirmer`),
      open: "Ouvrir les commandes",
      confirmDrafts: "Confirmer les brouillons",
    },
    trucks: {
      title: "Camions",
      assignable: (n: number, total: number) => `${n} / ${total} affectables`,
      blocked: (n: number) => plural(n, "bloqué (RM-04)", "bloqués (RM-04)"),
      noneBlocked: "Aucun camion bloqué",
      open: "Voir les camions",
    },
    drivers: {
      title: "Chauffeurs",
      assignable: (n: number, total: number) => `${n} / ${total} affectables`,
      blocked: (n: number) => plural(n, "non affectable", "non affectables"),
      blockedRm03: (n: number) =>
        n === 1
          ? "dont 1 permis ou habilitation expiré (RM-03)"
          : `dont ${n} permis ou habilitations expirés (RM-03)`,
      noneBlocked: "Aucun chauffeur bloqué",
      withoutTruck: (n: number) =>
        n === 1 ? "1 chauffeur affectable sans camion" : `${n} chauffeurs affectables sans camion`,
      open: "Voir les chauffeurs",
    },
    stocks: {
      title: "Stocks dépôt",
      entered: (n: number, total: number) => `${n} / ${total} renseignés`,
      complete: "Tous les stocks sont renseignés",
      missing: (n: number) => plural(n, "stock manquant", "stocks manquants"),
      missingList: "Stocks non renseignés",
      more: (n: number) => (n === 1 ? "+ 1 autre" : `+ ${n} autres`),
      lastEntered: (time: string) => `Dernière saisie à ${time}`,
      neverEntered: "Aucune saisie pour ce jour",
      noDepot: "Aucun dépôt actif.",
      open: "Saisir les stocks",
      view: "Voir les stocks",
    },
  },

  compute: {
    title: "Calcul du plan",
    button: "Calculer le plan",
    again: "Recalculer un nouveau plan",
    starting: "Lancement…",
    hint: (n: number) =>
      n === 0
        ? "Aucune commande confirmée : confirmez des commandes avant de calculer."
        : n === 1
          ? "1 commande confirmée sera planifiée avec les camions, chauffeurs et stocks du jour."
          : `${n} commandes confirmées seront planifiées avec les camions, chauffeurs et stocks du jour.`,
    pending: "En attente d'un exécutant…",
    running: "Calcul en cours…",
    progress: "Progression du calcul",
    succeeded: "Calcul terminé",
    openPlan: "Ouvrir le plan",
    failed: "Le calcul a échoué",
    startFailed: "Calcul impossible",
    noOrders: "Aucune commande confirmée à planifier",
    goToOrders: "Aller aux commandes",
    dismiss: "Fermer",
    stopTracking: "Ne plus suivre ce calcul",
    stale:
      "Le calcul n'a pas démarré depuis plus de deux minutes : l'exécutant des tâches de fond ne répond peut-être pas. Le suivi reprendra dès qu'il démarre.",
    survives: "Le suivi reprend après un rafraîchissement de la page.",
    last: {
      title: "Dernier calcul",
      none: "Aucun plan calculé pour ce jour.",
      computedAt: "Calculé le",
      duration: "Durée du calcul",
      seconds: (value: string) => `${value} s`,
      engine: "Version du moteur",
      distances: "Distances",
      approximate: "Distances approchées",
      approximateHint:
        "Le serveur d'itinéraires (OSRM) n'a pas répondu : les distances et durées sont estimées à vol d'oiseau, puis corrigées.",
      exact: "Distances routières",
      by: "Lancé par",
    },
  },

  plans: {
    title: "Plans du jour",
    empty: "Aucun plan pour ce jour.",
    emptyHint: "Lancez le calcul une fois les commandes confirmées et les disponibilités vérifiées.",
    plan: "Plan",
    kinds: { computed: "Plan calculé", manual_reference: "Journée de référence", replay: "Rejeu" },
    version: (n: number) => `v${n}`,
    status: "Statut",
    computedAt: "Calculé à",
    trips: "Tournées",
    served: "Commandes servies",
    servedValue: (served: number, requested: number) => `${served} / ${requested}`,
    violations: "Violations",
    blocking: (n: number) => plural(n, "bloquante", "bloquantes"),
    warning: (n: number) => plural(n, "avertissement", "avertissements"),
    noViolation: "Aucune",
    author: "Auteur",
    open: "Ouvrir",
    openLabel: (label: string) => `Ouvrir le plan ${label}`,
    publishable: "Publiable",
  },

  alerts: {
    title: "Alertes du jour",
    none: "Aucune alerte pour ce jour.",
    count: (n: number) => plural(n, "alerte", "alertes"),
    trip: (seq: number) => `Tournée ${seq}`,
    sources: { violation: "Règle", event: "Événement", preparation: "Préparation" },
    missingStocks: (n: number) =>
      n === 1
        ? "1 stock dépôt n'est pas renseigné : le plan signalera « stock non renseigné » (RM-08)."
        : `${n} stocks dépôt ne sont pas renseignés : le plan signalera « stock non renseigné » (RM-08).`,
    urgentPending: (n: number) =>
      n === 1
        ? "1 commande urgente n'est pas encore planifiée (RM-15)."
        : `${n} commandes urgentes ne sont pas encore planifiées (RM-15).`,
    driversRm03: (n: number) =>
      n === 1
        ? "1 chauffeur n'est pas affectable : permis ou habilitation expiré (RM-03)."
        : `${n} chauffeurs ne sont pas affectables : permis ou habilitation expiré (RM-03).`,
    shellMissingStocks: (n: number) => plural(n, "stock dépôt non renseigné", "stocks dépôt non renseignés"),
    shellBlocking: (n: number) => plural(n, "alerte bloquante sur le plan", "alertes bloquantes sur le plan"),
  },
} as const;
