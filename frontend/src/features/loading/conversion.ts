/**
 * Calcul indicatif en direct, identique à celui du serveur (`backend/app/loading/conversion.py`, `deviation.py`) :
 *   RM-12  volume à 15 °C = volume observé × [1 − coefficient du produit × (température − 15)]
 *   RM-13  écart (chargé à 15 °C − planifié) hors tolérance, strictement, en valeur absolue.
 * Module pur. La valeur qui fait foi reste celle renvoyée par l'API après enregistrement.
 */
import { dayBoundsUtc, formatLocalTime, hmToSeconds } from "@/lib/format";
import type { IsoDate } from "@/lib/types";

/** Température de référence de la formule (définition du « volume à 15 °C », pas un réglage). */
const REFERENCE_TEMP_C = 15;

/** Arrondi au centième, demi vers le haut (comme `ROUND_HALF_UP` côté serveur). */
export function roundCenti(value: number): number {
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * 100 + 1e-7)) / 100;
}

/** RM-12 : volume à 15 °C, arrondi au centième de litre. */
export function volumeAt15(observedL: number, tempC: number, thermalCoeff: number): number {
  return roundCenti(observedL * (1 - thermalCoeff * (tempC - REFERENCE_TEMP_C)));
}

export interface Gap {
  plannedL: number;
  loadedL: number;
  gapL: number;
  /** En % du planifié ; `null` si rien n'était planifié. */
  gapPct: number | null;
  /** `null` : tolérance inconnue, pas de jugement en direct. */
  outOfTolerance: boolean | null;
}

/** RM-13 pour un compartiment ou pour le total. */
export function computeGap(loadedL: number, plannedL: number, tolerancePct: number | null): Gap {
  const gapL = roundCenti(loadedL - plannedL);
  if (plannedL > 0) {
    return {
      plannedL,
      loadedL,
      gapL,
      gapPct: roundCenti((gapL * 100) / plannedL),
      outOfTolerance: tolerancePct === null ? null : Math.abs(gapL) * 100 > tolerancePct * plannedL + 1e-9,
    };
  }
  return {
    plannedL,
    loadedL,
    gapL,
    gapPct: null,
    outOfTolerance: tolerancePct === null ? null : loadedL > 0,
  };
}

/* ------------------------------------------------------------------ heures */

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isTimeHM = (value: string): boolean => HM.test(value);

/** Heure locale `HH:mm` du jour J → horodatage UTC ISO (RM-20). */
export function localTimeToUtc(day: IsoDate, hm: string): string {
  return new Date(Date.parse(dayBoundsUtc(day).from) + hmToSeconds(hm) * 1000).toISOString();
}

/** Horodatage UTC → `HH:mm` local, ou chaîne vide. */
export function utcToLocalTime(value: string | null | undefined): string {
  return value ? formatLocalTime(value) : "";
}

export const nowLocalTime = (): string => formatLocalTime(new Date());
