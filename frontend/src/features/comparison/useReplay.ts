/**
 * Rejeu d'une journée de référence par le moteur (F8.2) :
 * `POST /plans/{id}/replay` → suivi de `GET /tasks/{task_id}` jusqu'à `succeeded` ou `failed`.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { fr } from "@/i18n/fr";
import { errorMessage } from "@/lib/api";

import { fetchTask, startReplay } from "./api";

/** Intervalle de suivi de la tâche (modifiable par les tests). */
export const replayConfig = { pollMs: 1000 };

export type ReplayState =
  | { phase: "idle" }
  | { phase: "running"; planId: string; progress: number; message: string | null }
  | { phase: "failed"; planId: string; error: string };

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export function useReplay(onDone: (referencePlanId: string, replayPlanId: string) => void) {
  const [state, setState] = useState<ReplayState>({ phase: "idle" });
  const alive = useRef(true);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async (planId: string) => {
    setState({ phase: "running", planId, progress: 0, message: null });
    try {
      const { task_id } = await startReplay(planId);
      while (alive.current) {
        const task = await fetchTask(task_id);
        if (!alive.current) return;
        if (task.state === "succeeded" && task.plan_id) {
          setState({ phase: "idle" });
          onDoneRef.current(planId, task.plan_id);
          return;
        }
        if (task.state === "failed" || task.state === "succeeded") {
          setState({
            phase: "failed",
            planId,
            error: task.error ?? task.message ?? fr.screens.comparison.replay.failedUnknown,
          });
          return;
        }
        setState({ phase: "running", planId, progress: task.progress, message: task.message ?? null });
        await wait(replayConfig.pollMs);
      }
    } catch (caught) {
      if (alive.current) setState({ phase: "failed", planId, error: errorMessage(caught) });
    }
  }, []);

  const dismiss = useCallback(() => setState({ phase: "idle" }), []);

  return { state, run, dismiss, running: state.phase === "running" };
}
