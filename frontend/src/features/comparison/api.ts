/**
 * Accès à l'API du lot L7 (comparaison, journée de référence, rejeu, tableau de bord) et à `GET /plans`.
 * Les types viennent du fichier généré depuis l'OpenAPI : rien n'est réécrit à la main.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { api, apiUpload } from "@/lib/api";
import type { IsoDate, Page } from "@/lib/types";
import type { components } from "@/lib/types/api.gen";

type Schemas = components["schemas"];

export type Comparison = Schemas["ComparisonOut"];
export type PlanSummary = Schemas["app__comparison__schemas__PlanSummaryOut"];
/** Ligne de `GET /plans` (résumé du lot L5). */
export type PlanRow = Schemas["app__planning__schemas__PlanSummaryOut"];
export type PlanKind = Schemas["PlanKind"];
export type PlanMetrics = Schemas["PlanMetricsOut"];
export type MetricDelta = Schemas["MetricDeltaOut"];
export type Verdict = Schemas["VerdictOut"];
export type TripRoute = Schemas["TripRouteOut"];
export type RouteStop = Schemas["RouteStopOut"];
export type Unserved = Schemas["app__comparison__schemas__UnservedOut"];
export type ReferenceDayImport = Schemas["ReferenceDayImportOut"];
export type ImportIssue = Schemas["ImportIssueOut"];
export type Task = Schemas["TaskOut"];
export type Dashboard = Schemas["DashboardOut"];
export type DashboardTrip = Schemas["DashboardTripOut"];
export type DashboardAlert = Schemas["DashboardAlertOut"];
export type DashboardDelay = Schemas["DashboardDelayOut"];

export type Side = "a" | "b";
export const SIDE_LABEL: Record<Side, string> = { a: "A", b: "B" };

const keys = {
  plans: (day: IsoDate) => ["comparison", "plans", day] as const,
  comparison: (a: string, b: string) => ["comparison", "result", a, b] as const,
  dashboard: (day: IsoDate) => ["comparison", "dashboard", day] as const,
};

/** Tous les plans d'un jour (toutes versions, tous types), du plus récent au plus ancien. */
export function usePlans(day: IsoDate) {
  return useQuery({
    queryKey: keys.plans(day),
    queryFn: ({ signal }) => api<Page<PlanRow>>("/plans", { query: { day, limit: 200 }, signal }),
    select: (page) => page.items,
  });
}

export function useInvalidatePlans() {
  const client = useQueryClient();
  return useCallback(() => client.invalidateQueries({ queryKey: ["comparison", "plans"] }), [client]);
}

export function useComparison(planA: string | null, planB: string | null) {
  const enabled = !!planA && !!planB && planA !== planB;
  return useQuery({
    queryKey: keys.comparison(planA ?? "", planB ?? ""),
    queryFn: ({ signal }) =>
      api<Comparison>("/comparison", { query: { plan_a: planA, plan_b: planB }, signal }),
    enabled,
  });
}

export function useDashboard(day: IsoDate, enabled = true) {
  return useQuery({
    queryKey: keys.dashboard(day),
    queryFn: ({ signal }) => api<Dashboard>("/dashboard", { query: { day }, signal }),
    enabled,
    refetchInterval: 60_000,
  });
}

export interface ReferenceDayFields {
  day?: IsoDate | null;
  prep_time_min?: number | null;
  label?: string | null;
  dry_run?: boolean;
  replace?: boolean;
}

/**
 * `POST /reference-days/import` (multipart). `dry_run` contrôle le fichier sans rien créer.
 * Fichier rejeté : 422 `import_rejected`, le rapport ligne par ligne est dans `details` de l'`ApiError`.
 * Journée déjà importée : 409 `reference_day_exists` (relancer avec `replace`).
 */
export function importReferenceDay(file: File, fields: ReferenceDayFields): Promise<ReferenceDayImport> {
  const form: Record<string, string | number | boolean> = {};
  if (fields.day) form.day = fields.day;
  if (fields.prep_time_min !== null && fields.prep_time_min !== undefined) {
    form.prep_time_min = fields.prep_time_min;
  }
  if (fields.label) form.label = fields.label;
  if (fields.dry_run) form.dry_run = true;
  if (fields.replace) form.replace = true;
  return apiUpload<ReferenceDayImport>("/reference-days/import", file, { fields: form });
}

export const startReplay = (planId: string) =>
  api<Schemas["ReplayOut"]>(`/plans/${planId}/replay`, { method: "POST" });

export const fetchTask = (taskId: string, signal?: AbortSignal) => api<Task>(`/tasks/${taskId}`, { signal });
