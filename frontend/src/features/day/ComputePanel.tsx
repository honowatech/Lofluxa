/** Bouton « Calculer le plan » (F4.1), suivi de la tâche de fond (F4.5) et état du dernier calcul (F4.6). */
import { ArrowRight, Calculator, CircleAlert, CircleCheck, TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { Notice } from "@/components/PageHeader";
import { Spinner } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { fr } from "@/i18n/fr";
import { EMPTY, formatDateTime, formatSeconds } from "@/lib/format";
import { withDay } from "@/lib/useDay";

import { computeTiming, useComputePlan, type PlanSummary } from "./api";
import { Card } from "./SummaryCards";

const t = fr.screens.day.compute;

/** Lien vers l'écran Plan, positionné sur un plan précis. */
export const planLink = (planId: string, day: string) => withDay(`/plan?plan=${planId}`, day);

function ProgressBar({ value, label }: { value: number; label: string }) {
  const percent = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="flex items-center gap-2">
      <div
        role="progressbar"
        aria-label={t.progress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent} % — ${label}`}
        className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500"
          style={{ width: `${Math.max(percent, 3)}%` }}
        />
      </div>
      <span className="num w-10 text-right text-xs font-medium">{percent} %</span>
    </div>
  );
}

/** Vrai quand un calcul reste « en attente » trop longtemps (réévalué chaque seconde). */
function useStale(startedAt: number | undefined, pending: boolean): boolean {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => tick((n) => n + 1), 5000);
    return () => window.clearInterval(timer);
  }, [pending]);
  return pending && startedAt !== undefined && Date.now() - startedAt > computeTiming.staleMs;
}

function LastCompute({ plan }: { plan: PlanSummary | undefined }) {
  if (!plan) return <p className="text-xs text-muted-foreground">{t.last.none}</p>;
  const rows: [string, React.ReactNode][] = [
    [t.last.computedAt, <span className="num">{formatDateTime(plan.computed_at)}</span>],
    [
      t.last.duration,
      <span className="num">
        {plan.computed_in_ms == null ? EMPTY : formatSeconds(plan.computed_in_ms / 1000)}
      </span>,
    ],
    [t.last.engine, <span className="num">{plan.engine_version ?? EMPTY}</span>],
    [
      t.last.distances,
      plan.approximate ? (
        <Tip label={t.last.approximateHint}>
          <Badge tone="warning" tabIndex={0} data-testid="approximate-flag">
            <TriangleAlert className="size-3" aria-hidden />
            {t.last.approximate}
          </Badge>
        </Tip>
      ) : (
        <Badge tone="success">{t.last.exact}</Badge>
      ),
    ],
    [t.last.by, plan.created_by_name ?? EMPTY],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1 text-xs" data-testid="last-compute">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 truncate">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ComputePanel({
  day,
  canCompute,
  confirmedCount,
  lastPlan,
}: {
  day: string;
  canCompute: boolean;
  confirmedCount: number | undefined;
  lastPlan: PlanSummary | undefined;
}) {
  const { tracked, task, taskError, running, start, dismiss } = useComputePlan(day);
  const pending = running && (task === undefined || task.state === "pending");
  const stale = useStale(tracked?.startedAt, pending);
  const startError = start.error;

  return (
    <Card title={t.title} testId="compute-panel">
      {canCompute && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button onClick={() => start.mutate()} disabled={running || start.isPending}>
            {running || start.isPending ? <Spinner className="text-primary-foreground" /> : <Calculator />}
            {start.isPending ? t.starting : lastPlan && !running ? t.again : t.button}
          </Button>
          {confirmedCount !== undefined && !running && (
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t.hint(confirmedCount)}</p>
          )}
        </div>
      )}

      {startError && !tracked && (
        <Notice
          tone="blocking"
          icon={<CircleAlert className="size-3.5 shrink-0" />}
          action={
            <span className="flex items-center gap-1">
              {startError.code === "no_orders_to_plan" && (
                <Button asChild size="sm" variant="outline">
                  <Link to={withDay("/commandes", day)}>
                    {t.goToOrders}
                    <ArrowRight />
                  </Link>
                </Button>
              )}
              <Button size="icon-sm" variant="ghost" aria-label={t.dismiss} onClick={() => start.reset()}>
                <X />
              </Button>
            </span>
          }
        >
          <strong className="font-semibold">
            {startError.code === "no_orders_to_plan" ? t.noOrders : t.startFailed}
          </strong>
          {" — "}
          {startError.message}
        </Notice>
      )}

      {running && (
        <div
          className="flex flex-col gap-1.5 rounded-md border bg-muted/40 p-2.5"
          data-testid="compute-progress"
        >
          <div className="flex items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate font-medium" aria-live="polite">
              {task?.message ?? (pending ? t.pending : t.running)}
            </span>
            <Button size="sm" variant="ghost" onClick={dismiss}>
              {t.stopTracking}
            </Button>
          </div>
          <ProgressBar value={task?.progress ?? 0} label={task?.message ?? t.running} />
          {stale ? (
            <p className="flex items-start gap-1.5 text-xs text-warning">
              <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              {t.stale}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">{t.survives}</p>
          )}
          {taskError && <p className="text-xs text-warning">{taskError.message}</p>}
        </div>
      )}

      {task?.state === "succeeded" && (
        <Notice
          tone="success"
          icon={<CircleCheck className="size-3.5 shrink-0" />}
          action={
            <span className="flex items-center gap-1">
              {task.plan_id && (
                <Button asChild size="sm">
                  <Link to={planLink(task.plan_id, day)}>
                    {t.openPlan}
                    <ArrowRight />
                  </Link>
                </Button>
              )}
              <Button size="icon-sm" variant="ghost" aria-label={t.dismiss} onClick={dismiss}>
                <X />
              </Button>
            </span>
          }
        >
          <strong className="font-semibold">{t.succeeded}</strong>
          {task.message ? ` — ${task.message}` : ""}
        </Notice>
      )}

      {task?.state === "failed" && (
        <Notice
          tone="blocking"
          icon={<CircleAlert className="size-3.5 shrink-0" />}
          action={
            <Button size="icon-sm" variant="ghost" aria-label={t.dismiss} onClick={dismiss}>
              <X />
            </Button>
          }
        >
          <strong className="font-semibold">{t.failed}</strong>
          {" — "}
          {task.error ?? task.message}
        </Notice>
      )}

      <div className="mt-1 border-t pt-2">
        <h3 className="mb-1.5 text-xs font-semibold text-foreground/70">{t.last.title}</h3>
        <LastCompute plan={lastPlan} />
      </div>
    </Card>
  );
}
