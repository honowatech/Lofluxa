/**
 * Types communs. Les types de ressources (`referentials.ts`, `admin.ts`, `auth.ts`, `enums.ts`) sont des
 * alias des schémas générés depuis l'OpenAPI (`api.gen.ts`) ; le reste du code importe depuis
 * `@/lib/types` (index.ts), jamais depuis un fichier précis de ce dossier.
 */
import type { Schema } from "./schemas";

export type UUID = string;
/** Horodatage ISO 8601 en UTC, ex. `2027-01-12T06:30:00Z`. */
export type IsoDateTime = string;
/** Date `YYYY-MM-DD`. */
export type IsoDate = string;
/** Heure locale `HH:MM`. */
export type TimeHM = string;

/** Enveloppe de liste paginée (CONTRATS §7). */
export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Enveloppe d'erreur (CONTRATS §7). */
export interface ApiErrorDetail {
  rule_code?: string;
  message?: string;
  field?: string;
  type?: string;
  severity?: Severity;
  [key: string]: unknown;
}
export interface ApiErrorBody {
  code: string;
  message: string;
  details: ApiErrorDetail[];
}

export const WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];
/** Horaires d'ouverture : `{}` = ouvert en continu ; jour absent ou `[]` = fermé (voir app/core/time.py). */
export type OpeningHours = Partial<Record<WeekdayKey, [TimeHM, TimeHM][]>>;

export type Role = Schema<"Role">;
export const ROLES = ["dispatcher", "fleet", "supply", "manager", "admin"] as const satisfies readonly Role[];

export const SEVERITIES = ["blocking", "warning"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Violation d'une règle métier, telle que renvoyée dans un plan ou dans `details[]` d'une erreur. */
export interface Violation {
  rule_code: string;
  severity: Severity;
  message: string;
  trip_id?: UUID | null;
  stop_id?: UUID | null;
  order_id?: UUID | null;
}
