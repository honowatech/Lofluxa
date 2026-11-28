/**
 * Rôles (spec §2) : qui voit quel écran, qui peut écrire quoi.
 * Le serveur reste seul juge (403) ; ces tables servent à ne pas proposer une action vouée à l'échec.
 * Répartition des écrans par rôle : valeur par défaut, question L9-Q4.
 *
 * Tables vérifiées contre les `require_roles(...)` des routeurs du back-end (et les `roles` des imports) :
 *   commandes, plans, comparaison, événements (réaffectation, résolution) : dispatcher
 *   stocks dépôt, déclaration de pénurie : supply · disponibilité camions / chauffeurs : dispatcher
 *   chargement, statut de tournée, livraison, envoi de la fiche : fleet et dispatcher
 *   référentiels, utilisateurs, paramètres : admin · journal d'audit (lecture) : manager et admin
 * Toutes les lectures métier sont ouvertes à tout utilisateur connecté.
 */
import type { Role } from "@/lib/types";

export const SCREEN_IDS = [
  "day",
  "orders",
  "availability",
  "plan",
  "events",
  "loading",
  "deliveries",
  "comparison",
  "referentials",
  "administration",
] as const;
export type ScreenId = (typeof SCREEN_IDS)[number];

const EVERYONE: readonly Role[] = ["dispatcher", "fleet", "supply", "manager", "admin"];

/** Rôles qui voient l'écran dans la navigation et peuvent y accéder. */
export const SCREEN_ROLES: Record<ScreenId, readonly Role[]> = {
  day: EVERYONE,
  orders: ["dispatcher", "supply", "manager", "admin"],
  availability: EVERYONE,
  plan: EVERYONE,
  // `supply` : seul rôle métier autorisé à déclarer une pénurie (F6.3).
  events: EVERYONE,
  loading: ["dispatcher", "fleet", "manager", "admin"],
  deliveries: ["dispatcher", "fleet", "manager", "admin"],
  comparison: ["dispatcher", "manager", "admin"],
  referentials: ["dispatcher", "manager", "admin"],
  // `manager` : journal d'audit en lecture seule (les autres onglets restent réservés à `admin`).
  administration: ["manager", "admin"],
};

/** Droits d'écriture (spec §2). `admin` passe partout, `manager` est en lecture seule. */
export const CAPABILITIES = {
  "orders.write": ["dispatcher"],
  "availability.stocks.write": ["supply"],
  "availability.resources.write": ["dispatcher"],
  "plan.write": ["dispatcher"],
  /** Réaffectation (panne, chauffeur indisponible) et traitement d'une pénurie. */
  "events.write": ["dispatcher"],
  /** Déclaration d'une pénurie produit (F6.3). */
  "events.shortage.write": ["supply"],
  "loading.write": ["fleet", "dispatcher"],
  "deliveries.write": ["fleet", "dispatcher"],
  "comparison.write": ["dispatcher"],
  "referentials.write": [],
  "administration.write": [],
  /** Lecture du journal d'audit (F9.3). */
  "audit.read": ["manager"],
} as const satisfies Record<string, readonly Role[]>;
export type Capability = keyof typeof CAPABILITIES;

export function canSee(role: Role | null | undefined, screen: ScreenId): boolean {
  return !!role && SCREEN_ROLES[screen].includes(role);
}

export function can(role: Role | null | undefined, capability: Capability): boolean {
  if (!role) return false;
  if (role === "admin") return true;
  return (CAPABILITIES[capability] as readonly Role[]).includes(role);
}
