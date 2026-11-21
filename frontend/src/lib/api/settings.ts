/** Paramètres métier : `GET /settings` → `Page<Setting>`, `PUT /settings` avec `{values: {clé: valeur}}` (lot L8). */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { Page, Setting, SettingValue } from "@/lib/types";

import { api } from "./client";
import type { ApiError } from "./errors";

export const settingsKey = ["/settings"] as const;

export function useSettings() {
  return useQuery<Setting[], ApiError>({
    queryKey: settingsKey,
    queryFn: async ({ signal }) => (await api<Page<Setting>>("/settings", { signal })).items,
    staleTime: 60_000,
  });
}

/**
 * Enregistre les seules clés modifiées. Tout ou rien : une valeur refusée annule l'ensemble
 * (422, `details[].field` = clé, `details[].message` = motif).
 */
export function useUpdateSettings() {
  const client = useQueryClient();
  return useMutation<Setting[], ApiError, Record<string, SettingValue>>({
    mutationFn: async (values) =>
      (await api<Page<Setting>>("/settings", { method: "PUT", body: { values } })).items,
    onSuccess: (settings) => {
      client.setQueryData(settingsKey, settings);
      return client.invalidateQueries({ queryKey: ["/audit"] });
    },
  });
}
