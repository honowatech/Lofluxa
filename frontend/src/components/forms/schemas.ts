/**
 * Briques zod partagées par les formulaires. Les messages viennent de `fr.ts`.
 *   const schema = z.object({ code: zText(32), capacity_l: zLiters(), opening_hours: zOpeningHours, lat: zLat, lon: zLon });
 */
import { z } from "zod";

import { fr } from "@/i18n/fr";
import { WEEKDAY_KEYS, type OpeningHours } from "@/lib/types";

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Texte obligatoire. */
export const zText = (max = 160) =>
  z
    .string({ required_error: fr.common.required })
    .trim()
    .min(1, fr.common.required)
    .max(max, fr.fields.max(max));

/** Code d'un référentiel (produit, dépôt, station) : lettres, chiffres, `_`, `.`, `-` — règle du serveur. */
export const zCode = (max = 32) => zText(max).regex(/^[A-Za-z0-9_.-]+$/, fr.fields.codeInvalid);

/** Texte facultatif : chaîne vide → `null`. */
export const zOptionalText = (max = 255) =>
  z
    .string()
    .trim()
    .max(max, fr.fields.max(max))
    .nullable()
    .transform((value) => (value ? value : null));

export const zOptionalEmail = z
  .string()
  .trim()
  .nullable()
  .transform((value) => (value ? value : null))
  .refine((value) => value === null || z.string().email().safeParse(value).success, fr.fields.emailInvalid);

interface NumberRules {
  min?: number;
  max?: number;
  integer?: boolean;
  /** Borne basse exclue (ex. capacité > 0). */
  positive?: boolean;
}

function applyRules(schema: z.ZodNumber, { min, max, integer, positive }: NumberRules): z.ZodNumber {
  let out = schema;
  if (integer) out = out.int(fr.fields.integer);
  if (positive) out = out.positive(fr.fields.litersPositive);
  if (min !== undefined) out = out.min(min, fr.fields.min(min));
  if (max !== undefined) out = out.max(max, fr.fields.max(max));
  return out;
}

/** Nombre obligatoire (les champs numériques fournissent `number | null`). */
export const zNumber = (rules: NumberRules = {}) =>
  z
    .number({ invalid_type_error: fr.fields.numberInvalid, required_error: fr.common.required })
    .nullable()
    .refine((value): value is number => value !== null, fr.common.required)
    .pipe(applyRules(z.number({ invalid_type_error: fr.fields.numberInvalid }), rules));

/** Nombre facultatif : vide = `null` (le serveur applique la valeur par défaut des paramètres). */
export const zOptionalNumber = (rules: NumberRules = {}) =>
  applyRules(z.number({ invalid_type_error: fr.fields.numberInvalid }), rules).nullable();

/** Volume en litres, strictement positif par défaut. */
export const zLiters = (rules: NumberRules = { positive: true }) => zNumber({ max: 1_000_000, ...rules });

export const zTimeHM = z.string().regex(TIME_RE, fr.fields.timeInvalid);

/** Date `YYYY-MM-DD` facultative : vide → `null`. */
export const zOptionalDay = z
  .string()
  .nullable()
  .transform((value) => (value ? value : null))
  .refine((value) => value === null || /^\d{4}-\d{2}-\d{2}$/.test(value), fr.fields.dateInvalid);

export const zLat = zNumber({ min: -90, max: 90 });
export const zLon = zNumber({ min: -180, max: 180 });

export const zColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, fr.fields.colorInvalid);

const zRange = z
  .tuple([zTimeHM, zTimeHM])
  .refine(([start, end]) => start < end, fr.fields.openingHours.rangeInvalid);

const zDayRanges = z.array(zRange).refine((ranges) => {
  const sorted = [...ranges].sort((a, b) => a[0].localeCompare(b[0]));
  return sorted.every((range, index) => index === 0 || sorted[index - 1][1] <= range[0]);
}, fr.fields.openingHours.rangeOverlap);

/** Horaires d'ouverture : `{}` = ouvert en continu ; sinon une liste de plages par jour (voir app/core/time.py). */
export const zOpeningHours: z.ZodType<OpeningHours> = z
  .object(
    Object.fromEntries(WEEKDAY_KEYS.map((day) => [day, zDayRanges.optional()])) as Record<
      (typeof WEEKDAY_KEYS)[number],
      z.ZodOptional<typeof zDayRanges>
    >,
  )
  .transform((value) => {
    // Plages triées, jours absents laissés absents.
    const out: OpeningHours = {};
    for (const day of WEEKDAY_KEYS) {
      const ranges = value[day];
      if (ranges) out[day] = [...ranges].sort((a, b) => a[0].localeCompare(b[0])) as [string, string][];
    }
    return out;
  }) as unknown as z.ZodType<OpeningHours>;
