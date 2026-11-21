/** Appels à l'API des plans (spec §9) : lectures par TanStack Query, écritures en fonctions simples. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { api, fetchAll } from "@/lib/api";
import type { IsoDate } from "@/lib/types";

import { opRequest } from "./edits";
import type {
  DriverDay,
  EditOp,
  Plan,
  PlanSummary,
  PlanVersion,
  TaskAccepted,
  TaskStatus,
  TruckDay,
} from "./types";

/** Rythme de relecture de la liste des plans du jour. */
export const PLANS_REFRESH_MS = 60_000;

export const planKeys = {
  all: ["plans"] as const,
  ofDay: (day: IsoDate) => ["plans", "day", day] as const,
  one: (id: string) => ["plans", "one", id] as const,
  versions: (id: string) => ["plans", "versions", id] as const,
  truckDays: (day: IsoDate) => ["plans", "truck-days", day] as const,
  driverDays: (day: IsoDate) => ["plans", "driver-days", day] as const,
};

/** Tous les plans du jour, toutes versions, du plus récent au plus ancien. */
export function usePlansOfDay(day: IsoDate) {
  return useQuery({
    queryKey: planKeys.ofDay(day),
    queryFn: ({ signal }) => fetchAll<PlanSummary>("/plans", { day }, signal),
    // Un événement du jour (panne, pénurie) peut publier une nouvelle version à tout moment.
    refetchInterval: PLANS_REFRESH_MS,
  });
}

export function usePlanQuery(planId: string | null) {
  return useQuery({
    queryKey: planKeys.one(planId ?? "none"),
    queryFn: ({ signal }) => api<Plan>(`/plans/${planId}`, { signal }),
    enabled: !!planId,
  });
}

export function useVersions(planId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: planKeys.versions(planId ?? "none"),
    queryFn: ({ signal }) => fetchAll<PlanVersion>(`/plans/${planId}/versions`, {}, signal),
    enabled: enabled && !!planId,
  });
}

/** Camions et chauffeurs du jour, avec leur caractère affectable (RM-03, RM-04) : listes du changement d'affectation. */
export function useTruckDays(day: IsoDate, enabled: boolean) {
  return useQuery({
    queryKey: planKeys.truckDays(day),
    queryFn: ({ signal }) => fetchAll<TruckDay>("/availability/trucks", { day }, signal),
    enabled,
    staleTime: 60_000,
  });
}
export function useDriverDays(day: IsoDate, enabled: boolean) {
  return useQuery({
    queryKey: planKeys.driverDays(day),
    queryFn: ({ signal }) => fetchAll<DriverDay>("/availability/drivers", { day }, signal),
    enabled,
    staleTime: 60_000,
  });
}

export const sendEdit = (planId: string, op: EditOp): Promise<Plan> => {
  const { path, body } = opRequest(planId, op);
  return api<Plan>(path, { method: "POST", body });
};
export const publishPlan = (planId: string) => api<Plan>(`/plans/${planId}/publish`, { method: "POST" });
export const recomputePlan = (planId: string) =>
  api<TaskAccepted>(`/plans/${planId}/recompute`, { method: "POST" });
export const getTask = (taskId: string, signal?: AbortSignal) =>
  api<TaskStatus>(`/tasks/${taskId}`, { signal });
export const restoreVersion = (planId: string, version: number) =>
  api<Plan>(`/plans/${planId}/versions/${version}/restore`, { method: "POST" });
export const postponeOrder = (orderId: string) => api(`/orders/${orderId}/postpone`, { method: "POST" });

/** Range dans le cache un plan renvoyé par une écriture et périme les listes qui en dépendent. */
export function usePlanCache() {
  const client = useQueryClient();
  return useCallback(
    (plan: Plan) => {
      client.setQueryData(planKeys.one(plan.id), plan);
      void client.invalidateQueries({ queryKey: planKeys.ofDay(plan.day) });
      void client.invalidateQueries({ queryKey: ["plans", "versions"] });
    },
    [client],
  );
}
