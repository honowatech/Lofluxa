/** Accès à l'API de l'écran Journée : résumé, plans du jour, tableau de bord, calcul du plan et son suivi. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import { api } from "@/lib/api/client";
import type { ApiError } from "@/lib/api/errors";
import type { components } from "@/lib/types/api.gen";

type Schemas = components["schemas"];
export type DaySummary = Schemas["DaySummaryOut"];
export type PlanSummary = Schemas["PlanSummaryOut"];
export type PlanPage = Schemas["Page_PlanSummaryOut_"];
export type Dashboard = Schemas["DashboardOut"];
export type DashboardAlert = Schemas["DashboardAlertOut"];
export type Task = Schemas["TaskOut"];
export type DayEvent = Schemas["EventOut"];
export type EventPage = Schemas["Page_EventOut_"];
export type TaskAccepted = Schemas["TaskAccepted"];

export const dayKeys = {
  summary: (day: string) => ["/availability/summary", day] as const,
  plans: (day: string) => ["/plans", "list", { day }] as const,
  dashboard: (day: string) => ["/dashboard", day] as const,
  events: (day: string) => ["/events", "recent", day] as const,
  task: (taskId: string) => ["/tasks", taskId] as const,
};

export function useDaySummary(day: string) {
  return useQuery<DaySummary, ApiError>({
    queryKey: dayKeys.summary(day),
    queryFn: ({ signal }) => api<DaySummary>("/availability/summary", { query: { day }, signal }),
  });
}

/** Plans du jour, toutes versions, du plus récent au plus ancien (ordre du serveur). */
export function useDayPlans(day: string) {
  return useQuery<PlanPage, ApiError>({
    queryKey: dayKeys.plans(day),
    queryFn: ({ signal }) => api<PlanPage>("/plans", { query: { day, limit: 100, offset: 0 }, signal }),
  });
}

export function useDashboard(day: string) {
  return useQuery<Dashboard, ApiError>({
    queryKey: dayKeys.dashboard(day),
    queryFn: ({ signal }) => api<Dashboard>("/dashboard", { query: { day }, signal }),
  });
}

/** Nombre d'événements montrés sur l'accueil ; le fil complet est sur l'écran Journal des événements. */
export const RECENT_EVENTS = 6;

/** Derniers événements du jour (le serveur les renvoie du plus récent au plus ancien). */
export function useRecentEvents(day: string, enabled: boolean) {
  return useQuery<EventPage, ApiError>({
    queryKey: dayKeys.events(day),
    queryFn: ({ signal }) =>
      api<EventPage>("/events", { query: { day, limit: RECENT_EVENTS, offset: 0 }, signal }),
    enabled,
  });
}

/* ------------------------------------------------------------ suivi du calcul */

/**
 * Rythme du suivi : intervalle d'interrogation de `GET /tasks/{id}`, et délai au-delà duquel un calcul toujours
 * « en attente » est signalé (exécutant arrêté ?). Simple aide visuelle ; modifiable par les tests.
 */
export const computeTiming = { pollMs: 1000, staleMs: 120_000 };

export const COMPUTE_STORAGE_KEY = "tourneo.day.compute";

export interface TrackedTask {
  taskId: string;
  startedAt: number;
}

function readAll(): Record<string, TrackedTask> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(COMPUTE_STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, TrackedTask>) : {};
  } catch {
    return {};
  }
}

function readTracked(day: string): TrackedTask | null {
  const entry = readAll()[day];
  return entry && typeof entry.taskId === "string" ? entry : null;
}

function writeTracked(day: string, entry: TrackedTask | null): void {
  const all = readAll();
  if (entry) all[day] = entry;
  else delete all[day];
  try {
    window.localStorage.setItem(COMPUTE_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Stockage indisponible : le suivi fonctionne quand même tant que la page reste ouverte.
  }
}

const isFinal = (task: Task | undefined) => task?.state === "succeeded" || task?.state === "failed";

/**
 * Calcul du plan du jour (F4.1, F4.5) : lance `POST /plans/compute`, puis suit `GET /tasks/{task_id}`.
 * L'identifiant de la tâche en cours est conservé par jour dans le stockage local : le suivi reprend après un
 * rafraîchissement de la page. Il en est retiré dès que le calcul est terminé (le résultat reste affiché
 * tant que l'écran est ouvert ; le plan produit figure ensuite dans la liste des plans du jour).
 */
export function useComputePlan(day: string) {
  const client = useQueryClient();
  const [tracked, setTracked] = useState<TrackedTask | null>(() => readTracked(day));
  const [trackedDay, setTrackedDay] = useState(day);
  if (trackedDay !== day) {
    setTrackedDay(day);
    setTracked(readTracked(day));
  }

  const task = useQuery<Task, ApiError>({
    queryKey: dayKeys.task(tracked?.taskId ?? ""),
    queryFn: ({ signal }) => api<Task>(`/tasks/${tracked?.taskId}`, { signal }),
    enabled: !!tracked,
    refetchInterval: (query) => (isFinal(query.state.data) ? false : computeTiming.pollMs),
    staleTime: Infinity,
    gcTime: 0,
  });

  const start = useMutation<TaskAccepted, ApiError, void>({
    mutationFn: () => api<TaskAccepted>("/plans/compute", { method: "POST", body: { day } }),
    onSuccess: (accepted) => {
      const entry = { taskId: accepted.task_id, startedAt: Date.now() };
      writeTracked(day, entry);
      setTracked(entry);
    },
  });

  // Fin du calcul : le plan produit, les statuts de commandes et les alertes ont changé.
  const finalState = isFinal(task.data) ? task.data?.state : undefined;
  useEffect(() => {
    if (!finalState) return;
    writeTracked(day, null);
    void client.invalidateQueries({ queryKey: ["/plans"] });
    void client.invalidateQueries({ queryKey: dayKeys.summary(day) });
    void client.invalidateQueries({ queryKey: dayKeys.dashboard(day) });
    void client.invalidateQueries({ queryKey: ["/orders"] });
    void client.invalidateQueries({ queryKey: dayKeys.events(day) });
  }, [finalState, day, client]);

  const dismiss = useCallback(() => {
    writeTracked(day, null);
    setTracked(null);
    start.reset();
  }, [day, start]);

  return {
    tracked,
    task: tracked ? task.data : undefined,
    /** Erreur de lecture de l'état de la tâche (réseau) : le suivi continue. */
    taskError: tracked ? task.error : null,
    running: !!tracked && !isFinal(task.data),
    start,
    dismiss,
  };
}
