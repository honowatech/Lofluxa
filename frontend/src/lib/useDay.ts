/**
 * Jour J global : partagé entre les écrans et conservé dans l'URL (`?day=YYYY-MM-DD`).
 * Sans paramètre (ou paramètre invalide), c'est le jour courant à Douala.
 *
 *   const { day, setDay, isToday } = useDay();
 *   const orders = useQuery({ queryKey: ["orders", day], … });
 */
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import { addDays, isValidDay, todayLocal } from "@/lib/format";
import type { IsoDate } from "@/lib/types";

export const DAY_PARAM = "day";

export function useDay() {
  const [params, setParams] = useSearchParams();
  const raw = params.get(DAY_PARAM);
  const today = todayLocal();
  const day: IsoDate = isValidDay(raw) ? raw : today;

  const setDay = useCallback(
    (next: IsoDate) => {
      if (!isValidDay(next)) return;
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          updated.set(DAY_PARAM, next);
          return updated;
        },
        { replace: false },
      );
    },
    [setParams],
  );

  return useMemo(
    () => ({
      day,
      setDay,
      isToday: day === today,
      today,
      previous: () => setDay(addDays(day, -1)),
      next: () => setDay(addDays(day, 1)),
      goToday: () => setDay(today),
    }),
    [day, setDay, today],
  );
}

/** Ajoute le jour J courant à un chemin interne : la navigation ne perd jamais la date choisie. */
export function withDay(path: string, day: IsoDate): string {
  return `${path}${path.includes("?") ? "&" : "?"}${DAY_PARAM}=${day}`;
}
