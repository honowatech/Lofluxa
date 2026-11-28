/**
 * Mise en forme des valeurs affichées. L'API transporte des unités brutes
 * (litres, mètres, secondes, horodatages UTC) : toute conversion pour l'affichage passe par ici.
 * Les heures sont toujours affichées en `HH:mm`, fuseau Africa/Douala (RM-20).
 */
import { addDays as addDaysFn, differenceInCalendarDays, isValid, parseISO } from "date-fns";
import { fr as frLocale } from "date-fns/locale";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import { APP_TIMEZONE } from "@/lib/config";
import type { IsoDate } from "@/lib/types";

/** Tiret affiché à la place d'une valeur absente. */
export const EMPTY = "—";

const NBSP = "\u00a0";
const integer = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });

/** Séparateur de milliers = espace insécable simple (stable d'un navigateur à l'autre). */
function clean(text: string): string {
  return text.replace(/[\u202f\u00a0\s]/g, NBSP);
}

type Maybe<T> = T | null | undefined;
const missing = (value: Maybe<number>): value is null | undefined =>
  value === null || value === undefined || Number.isNaN(value);

export function formatNumber(value: Maybe<number>, fractionDigits = 0): string {
  if (missing(value)) return EMPTY;
  return clean(
    new Intl.NumberFormat("fr-FR", {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(value),
  );
}

/** `12000` → `12 000 L` */
export function formatLiters(liters: Maybe<number>): string {
  if (missing(liters)) return EMPTY;
  return `${clean(integer.format(Math.round(liters)))}${NBSP}L`;
}

/** Distance en **mètres** → `12,4 km` (une décimale sous 100 km, aucune au-delà). */
export function formatKm(meters: Maybe<number>): string {
  if (missing(meters)) return EMPTY;
  const km = meters / 1000;
  return `${formatNumber(km, Math.abs(km) < 100 ? 1 : 0)}${NBSP}km`;
}

/**
 * Durée en **secondes** → `45 min`, `2 h 05`.
 * `{ seconds: true }` : sous la minute, affiche les secondes (`42 s`) au lieu d'arrondir à `1 min` / `0 min`.
 */
export function formatDuration(seconds: Maybe<number>, options: { seconds?: boolean } = {}): string {
  if (missing(seconds)) return EMPTY;
  const sign = seconds < 0 ? "−" : "";
  if (options.seconds && Math.abs(seconds) < 60) return `${sign}${Math.round(Math.abs(seconds))}${NBSP}s`;
  const minutes = Math.round(Math.abs(seconds) / 60);
  if (minutes < 60) return `${sign}${minutes}${NBSP}min`;
  return `${sign}${Math.floor(minutes / 60)}${NBSP}h${NBSP}${String(minutes % 60).padStart(2, "0")}`;
}

/** Durée courte en **secondes** → `5,3 s` (temps de calcul, de réponse) ; `fractionDigits` décimales (1 par défaut). */
export function formatSeconds(seconds: Maybe<number>, fractionDigits = 1): string {
  if (missing(seconds)) return EMPTY;
  return `${formatNumber(seconds, fractionDigits)}${NBSP}s`;
}

export function formatPercent(value: Maybe<number>, fractionDigits = 0): string {
  if (missing(value)) return EMPTY;
  return `${formatNumber(value, fractionDigits)}${NBSP}%`;
}

/**
 * Nombre **signé** (écart, variation) : `+1 250`, `−3,5`, `0`. Le signe moins est le vrai signe typographique.
 * `unit` ajoute une unité après une espace insécable : `formatSigned(-120, 0, "L")` → `−120 L`.
 */
export function formatSigned(value: Maybe<number>, fractionDigits = 0, unit?: string): string {
  if (missing(value)) return EMPTY;
  const text = formatNumber(Math.abs(value), fractionDigits);
  // Un écart arrondi à zéro ne porte pas de signe (pas de « −0,0 »).
  const zero = Number(Math.abs(value).toFixed(fractionDigits)) === 0;
  const sign = zero ? "" : value > 0 ? "+" : "−";
  return `${sign}${text}${unit ? `${NBSP}${unit}` : ""}`;
}

/** Pourcentage **signé** : `formatSignedPercent(1.84, 2)` → `+1,84 %`, `formatSignedPercent(-100)` → `−100 %`. */
export function formatSignedPercent(value: Maybe<number>, fractionDigits = 0): string {
  return formatSigned(value, fractionDigits, "%");
}

function toDate(value: Maybe<string | Date>): Date | null {
  if (!value) return null;
  const date = typeof value === "string" ? parseISO(value) : value;
  return isValid(date) ? date : null;
}

/** Horodatage UTC → `HH:mm` en heure de Douala. */
export function formatLocalTime(value: Maybe<string | Date>, timeZone = APP_TIMEZONE): string {
  const date = toDate(value);
  return date ? formatInTimeZone(date, timeZone, "HH:mm") : EMPTY;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Date `YYYY-MM-DD` ou horodatage UTC → `12/01/2027` (jour local de Douala pour un horodatage). */
export function formatDate(value: Maybe<string | Date>, timeZone = APP_TIMEZONE): string {
  if (typeof value === "string" && DAY_RE.test(value)) {
    const [y, m, d] = value.split("-");
    return `${d}/${m}/${y}`;
  }
  const date = toDate(value);
  return date ? formatInTimeZone(date, timeZone, "dd/MM/yyyy") : EMPTY;
}

/** `mar. 12 janv. 2027` */
export function formatDateLong(value: Maybe<string | Date>, timeZone = APP_TIMEZONE): string {
  const date =
    typeof value === "string" && DAY_RE.test(value)
      ? fromZonedTime(`${value}T12:00:00`, timeZone)
      : toDate(value);
  return date ? formatInTimeZone(date, timeZone, "EEE d MMM yyyy", { locale: frLocale }) : EMPTY;
}

/** Horodatage UTC → `12/01/2027 07:30` (heure de Douala). */
export function formatDateTime(value: Maybe<string | Date>, timeZone = APP_TIMEZONE): string {
  const date = toDate(value);
  return date ? formatInTimeZone(date, timeZone, "dd/MM/yyyy HH:mm") : EMPTY;
}

/** Jour courant à Douala, `YYYY-MM-DD`. */
export function todayLocal(now: Date = new Date(), timeZone = APP_TIMEZONE): IsoDate {
  return formatInTimeZone(now, timeZone, "yyyy-MM-dd");
}

export function isValidDay(value: Maybe<string>): value is IsoDate {
  return !!value && DAY_RE.test(value) && isValid(parseISO(value));
}

/** Décale un jour `YYYY-MM-DD` de `n` jours. */
export function addDays(day: IsoDate, n: number): IsoDate {
  const [y, m, d] = day.split("-").map(Number);
  const shifted = addDaysFn(new Date(Date.UTC(y, m - 1, d, 12)), n);
  return shifted.toISOString().slice(0, 10);
}

/** Nombre de jours entre `today` et `day` (négatif = passé). */
export function daysUntil(day: IsoDate, today: IsoDate = todayLocal()): number {
  return differenceInCalendarDays(parseISO(day), parseISO(today));
}

/** Bornes UTC d'un jour local : `[minuit, minuit du lendemain[` (filtres de période). */
export function dayBoundsUtc(day: IsoDate, timeZone = APP_TIMEZONE): { from: string; to: string } {
  return {
    from: fromZonedTime(`${day}T00:00:00`, timeZone).toISOString(),
    to: fromZonedTime(`${addDays(day, 1)}T00:00:00`, timeZone).toISOString(),
  };
}

/** `"06:30"` → 23400 */
export function hmToSeconds(value: string): number {
  const [h, m] = value.trim().split(":");
  return Number(h) * 3600 + Number(m) * 60;
}

/** 23400 → `"06:30"` (secondes depuis minuit local, convention du moteur). */
export function secondsToHM(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
}

/** Saisie utilisateur → nombre : accepte `12 000`, `12000,5`, `12.5`. `null` si vide ou invalide. */
export function parseDecimal(text: string): number | null {
  const normalized = text.replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
  if (normalized === "" || normalized === "-") return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}
