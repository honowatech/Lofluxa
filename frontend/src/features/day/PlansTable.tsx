/** Plans du jour (toutes versions) avec leur statut et l'accès à l'écran Plan. */
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowRight, TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";

import { DataTable, useDataTableState } from "@/components/DataTable";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { fr } from "@/i18n/fr";
import { EMPTY, formatKm, formatLocalTime, formatNumber, formatPercent } from "@/lib/format";

import type { PlanSummary } from "./api";
import { planLink } from "./ComputePanel";

const t = fr.screens.day.plans;

const metric = (plan: PlanSummary, key: string): number | null => {
  const value = plan.metrics?.[key];
  return typeof value === "number" ? value : null;
};

export const planLabel = (plan: PlanSummary) =>
  `${plan.label ?? t.kinds[plan.kind] ?? plan.kind} ${t.version(plan.version)}`;

export function PlansTable({
  day,
  plans,
  loading,
  fetching,
  error,
  onRetry,
}: {
  day: string;
  plans: PlanSummary[];
  loading: boolean;
  fetching: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const navigate = useNavigate();
  const [state, setState] = useDataTableState({ pageSize: 200 });

  const columns = useMemo<ColumnDef<PlanSummary, unknown>[]>(
    () => [
      {
        id: "plan",
        header: t.plan,
        accessorFn: planLabel,
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <span className="font-medium">{row.original.label ?? t.kinds[row.original.kind]}</span>
            <span className="num text-xs text-muted-foreground">{t.version(row.original.version)}</span>
            {row.original.approximate && (
              <Badge tone="warning" title={fr.screens.day.compute.last.approximateHint}>
                <TriangleAlert className="size-3" aria-hidden />
                {fr.screens.day.compute.last.approximate}
              </Badge>
            )}
          </span>
        ),
      },
      {
        accessorKey: "status",
        header: t.status,
        meta: { className: "w-24" },
        cell: ({ row }) => <StatusBadge kind="plan" value={row.original.status} />,
      },
      {
        accessorKey: "computed_at",
        header: t.computedAt,
        meta: { className: "w-24" },
        cell: ({ row }) => <span className="num">{formatLocalTime(row.original.computed_at)}</span>,
      },
      {
        id: "trips",
        header: t.trips,
        accessorFn: (plan) => metric(plan, "trips_count"),
        meta: { align: "right", className: "w-20" },
        cell: ({ row }) => <span className="num">{formatNumber(metric(row.original, "trips_count"))}</span>,
      },
      {
        id: "served",
        header: t.served,
        enableSorting: false,
        meta: { align: "right", className: "w-36" },
        cell: ({ row }) => {
          const served = metric(row.original, "orders_served");
          // Clé réelle : `orders_total` ; `orders_requested` est celle des métriques détaillées du plan complet.
          const requested = metric(row.original, "orders_total") ?? metric(row.original, "orders_requested");
          return (
            <span className="num">
              {served === null || requested === null ? EMPTY : t.servedValue(served, requested)}
            </span>
          );
        },
      },
      {
        id: "distance",
        header: t.distance,
        accessorFn: (plan) => metric(plan, "total_distance_m"),
        meta: { align: "right", className: "w-24" },
        cell: ({ row }) => <span className="num">{formatKm(metric(row.original, "total_distance_m"))}</span>,
      },
      {
        id: "fill",
        header: t.fill,
        accessorFn: (plan) => metric(plan, "avg_fill_rate_pct"),
        meta: { align: "right", className: "w-28" },
        cell: ({ row }) => (
          <span className="num">{formatPercent(metric(row.original, "avg_fill_rate_pct"))}</span>
        ),
      },
      {
        id: "violations",
        header: t.violations,
        enableSorting: false,
        cell: ({ row }) => {
          const { blocking_count: blocking, warning_count: warning } = row.original;
          if (blocking === 0 && warning === 0)
            return row.original.publishable && row.original.status === "draft" ? (
              <Badge tone="success">{t.publishable}</Badge>
            ) : (
              <span className="text-xs text-muted-foreground">{t.noViolation}</span>
            );
          return (
            <span className="flex items-center gap-1">
              {blocking > 0 && <Badge tone="blocking">{t.blocking(blocking)}</Badge>}
              {warning > 0 && <Badge tone="warning">{t.warning(warning)}</Badge>}
            </span>
          );
        },
      },
      {
        accessorKey: "created_by_name",
        header: t.author,
        cell: ({ row }) => row.original.created_by_name ?? EMPTY,
      },
      {
        id: "open",
        enableSorting: false,
        header: () => <span className="sr-only">{t.open}</span>,
        meta: { label: t.open, align: "right", className: "w-24" },
        cell: ({ row }) => (
          <Link
            to={planLink(row.original.id, day)}
            tabIndex={-1}
            aria-label={t.openLabel(planLabel(row.original))}
            className="inline-flex items-center gap-1 rounded-sm text-xs font-medium text-primary underline-offset-2 hover:underline focus-ring"
          >
            {t.open}
            <ArrowRight className="size-3" aria-hidden />
          </Link>
        ),
      },
    ],
    [day],
  );

  return (
    <DataTable<PlanSummary>
      caption={t.title}
      columns={columns}
      data={plans}
      state={state}
      onStateChange={setState}
      getRowId={(plan) => plan.id}
      loading={loading}
      fetching={fetching}
      error={error}
      onRetry={onRetry}
      onRowActivate={(plan) => navigate(planLink(plan.id, day))}
      hidePagination
      empty={`${t.empty} ${t.emptyHint}`}
    />
  );
}
