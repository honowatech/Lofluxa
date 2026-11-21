/** Écran 2 — Journée (accueil) : résumé du jour, calcul du plan, plans du jour, alertes. */
import { Lock, RefreshCw } from "lucide-react";
import { useMemo } from "react";

import { Notice, PageHeader } from "@/components/PageHeader";
import { ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { ViolationsPanel } from "@/components/ViolationsPanel";
import { fr } from "@/i18n/fr";
import { usePublishAlerts, type AppAlert } from "@/lib/alerts";
import { useCan } from "@/lib/auth/session";
import { formatDateLong, formatLocalTime } from "@/lib/format";
import type { Violation } from "@/lib/types";
import { useDay, withDay } from "@/lib/useDay";

import { useDashboard, useDayPlans, useDaySummary, type Dashboard, type DaySummary } from "./api";
import { ComputePanel } from "./ComputePanel";
import { PlansTable } from "./PlansTable";
import { SummaryCards } from "./SummaryCards";

const t = fr.screens.day;

/** Alertes du jour sous la forme commune des violations : celles du tableau de bord, puis celles de la préparation. */
function buildAlerts(dashboard: Dashboard | undefined, summary: DaySummary | undefined): Violation[] {
  const alerts: Violation[] = (dashboard?.alerts ?? []).map((alert) => {
    const context = [
      alert.trip_seq != null ? t.alerts.trip(alert.trip_seq) : null,
      alert.occurred_at ? formatLocalTime(alert.occurred_at) : null,
    ].filter(Boolean);
    return {
      rule_code: alert.code,
      severity: alert.severity,
      message: context.length > 0 ? `${context.join(" · ")} — ${alert.message}` : alert.message,
      trip_id: alert.trip_id,
    };
  });
  if (summary && summary.depot_stocks.missing > 0) {
    alerts.push({
      rule_code: "RM-08",
      severity: "warning",
      message: t.alerts.missingStocks(summary.depot_stocks.missing),
    });
  }
  if (summary && summary.drivers.blocked_rm03 > 0) {
    alerts.push({
      rule_code: "RM-03",
      severity: "warning",
      message: t.alerts.driversRm03(summary.drivers.blocked_rm03),
    });
  }
  return alerts;
}

export default function DayPage() {
  const { day } = useDay();
  const canCompute = useCan("plan.write");
  const canWriteOrders = useCan("orders.write");
  const canWriteStocks = useCan("availability.stocks.write");

  const summary = useDaySummary(day);
  const plans = useDayPlans(day);
  const dashboard = useDashboard(day);

  const planList = plans.data?.items ?? [];
  const lastPlan =
    planList.find((plan) => plan.kind === "computed" && plan.computed_at) ??
    planList.find((plan) => plan.computed_at);

  const alerts = useMemo(() => buildAlerts(dashboard.data, summary.data), [dashboard.data, summary.data]);

  // Zone d'alertes de la coquille : ce qui reste à traiter avant de planifier ou de publier.
  const shellAlerts = useMemo<AppAlert[]>(() => {
    const list: AppAlert[] = [];
    const blocking = dashboard.data?.summary.alerts_blocking ?? 0;
    if (blocking > 0) {
      list.push({
        id: "plan-blocking",
        severity: "blocking",
        title: t.alerts.shellBlocking(blocking),
        to: withDay("/plan", day),
      });
    }
    const missing = summary.data?.depot_stocks.missing ?? 0;
    if (missing > 0) {
      list.push({
        id: "stocks-missing",
        severity: "warning",
        title: t.alerts.shellMissingStocks(missing),
        to: withDay("/disponibilite?tab=stocks", day),
      });
    }
    return list;
  }, [dashboard.data, summary.data, day]);
  usePublishAlerts("day", shellAlerts);

  const refreshing = summary.isFetching || plans.isFetching || dashboard.isFetching;
  const refresh = () => {
    void summary.refetch();
    void plans.refetch();
    void dashboard.refetch();
  };

  return (
    <div className="flex min-h-full flex-col gap-3 p-4" data-testid="screen-day">
      <PageHeader
        title={fr.nav.screens.day}
        subtitle={t.subtitle(formatDateLong(day))}
        actions={
          <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
            <RefreshCw className={refreshing ? "animate-spin" : undefined} />
            {t.refresh}
          </Button>
        }
      />
      {!canCompute && (
        <Notice tone="neutral" icon={<Lock className="size-3.5" />}>
          {t.readOnly}
        </Notice>
      )}

      <SummaryCards
        day={day}
        summary={summary.data}
        loading={summary.isLoading}
        error={summary.error}
        onRetry={() => void summary.refetch()}
        canWriteOrders={canWriteOrders}
        canWriteStocks={canWriteStocks}
      />

      <div className="grid gap-3 xl:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
        <ComputePanel
          day={day}
          canCompute={canCompute}
          confirmedCount={summary.data?.orders.by_status.confirmed}
          lastPlan={lastPlan}
        />
        {dashboard.error && !dashboard.data ? (
          <div className="rounded-md border bg-card">
            <ErrorState
              compact
              title={t.alerts.title}
              error={dashboard.error}
              onRetry={() => void dashboard.refetch()}
            />
          </div>
        ) : (
          <ViolationsPanel violations={alerts} title={t.alerts.title} className="self-start" />
        )}
      </div>

      <section aria-label={t.plans.title} className="flex flex-col gap-1.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-foreground/70">{t.plans.title}</h2>
        <PlansTable
          day={day}
          plans={planList}
          loading={plans.isLoading}
          fetching={plans.isFetching}
          error={plans.error}
          onRetry={() => void plans.refetch()}
        />
      </section>
    </div>
  );
}
