/** Textes de l'écran « orders » (vague 2). Seul le lot propriétaire de l'écran modifie ce fichier. */
const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

export const ordersTexts = {
  subtitle: (day: string) => `Commandes à livrer le ${day}`,
  readOnly: "Lecture seule : votre rôle ne permet pas de modifier les commandes.",
  caption: "Commandes du jour",
  empty: "Aucune commande pour ce jour.",
  emptyHint: "Saisissez une commande ou importez le fichier du jour.",
  searchPlaceholder: "Station, produit, commentaire…",

  columns: {
    station: "Station",
    product: "Produit",
    volume: "Volume demandé",
    priority: "Priorité",
    windowStart: "Fenêtre début",
    windowEnd: "Fenêtre fin",
    window: "Fenêtre de livraison",
    comment: "Commentaire",
    status: "Statut",
    source: "Origine",
  },
  sources: { manual: "Saisie", import: "Import" },
  volumePositive: "Le volume doit être supérieur à 0",

  actions: {
    new: "Nouvelle commande",
    import: "Importer",
    edit: "Modifier",
    details: "Détails",
    confirm: "Confirmer",
    cancel: "Annuler la commande",
    postpone: "Reporter",
    delete: "Supprimer",
    confirmSelection: "Confirmer",
    deleteDrafts: "Supprimer les brouillons",
    confirmAllDrafts: (n: number) => `Confirmer les brouillons (${n})`,
    rowLabel: (label: string) => `Actions — ${label}`,
  },

  form: {
    newTitle: "Nouvelle commande",
    editTitle: "Modifier la commande",
    viewTitle: "Commande",
    station: "Station",
    product: "Produit",
    volume: "Volume demandé",
    priority: "Priorité",
    windowSection: "Fenêtre de livraison souhaitée",
    windowStart: "Au plus tôt",
    windowEnd: "Au plus tard",
    windowHint: "Heure de Douala. Une seule borne suffit ; vide = pas de contrainte.",
    comment: "Commentaire",
    orderSection: "Commande",
    tank: (capacity: string, safety: string) =>
      `Cuve de la station : ${capacity}, stock de sécurité ${safety}.`,
    tankUnknown:
      "Cuve non renseignée pour cette station et ce produit : le volume ne pourra pas être contrôlé à la confirmation.",
    notEditable: (status: string) =>
      `Commande « ${status} » : seules les commandes en brouillon ou confirmées sont modifiables.`,
  },

  label: (station: string, product: string, volume: string) => `${station} · ${product} · ${volume}`,

  notify: {
    created: "Commande créée en brouillon",
    updated: "Commande modifiée",
    deleted: "Commande supprimée",
    deletedMany: (n: number) => plural(n, "brouillon supprimé", "brouillons supprimés"),
    confirmed: "Commande confirmée",
    confirmedWithWarnings: "Commande confirmée avec avertissement",
    cancelled: "Commande annulée",
    postponed: "Commande reportée",
    warning: "Avertissement sur la commande",
    confirmFailed: "Confirmation impossible",
    cancelFailed: "Annulation impossible",
    postponeFailed: "Report impossible",
    noDraftSelected: "Aucun brouillon dans la sélection",
    noDraftSelectedHint: "Seules les commandes en brouillon peuvent être confirmées ou supprimées.",
    imported: "Import appliqué : commandes ajoutées en brouillon",
  },

  confirm: {
    cancelTitle: "Annuler la commande ?",
    cancelBody: (label: string) =>
      `La commande « ${label} » passera au statut « Annulée ». Ce statut est définitif : il faudra la ressaisir pour la livrer.`,
    cancelAction: "Annuler la commande",
    postponeTitle: "Reporter la commande ?",
    postponeBody: (label: string) =>
      `La commande « ${label} » passera au statut « Reportée » et ne sera pas planifiée ce jour. Ce statut est définitif : ressaisissez-la pour le nouveau jour.`,
    postponeAction: "Reporter",
    keep: "Ne rien changer",
    deleteBody: (label: string) => `Le brouillon « ${label} » sera supprimé définitivement.`,
    deleteDraftsTitle: "Supprimer les brouillons ?",
    deleteDraftsBody: (n: number, ignored: number) =>
      `${plural(n, "brouillon sera supprimé", "brouillons seront supprimés")} définitivement.` +
      (ignored > 0
        ? ` ${plural(ignored, "commande déjà confirmée ou traitée est ignorée", "commandes déjà confirmées ou traitées sont ignorées")}.`
        : ""),
    confirmAllTitle: "Confirmer tous les brouillons ?",
    confirmAllBody: (n: number) =>
      `${plural(n, "brouillon affiché sera confirmé", "brouillons affichés seront confirmés")}. Le volume de chaque commande est contrôlé par rapport à la cuve de la station ; le résultat est donné commande par commande.`,
    confirmAllAction: "Confirmer",
  },

  refusal: {
    title: "Confirmation refusée",
    updateTitle: "Modification refusée",
    max: (volume: string) => `Volume maximal recevable : ${volume}.`,
    hint: "Réduisez le volume demandé, ou corrigez la cuve de la station dans les référentiels.",
    edit: "Corriger la commande",
    dismiss: "Fermer",
  },

  warnings: {
    one: "Avertissement",
    count: (n: number) => plural(n, "avertissement", "avertissements"),
    exceedingBanner: (n: number) =>
      n === 1
        ? "1 commande dépasse le volume recevable par la cuve de sa station : sa confirmation sera refusée tant que le volume n'est pas réduit."
        : `${n} commandes dépassent le volume recevable par la cuve de leur station : leur confirmation sera refusée tant que le volume n'est pas réduit.`,
    refused: "Confirmation impossible",
    banner: (n: number) =>
      n === 1
        ? "1 commande avec avertissement : cuve non renseignée, volume non contrôlé."
        : `${n} commandes avec avertissement : cuve non renseignée, volume non contrôlé.`,
  },

  bulk: {
    title: "Résultat de la confirmation",
    summary: (confirmed: number, failed: number) =>
      `${plural(confirmed, "commande confirmée", "commandes confirmées")}, ${plural(failed, "refusée", "refusées")}.`,
    ignored: (n: number) =>
      plural(
        n,
        "commande ignorée (déjà confirmée ou traitée)",
        "commandes ignorées (déjà confirmées ou traitées)",
      ),
    order: "Commande",
    result: "Résultat",
    detail: "Détail",
    ok: "Confirmée",
    okWithWarning: "Confirmée, avec avertissement",
    refused: "Refusée",
    unknownOrder: "Commande",
    close: "Fermer",
    failed: "Confirmation en masse impossible",
    done: (confirmed: number) => plural(confirmed, "commande confirmée", "commandes confirmées"),
  },

  totals: {
    title: "Totaux des commandes affichées",
    byProduct: "Par produit",
    byStatus: "Par statut",
    total: "Total",
    count: (n: number) => plural(n, "commande", "commandes"),
    none: "Aucune commande",
  },

  filters: {
    station: "Station",
    product: "Produit",
    status: "Statut",
    priority: "Priorité",
  },
} as const;
