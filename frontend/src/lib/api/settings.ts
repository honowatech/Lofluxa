/**
 * Paramètres métier (`GET/PUT /settings`, lot L8).
 * La forme exacte de la réponse n'est pas fixée par la spec (question L9-Q6) : `normalizeSettings` accepte
 * une `Page`, une liste, ou un simple dictionnaire `{clé: valeur}`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { Setting, SettingValue } from "@/lib/types";

import { api } from "./client";
import type { ApiError } from "./errors";

export function normalizeSettings(raw: unknown): Setting[] {
  const source = raw as { items?: unknown } | unknown[] | Record<string, unknown> | null;
  const list = Array.isArray(source)
    ? source
    : Array.isArray((source as { items?: unknown })?.items)
      ? (source as { items: unknown[] }).items
      : null;
  if (list) {
    return list.map((entry) => {
      const row = entry as Record<string, unknown>;
      return {
        key: String(row.key),
        value: row.value as SettingValue,
        default_value: (row.default_value ?? row.default) as SettingValue | undefined,
        description: (row.description as string | null | undefined) ?? null,
        updated_at: (row.updated_at as string | null | undefined) ?? null,
        updated_by: (row.updated_by as string | null | undefined) ?? null,
      };
    });
  }
  return Object.entries((source as Record<string, unknown>) ?? {}).map(([key, value]) => ({
    key,
    value: value as SettingValue,
  }));
}

export const settingsKey = ["/settings"] as const;

export function useSettings() {
  return useQuery<Setting[], ApiError>({
    queryKey: settingsKey,
    queryFn: async ({ signal }) => normalizeSettings(await api<unknown>("/settings", { signal })),
    staleTime: 60_000,
  });
}

/** `PUT /settings` avec les seules clés modifiées : `{ window_tolerance_min: 20 }`. */
export function useUpdateSettings() {
  const client = useQueryClient();
  return useMutation<Setting[], ApiError, Record<string, SettingValue>>({
    mutationFn: async (changes) =>
      normalizeSettings(await api<unknown>("/settings", { method: "PUT", body: changes })),
    onSuccess: (settings) => {
      if (settings.length > 0) client.setQueryData(settingsKey, settings);
      return Promise.all([
        client.invalidateQueries({ queryKey: settingsKey }),
        client.invalidateQueries({ queryKey: ["/audit"] }),
      ]);
    },
  });
}
