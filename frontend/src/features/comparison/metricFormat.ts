/**
 * Mise en forme d'un indicateur selon son unité (`m`, `s`, `l`, `pct`, `count`), valeurs inconnues en « — ».
 * La conversion elle-même reste dans `lib/format.ts`.
 */
import { fr } from "@/i18n/fr";
import { EMPTY, formatDuration, formatKm, formatLiters, formatNumber, formatPercent } from "@/lib/format";

type Maybe = number | null | undefined;
const known = (value: Maybe): value is number =>
  value !== null && value !== undefined && !Number.isNaN(value);

export function formatMetric(unit: string, value: Maybe): string {
  if (!known(value)) return EMPTY;
  switch (unit) {
    case "m":
      return formatKm(value);
    case "s":
      // Un calcul de quelques secondes ne doit pas s'afficher « 0 min ».
      return value > 0 && value < 60 ? fr.screens.comparison.metrics.underMinute : formatDuration(value);
    case "l":
      return formatLiters(value);
    case "pct":
      return formatPercent(value, 1);
    default:
      return formatNumber(value);
  }
}

const NBSP = String.fromCharCode(160);
const sign = (value: number) => (value > 0 ? "+" : value < 0 ? "−" : "");

/** Écart signé dans l'unité de l'indicateur (`−51,1 km`, `+1`, `+3,4 pt`). */
export function formatDelta(unit: string, delta: Maybe): string {
  if (!known(delta)) return EMPTY;
  const magnitude = Math.abs(delta);
  if (unit === "pct") {
    return `${sign(delta)}${formatNumber(magnitude, 1)}${NBSP}${fr.screens.comparison.metrics.points}`;
  }
  return `${sign(delta)}${formatMetric(unit, magnitude)}`;
}

/** Écart relatif signé (`−27,9 %`). */
export function formatDeltaPct(value: Maybe): string {
  if (!known(value)) return EMPTY;
  return `${sign(value)}${formatPercent(Math.abs(value), 1)}`;
}
