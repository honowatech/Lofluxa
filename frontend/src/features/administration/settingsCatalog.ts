/**
 * Catalogue des paramètres connus (miroir de `settings_store.DEFAULTS`) : type, bornes de saisie, groupe.
 * La valeur par défaut et la description affichées viennent de l'API quand elle les fournit ;
 * celles d'ici ne servent que de repli. Une clé inconnue reste modifiable (saisie libre).
 */
import { fr } from "@/i18n/fr";
import type { SettingValue } from "@/lib/types";

const t = fr.administration.settings;

export type SettingGroup = keyof typeof t.groups;
export type SettingType = "number" | "integer" | "time" | "text" | "timezone";

export interface SettingMeta {
  group: SettingGroup;
  type: SettingType;
  unit?: string;
  min?: number;
  max?: number;
  /** Peut être vide (`null`). */
  nullable?: boolean;
  fallbackDefault: SettingValue;
  fallbackDescription: string;
}

export const SETTINGS_CATALOG: Record<string, SettingMeta> = {
  default_avg_speed_kmh: {
    group: "durations",
    type: "number",
    unit: "km/h",
    min: 5,
    max: 120,
    fallbackDefault: 40,
    fallbackDescription: "Vitesse moyenne par défaut des camions (km/h)",
  },
  max_service_hours: {
    group: "durations",
    type: "number",
    unit: "h",
    min: 1,
    max: 24,
    fallbackDefault: 11,
    fallbackDescription: "Durée maximale de service d'un chauffeur par jour (heures) — RM-11",
  },
  default_depot_wait_min: {
    group: "durations",
    type: "integer",
    unit: "min",
    min: 0,
    max: 600,
    fallbackDefault: 90,
    fallbackDescription: "Temps d'attente moyen au dépôt avant chargement (minutes)",
  },
  depot_loading_time_min: {
    group: "durations",
    type: "integer",
    unit: "min",
    min: 0,
    max: 600,
    fallbackDefault: 45,
    fallbackDescription: "Durée d'un chargement au dépôt (minutes)",
  },
  default_unload_time_min: {
    group: "durations",
    type: "integer",
    unit: "min",
    min: 0,
    max: 600,
    fallbackDefault: 45,
    fallbackDescription: "Temps de dépotage par défaut en station (minutes)",
  },
  default_max_loadings_per_truck_day: {
    group: "durations",
    type: "integer",
    min: 1,
    max: 10,
    fallbackDefault: 2,
    fallbackDescription: "Nombre max de chargements par camion et par jour — RM-14",
  },
  compartment_safety_margin_pct: {
    group: "tolerances",
    type: "number",
    unit: "%",
    min: 0,
    max: 50,
    fallbackDefault: 2,
    fallbackDescription: "Marge de sécurité sur la capacité des compartiments (%) — RM-05",
  },
  loading_tolerance_pct: {
    group: "tolerances",
    type: "number",
    unit: "%",
    min: 0,
    max: 50,
    fallbackDefault: 2,
    fallbackDescription: "Tolérance d'écart volume chargé / planifié (%) — RM-13",
  },
  window_tolerance_min: {
    group: "tolerances",
    type: "integer",
    unit: "min",
    min: 0,
    max: 600,
    fallbackDefault: 30,
    fallbackDescription: "Dépassement de fenêtre toléré en avertissement (minutes) — RM-10",
  },
  partial_delivery_min_pct: {
    group: "tolerances",
    type: "number",
    unit: "%",
    min: 0,
    max: 100,
    fallbackDefault: 50,
    fallbackDescription: "Part minimale livrable d'une commande (%) — RM-16",
  },
  day_start_time: {
    group: "day",
    type: "time",
    fallbackDefault: "06:00",
    fallbackDescription: "Heure de début de journée (heure locale)",
  },
  timezone: {
    group: "day",
    type: "timezone",
    fallbackDefault: "Africa/Douala",
    fallbackDescription: "Fuseau horaire d'affichage",
  },
  objective_distance_weight: {
    group: "objective",
    type: "number",
    min: 0,
    max: 1000,
    fallbackDefault: 1,
    fallbackDescription: "Objectif : poids de la distance totale",
  },
  objective_vehicle_fixed_cost_km: {
    group: "objective",
    type: "number",
    unit: "km",
    min: 0,
    max: 100000,
    fallbackDefault: 40,
    fallbackDescription: "Objectif : coût fixe par véhicule utilisé (km équivalents)",
  },
  objective_unserved_penalty_normal_km: {
    group: "objective",
    type: "number",
    unit: "km",
    min: 0,
    max: 1000000,
    fallbackDefault: 500,
    fallbackDescription: "Objectif : pénalité commande normale non servie (km)",
  },
  objective_unserved_penalty_urgent_km: {
    group: "objective",
    type: "number",
    unit: "km",
    min: 0,
    max: 1000000,
    fallbackDefault: 5000,
    fallbackDescription: "Objectif : pénalité commande urgente non servie (km)",
  },
  solver_time_limit_s: {
    group: "solver",
    type: "integer",
    unit: "s",
    min: 1,
    max: 600,
    fallbackDefault: 45,
    fallbackDescription: "Limite de temps du solveur (secondes)",
  },
  solver_no_improvement_s: {
    group: "solver",
    type: "integer",
    unit: "s",
    min: 1,
    max: 600,
    fallbackDefault: 10,
    fallbackDescription: "Arrêt anticipé du solveur sans amélioration (secondes)",
  },
  solver_seed: {
    group: "solver",
    type: "integer",
    min: 0,
    max: 2147483647,
    fallbackDefault: 42,
    fallbackDescription: "Graine du solveur (reproductibilité)",
  },
  haversine_factor: {
    group: "solver",
    type: "number",
    min: 1,
    max: 3,
    fallbackDefault: 1.3,
    fallbackDescription: "Coefficient appliqué à la distance à vol d'oiseau si OSRM est indisponible",
  },
  ab_success_threshold_pct: {
    group: "comparison",
    type: "number",
    unit: "%",
    min: 0,
    max: 100,
    fallbackDefault: 10,
    fallbackDescription: "Seuil de réussite du test A/B : gain kilométrique minimal (%)",
  },
  company_name: {
    group: "documents",
    type: "text",
    fallbackDefault: "OLA Energy Cameroun",
    fallbackDescription: "Nom affiché en en-tête des documents PDF",
  },
  pdf_logo_url: {
    group: "documents",
    type: "text",
    nullable: true,
    fallbackDefault: null,
    fallbackDescription: "Logo des documents PDF (URL ou chemin de fichier ; vide = nom en texte)",
  },
};

export const GROUP_ORDER: SettingGroup[] = [
  "durations",
  "tolerances",
  "day",
  "objective",
  "solver",
  "comparison",
  "documents",
  "other",
];

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Type d'une clé absente du catalogue, déduit de sa valeur. */
export function metaFor(key: string, value: SettingValue): SettingMeta {
  return (
    SETTINGS_CATALOG[key] ?? {
      group: "other",
      type: typeof value === "number" ? "number" : "text",
      nullable: true,
      fallbackDefault: null,
      fallbackDescription: t.unknownKey,
    }
  );
}

/** Message d'erreur pour une valeur saisie, ou `null` si elle est acceptable. */
export function validateSetting(meta: SettingMeta, value: SettingValue): string | null {
  if (value === null || value === "") return meta.nullable ? null : t.textRequired;
  if (meta.type === "number" || meta.type === "integer") {
    if (typeof value !== "number" || Number.isNaN(value)) return fr.fields.numberInvalid;
    if (meta.type === "integer" && !Number.isInteger(value)) return fr.fields.integer;
    if (meta.min !== undefined && value < meta.min) return fr.fields.min(meta.min);
    if (meta.max !== undefined && value > meta.max) return fr.fields.max(meta.max);
    return null;
  }
  if (meta.type === "time")
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value)) ? null : fr.fields.timeInvalid;
  if (meta.type === "timezone") return isTimeZone(String(value)) ? null : t.timezoneInvalid;
  return null;
}
