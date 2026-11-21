/**
 * « Recalculer en conservant » (F5.3) : lance la tâche de fond, suit sa progression (`GET /tasks/{id}`)
 * et bascule sur le plan recalculé. L'identifiant de tâche est gardé en `sessionStorage` : le suivi
 * reprend après un rafraîchissement de la page (F4.5).
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { notify } from "@/components";
import { fr } from "@/i18n/fr";

import { getTask, planKeys, recomputePlan } from "./api";
import type { Plan, TaskStatus } from "./types";

const t = fr.screens.plan;
const storageKey = (planId: string) => `tourneo.plan.recompute.${planId}`;
export const TASK_POLL_MS = 1000;

function remember(planId: string, taskId: string | null): void {
  try {
    if (taskId) window.sessionStorage.setItem(storageKey(planId), taskId);
    else window.sessionStorage.removeItem(storageKey(planId));
  } catch {
    // Stockage indisponible : le suivi ne survivra pas à un rafraîchissement, sans autre effet.
  }
}
function recall(planId: string): string | null {
  try {
    return window.sessionStorage.getItem(storageKey(planId));
  } catch {
    return null;
  }
}

export interface Recompute {
  running: boolean;
  task: TaskStatus | undefined;
  start: () => Promise<void>;
  /** Cesse de suivre la tâche (elle continue côté serveur). */
  stop: () => void;
}

export function useRecompute(plan: Plan | null, openPlan: (planId: string) => void): Recompute {
  const client = useQueryClient();
  const planId = plan?.id ?? null;
  const [taskId, setTaskId] = useState<string | null>(() => (planId ? recall(planId) : null));
  const planRef = useRef(plan);
  planRef.current = plan;

  useEffect(() => {
    setTaskId(planId ? recall(planId) : null);
  }, [planId]);

  const query = useQuery({
    queryKey: ["plans", "task", taskId],
    queryFn: ({ signal }) => getTask(taskId as string, signal),
    enabled: !!taskId,
    refetchInterval: (current) =>
      current.state.data && ["succeeded", "failed"].includes(current.state.data.state) ? false : TASK_POLL_MS,
    gcTime: 0,
  });
  const task = taskId ? query.data : undefined;

  const stop = useCallback(() => {
    if (planId) remember(planId, null);
    setTaskId(null);
  }, [planId]);

  useEffect(() => {
    if (!task || !planId || task.task_id !== taskId) return;
    if (task.state === "succeeded") {
      stop();
      void client.invalidateQueries({ queryKey: planKeys.all });
      const before = planRef.current;
      if (task.plan_id && task.plan_id !== planId) {
        openPlan(task.plan_id);
        notify.success(t.recompute.doneNewVersion((before?.version ?? 0) + 1));
      } else notify.success(t.recompute.done);
    } else if (task.state === "failed") {
      stop();
      notify.error(t.recompute.failed, task.error ?? task.message ?? undefined);
    }
  }, [client, openPlan, planId, stop, task, taskId]);

  const start = useCallback(async () => {
    if (!planId) return;
    try {
      const accepted = await recomputePlan(planId);
      remember(planId, accepted.task_id);
      setTaskId(accepted.task_id);
    } catch (error) {
      notify.apiError(error, t.recompute.startFailed);
    }
  }, [planId]);

  return { running: !!taskId, task, start, stop };
}
