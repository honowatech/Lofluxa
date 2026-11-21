/** Heures locales de Douala ↔ horodatages UTC (RM-20) et écarts sur l'horaire prévu. */
import { dayBoundsUtc, formatLocalTime, hmToSeconds } from "@/lib/format";
import type { IsoDate } from "@/lib/types";

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isTimeHM = (value: string): boolean => HM.test(value);

/** Heure locale `HH:mm` du jour J → horodatage UTC ISO. */
export function localTimeToUtc(day: IsoDate, hm: string): string {
  return new Date(Date.parse(dayBoundsUtc(day).from) + hmToSeconds(hm) * 1000).toISOString();
}

export function utcToLocalTime(value: string | null | undefined): string {
  return value ? formatLocalTime(value) : "";
}

export const nowLocalTime = (): string => formatLocalTime(new Date());

/** Écart réel − prévu en secondes (positif = retard), ou `null` si l'une des deux heures manque. */
export function delaySeconds(
  planned: string | null | undefined,
  actual: string | null | undefined,
): number | null {
  if (!planned || !actual) return null;
  return Math.round((Date.parse(actual) - Date.parse(planned)) / 1000);
}
