/**
 * Présentation des paramètres : groupe d'affichage et unité de chaque clé connue.
 * Tout le reste vient de l'API (`SettingOut`) : valeur, défaut, description, type, bornes, caractère
 * facultatif. Une clé ajoutée côté serveur apparaît donc d'elle-même, dans le groupe « Autres ».
 */
import { fr } from "@/i18n/fr";
import type { Setting, SettingType, SettingValue } from "@/lib/types";

const t = fr.administration.settings;

export type SettingGroup = keyof typeof t.groups;

export const SETTINGS_PRESENTATION: Record<string, { group: SettingGroup; unit?: string }> = {
  default_avg_speed_kmh: { group: "durations", unit: "km/h" },
  max_service_hours: { group: "durations", unit: "h" },
  default_depot_wait_min: { group: "durations", unit: "min" },
  depot_loading_time_min: { group: "durations", unit: "min" },
  default_unload_time_min: { group: "durations", unit: "min" },
  default_max_loadings_per_truck_day: { group: "durations" },
  compartment_safety_margin_pct: { group: "tolerances", unit: "%" },
  loading_tolerance_pct: { group: "tolerances", unit: "%" },
  window_tolerance_min: { group: "tolerances", unit: "min" },
  partial_delivery_min_pct: { group: "tolerances", unit: "%" },
  day_start_time: { group: "day" },
  timezone: { group: "day" },
  objective_distance_weight: { group: "objective" },
  objective_vehicle_fixed_cost_km: { group: "objective", unit: "km" },
  objective_unserved_penalty_normal_km: { group: "objective", unit: "km" },
  objective_unserved_penalty_urgent_km: { group: "objective", unit: "km" },
  solver_time_limit_s: { group: "solver", unit: "s" },
  solver_no_improvement_s: { group: "solver", unit: "s" },
  solver_seed: { group: "solver" },
  haversine_factor: { group: "solver" },
  ab_success_threshold_pct: { group: "comparison", unit: "%" },
  company_name: { group: "documents" },
  pdf_logo_url: { group: "documents" },
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

export interface SettingMeta {
  group: SettingGroup;
  unit?: string;
  type: SettingType;
  min?: number | null;
  max?: number | null;
  nullable: boolean;
}

export function metaFor(setting: Pick<Setting, "key" | "type" | "min" | "max" | "nullable">): SettingMeta {
  const presentation = SETTINGS_PRESENTATION[setting.key];
  return {
    group: presentation?.group ?? "other",
    unit: presentation?.unit,
    type: setting.type,
    min: setting.min,
    max: setting.max,
    nullable: !!setting.nullable,
  };
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Contrôle à la saisie, d'après le type et les bornes annoncés par le serveur (qui reste juge :
 * son refus éventuel s'affiche sous le champ). Renvoie un message, ou `null` si la valeur est acceptable.
 */
export function validateSetting(meta: SettingMeta, value: SettingValue): string | null {
  if (value === null || value === "") return meta.nullable ? null : t.textRequired;
  if (meta.type === "int" || meta.type === "float") {
    if (typeof value !== "number" || Number.isNaN(value)) return fr.fields.numberInvalid;
    if (meta.type === "int" && !Number.isInteger(value)) return fr.fields.integer;
    if (typeof meta.min === "number" && value < meta.min) return fr.fields.min(meta.min);
    if (typeof meta.max === "number" && value > meta.max) return fr.fields.max(meta.max);
    return null;
  }
  if (meta.type === "time")
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value)) ? null : fr.fields.timeInvalid;
  if (meta.type === "timezone") return isTimeZone(String(value)) ? null : t.timezoneInvalid;
  return null;
}
