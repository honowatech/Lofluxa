/** En-tête de l'écran : choix du plan et de la version, état, indicateurs, actions (vue, historique, recalcul, publication, PDF). */
import { CircleAlert, History, Map as MapIcon, RefreshCw, Send, Table2 } from "lucide-react";
import { useId, useMemo } from "react";

import { Badge, Button, PdfButton, StatusBadge, Tip } from "@/components";
import { NativeSelect } from "@/components/ui/input";
import { fr } from "@/i18n/fr";
import { formatDuration, formatKm, formatLiters, formatLocalTime, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

import { isInForce, rootOf, type PlanAccess } from "../access";
import { usePlanStore } from "../store";
import type { Plan, PlanSummary, PlanView } from "../types";

const t = fr.screens.plan;

/** Lignées de plans du jour (un plan et ses versions), de la plus ancienne à la plus récente. */
export function groupLineages(
  plans: PlanSummary[],
): { root: string; kind: PlanSummary["kind"]; versions: PlanSummary[] }[] {
  const groups = new Map<string, PlanSummary[]>();
  for (const plan of [...plans].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    groups.set(rootOf(plan), [...(groups.get(rootOf(plan)) ?? []), plan]);
  }
  return [...groups.entries()].map(([root, versions]) => ({
    root,
    kind: versions[0].kind,
    versions: [...versions].sort((a, b) => b.version - a.version),
  }));
}

/** Nature d'un plan, dite en clair : plan du jour, journée de référence, rejeu. */
export const natureOf = (plan: Pick<PlanSummary, "kind">): string => t.selector.natures[plan.kind];

/**
 * Libellé d'un plan dans la liste : celui du serveur (`display_label`) s'il est fourni ; sinon sa nature,
 * sa version, son statut et son heure de création. `rank` distingue plusieurs plans de même nature le même
 * jour (plan principal, plan des reliquats) : numéro d'ordre et nombre de tournées.
 */
export function planOptionLabel(plan: PlanSummary, rank?: { index: number } | null): string {
  const time = formatLocalTime(plan.created_at);
  if (plan.display_label) return `${plan.display_label} · ${time}`;
  const status =
    plan.status === "published" && isInForce(plan)
      ? `${fr.status.plan.published}, ${t.selector.inForce}`
      : fr.status.plan[plan.status];
  const trips = plan.metrics?.trips_count;
  const nature = rank
    ? t.selector.ranked(
        natureOf(plan),
        rank.index,
        typeof trips === "number" ? t.selector.trips(trips) : null,
      )
    : natureOf(plan);
  return t.selector.option(nature, plan.version, status, time);
}

/** Rang de chaque lignée parmi celles de même nature (seulement quand il y en a plusieurs). */
export function lineageRanks(plans: PlanSummary[]): Map<string, { index: number }> {
  const lineages = groupLineages(plans);
  const total = new Map<string, number>();
  for (const lineage of lineages) total.set(lineage.kind, (total.get(lineage.kind) ?? 0) + 1);
  const seen = new Map<string, number>();
  const ranks = new Map<string, { index: number }>();
  for (const lineage of lineages) {
    const index = (seen.get(lineage.kind) ?? 0) + 1;
    seen.set(lineage.kind, index);
    if ((total.get(lineage.kind) ?? 0) > 1) ranks.set(lineage.root, { index });
  }
  return ranks;
}

function PlanSelector({
  plan,
  plans,
  onSelect,
}: {
  plan: Plan;
  plans: PlanSummary[];
  onSelect: (planId: string) => void;
}) {
  const id = useId();
  const lineages = useMemo(() => groupLineages(plans), [plans]);
  const ranks = useMemo(() => lineageRanks(plans), [plans]);
  const known = plans.some((other) => other.id === plan.id);
  if (plans.length <= 1) {
    return (
      <span className="text-sm font-medium">
        {plan.display_label ?? t.selector.single(natureOf(plan), plan.version)}
      </span>
    );
  }
  const inForce = lineages.filter(
    (lineage) =>
      lineage.kind === "computed" && lineage.versions.some((v) => v.status === "published" && isInForce(v)),
  ).length;
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {t.selector.label}
      </label>
      <NativeSelect
        id={id}
        className="h-7 w-auto max-w-[30rem] py-0 text-sm"
        value={plan.id}
        onChange={(event) => onSelect(event.target.value)}
      >
        {!known && <option value={plan.id}>{planOptionLabel(plan, ranks.get(rootOf(plan)))}</option>}
        {lineages.map((lineage) => {
          const head =
            lineage.versions.find((version) => version.status !== "archived") ?? lineage.versions[0];
          const trips = head.metrics?.trips_count;
          const detail = [
            head.label ? t.selector.named(head.label) : null,
            typeof trips === "number" ? t.selector.trips(trips) : null,
          ]
            .filter(Boolean)
            .join(", ");
          return (
            <optgroup
              key={lineage.root}
              label={t.selector.lineage(
                t.selector.natures[lineage.kind],
                ranks.get(lineage.root)?.index ?? null,
                detail || null,
              )}
            >
              {lineage.versions.map((version) => (
                <option key={version.id} value={version.id}>
                  {planOptionLabel(version, ranks.get(lineage.root))}
                </option>
              ))}
            </optgroup>
          );
        })}
      </NativeSelect>
      {inForce > 1 && (
        <span className="text-xs text-muted-foreground" data-testid="plans-in-force">
          {t.selector.severalInForce(inForce)}
        </span>
      )}
    </>
  );
}

function ViewToggle() {
  const view = usePlanStore((state) => state.view);
  const options: { value: PlanView; label: string; icon: typeof MapIcon }[] = [
    { value: "map", label: t.header.viewMap, icon: MapIcon },
    { value: "table", label: t.header.viewTable, icon: Table2 },
  ];
  return (
    <div role="radiogroup" aria-label={t.header.viewLabel} className="flex rounded-md border bg-card p-0.5">
      {options.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={view === value}
          onClick={() => usePlanStore.getState().setView(value)}
          className={cn(
            "flex h-6 items-center gap-1 rounded-sm px-2 text-xs font-medium focus-ring",
            view === value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
          )}
        >
          <Icon className="size-3.5" aria-hidden />
          {label}
        </button>
      ))}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5 whitespace-nowrap">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="num text-sm font-semibold">{value}</dd>
    </div>
  );
}

/**
 * Indicateurs du plan : les agrégats calculés par le serveur (`metrics`). Pendant une modification optimiste
 * — ou si le plan n'a pas d'agrégats —, ils sont déduits des tournées affichées pour rester cohérents avec la liste.
 */
export function PlanMetrics({ plan }: { plan: Plan }) {
  const pending = usePlanStore((state) => state.pendingOp !== null);
  const metrics = pending ? null : plan.metrics;
  const rates = plan.trips
    .map((trip) => trip.fill_rate)
    .filter((rate): rate is number => typeof rate === "number");
  const distance = metrics?.total_distance_m ?? plan.trips.reduce((sum, trip) => sum + trip.distance_m, 0);
  const duration = metrics?.total_duration_s ?? plan.trips.reduce((sum, trip) => sum + trip.duration_s, 0);
  const planned = metrics?.planned_l ?? plan.trips.reduce((sum, trip) => sum + trip.planned_l, 0);
  const rate =
    metrics?.avg_fill_rate ??
    (rates.length ? rates.reduce((sum, value) => sum + value, 0) / rates.length : null);
  const fill = rate === null || rate === undefined ? null : rate * 100;
  const total = plan.metrics?.orders_total ?? null;
  const served =
    plan.metrics?.orders_served ?? (total === null ? null : Math.max(0, total - plan.unserved.length));
  return (
    <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-0.5">
      <Metric label={t.trips.title} value={String(plan.trips.length)} />
      <Metric label={t.metrics.distance} value={formatKm(distance)} />
      <Metric label={t.metrics.duration} value={formatDuration(duration)} />
      <Metric label={t.metrics.fill} value={formatPercent(fill)} />
      <Metric label={t.metrics.volume} value={formatLiters(planned)} />
      {total !== null && served !== null && (
        <Metric label={t.metrics.served} value={t.metrics.servedValue(served, total)} />
      )}
    </dl>
  );
}

export interface PlanHeaderProps {
  plan: Plan;
  plans: PlanSummary[];
  access: PlanAccess;
  canWrite: boolean;
  busy: boolean;
  publishing: boolean;
  recomputing: boolean;
  onSelectPlan: (planId: string) => void;
  onHistory: () => void;
  onRecompute: () => void;
  onPublish: () => void;
}

export function PlanHeader({
  plan,
  plans,
  access,
  canWrite,
  busy,
  publishing,
  recomputing,
  onSelectPlan,
  onHistory,
  onRecompute,
  onPublish,
}: PlanHeaderProps) {
  const pending = usePlanStore((state) => state.pendingOp !== null);
  const reasonId = useId();
  const showPublish = canWrite && plan.kind === "computed" && plan.status === "draft";
  const showSheets = plan.status !== "draft" && plan.trips.length > 0;
  const blockedByViolations = showPublish && plan.blocking_count > 0;

  return (
    <header className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h1 className="text-lg font-semibold leading-tight tracking-tight">{t.title}</h1>
        <PlanSelector plan={plan} plans={plans} onSelect={onSelectPlan} />
        <StatusBadge kind="plan" value={plan.status} />
        {plan.status === "published" && isInForce(plan) && (
          <Tip label={t.selector.inForceHint}>
            <span tabIndex={0} className="inline-flex rounded-sm focus-ring">
              <Badge tone="success">{t.selector.inForceBadge}</Badge>
            </span>
          </Tip>
        )}
        {plan.approximate && (
          <Tip label={t.header.approximateHint}>
            <span tabIndex={0} className="inline-flex rounded-sm focus-ring">
              <Badge tone="warning">{t.header.approximate}</Badge>
            </span>
          </Tip>
        )}
        <span
          className="text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
          data-testid="plan-sync"
          data-state={pending ? "saving" : "saved"}
        >
          {pending ? t.header.saving : null}
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <ViewToggle />
          <Button variant="outline" onClick={onHistory}>
            <History aria-hidden />
            {t.header.history}
          </Button>
          {access.canEdit && plan.trips.length > 0 && (
            <Button variant="outline" onClick={onRecompute} disabled={busy}>
              <RefreshCw className={cn(recomputing && "animate-spin")} aria-hidden />
              {t.header.recompute}
            </Button>
          )}
          {showSheets && (
            <PdfButton
              path={`/plans/${plan.id}/route-sheets.pdf`}
              label={t.header.routeSheets}
              fallbackName={`feuilles-de-route-${plan.day}.pdf`}
            />
          )}
          {showPublish && (
            <Tip label={access.publishBlockedReason}>
              {/* Un bouton désactivé ne reçoit pas le survol : l'info-bulle est portée par l'enveloppe. */}
              <span className="inline-flex" tabIndex={access.canPublish ? -1 : 0}>
                <Button
                  onClick={onPublish}
                  disabled={!access.canPublish || publishing}
                  aria-describedby={access.publishBlockedReason ? reasonId : undefined}
                >
                  <Send aria-hidden />
                  {t.header.publish}
                </Button>
              </span>
            </Tip>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <PlanMetrics plan={plan} />
        <span className="text-xs text-muted-foreground">
          {plan.computed_at &&
            t.header.computedAt(
              formatLocalTime(plan.computed_at),
              typeof plan.computed_in_ms === "number"
                ? formatDuration(plan.computed_in_ms / 1000, { seconds: true })
                : null,
              plan.engine_version,
            )}
          {plan.created_by_name && ` · ${t.header.createdBy(plan.created_by_name)}`}
        </span>
        {showPublish && access.publishBlockedReason && (
          <p
            id={reasonId}
            className={cn(
              "ml-auto flex items-center gap-1 text-xs",
              blockedByViolations ? "font-medium text-blocking" : "text-muted-foreground",
            )}
          >
            {blockedByViolations && <CircleAlert className="size-3.5" aria-hidden />}
            {access.publishBlockedReason}
          </p>
        )}
      </div>
    </header>
  );
}
