/**
 * Tableau d'indicateurs (F8.4) : valeur de A, valeur de B, écart en valeur et en %, et le plan avantagé.
 * Les lignes, leurs libellés, les écarts et le sens du « mieux » (`better`) viennent du serveur : rien
 * n'est recalculé ici. Une valeur inconnue s'affiche « — », jamais 0.
 */
import { Fragment } from "react";

import { fr } from "@/i18n/fr";
import { EMPTY } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { Comparison, MetricDelta, Side } from "./api";
import { formatDelta, formatDeltaPct, formatMetric } from "./metricFormat";
import { Section, SIDE_BG, SideChip } from "./shared";

const t = fr.screens.comparison.metrics;

type GroupId = keyof typeof t.groups;
const GROUP_OF: Record<string, GroupId> = {
  distance_estimated_m: "distance",
  distance_actual_m: "distance",
  trucks_used: "resources",
  drivers_used: "resources",
  trips_count: "resources",
  stations_requested: "service",
  stations_served: "service",
  stations_delivered: "service",
  orders_requested: "service",
  orders_served: "service",
  volume_requested_l: "service",
  volume_planned_l: "service",
  volume_delivered_l: "service",
  service_duration_s: "service",
  service_duration_actual_s: "service",
  fill_rate_avg_pct: "service",
  violations_blocking: "quality",
  violations_warning: "quality",
  violations_total: "quality",
  prep_time_s: "quality",
};
const GROUP_ORDER: GroupId[] = ["distance", "resources", "service", "quality", "other"];

const isSide = (value: string | null): value is Side => value === "a" || value === "b";

/** Barre d'écart relatif autour de zéro (bornée à ±100 %), à la couleur du plan avantagé. */
function DeltaBar({ row }: { row: MetricDelta }) {
  if (row.delta_pct === null) return null;
  const half = Math.min(100, Math.abs(row.delta_pct)) / 2;
  const color = isSide(row.better) ? SIDE_BG[row.better] : "bg-foreground/30";
  return (
    <div aria-hidden className="relative h-3 w-24">
      <span className="absolute inset-y-0 left-1/2 w-px bg-foreground/35" />
      {row.delta_pct !== 0 && (
        <span
          className={cn(
            "absolute inset-y-0.5",
            color,
            row.delta_pct < 0 ? "rounded-l-[3px]" : "rounded-r-[3px]",
          )}
          style={
            row.delta_pct < 0
              ? { right: "50%", width: `${half}%`, marginRight: 1 }
              : { left: "50%", width: `${half}%`, marginLeft: 1 }
          }
        />
      )}
    </div>
  );
}

function Advantage({ row }: { row: MetricDelta }) {
  if (isSide(row.better)) {
    return (
      <span className="flex items-center gap-1.5 font-medium" aria-label={t.betterLabel[row.better]}>
        <SideChip side={row.better} className="size-4 text-2xs" />
        {t.better[row.better]}
      </span>
    );
  }
  if (row.better === "equal") return <span className="text-muted-foreground">{t.better.equal}</span>;
  // Grandeur de contexte (demandé) ou valeur inconnue : pas d'avantage à attribuer.
  if (row.a === null || row.b === null) {
    return <span className="text-muted-foreground">{EMPTY}</span>;
  }
  return <span className="sr-only">{t.betterLabel.none}</span>;
}

function Value({ unit, value, note }: { unit: string; value: number | null; note?: string | null }) {
  if (value === null) {
    return (
      <span className="text-muted-foreground" title={t.unknownHint}>
        {EMPTY}
      </span>
    );
  }
  return (
    <>
      {formatMetric(unit, value)}
      {note && <span className="ml-1.5 font-sans text-2xs text-muted-foreground">({note})</span>}
    </>
  );
}

export function MetricsTable({ comparison }: { comparison: Comparison }) {
  const { deltas, metrics_a: a, metrics_b: b } = comparison;
  const groups = GROUP_ORDER.map((id) => ({
    id,
    rows: deltas.filter((row) => (GROUP_OF[row.key] ?? "other") === id),
  })).filter((group) => group.rows.length > 0);

  const prepNote = (source: string | null) =>
    source === "manual" || source === "computed" ? t.prepSource[source] : null;

  const partial = [
    { side: "A", metrics: a },
    { side: "B", metrics: b },
  ].filter(
    ({ metrics }) =>
      metrics.distance_actual_m !== null && metrics.distance_actual_trips < metrics.trips_count,
  );

  const head = "border-b bg-muted px-2.5 py-1.5 text-xs font-semibold text-foreground/70";
  const cell = "border-b px-2.5 py-1";

  return (
    <Section id="metrics-heading" title={t.heading}>
      <div className="overflow-x-auto rounded-md border bg-card">
        <table className="w-full border-separate border-spacing-0 text-sm" data-testid="metrics-table">
          <caption className="sr-only">{t.caption}</caption>
          <thead>
            <tr>
              <th scope="col" className={cn(head, "w-[30%] text-left")}>
                {t.columns.indicator}
              </th>
              <th scope="col" className={cn(head, "text-right")}>
                <span className="inline-flex items-center gap-1.5">
                  <SideChip side="a" className="size-4 text-2xs" />
                  {t.columns.a}
                </span>
              </th>
              <th scope="col" className={cn(head, "text-right")}>
                <span className="inline-flex items-center gap-1.5">
                  <SideChip side="b" className="size-4 text-2xs" />
                  {t.columns.b}
                </span>
              </th>
              <th scope="col" className={cn(head, "text-right")}>
                {t.columns.delta}
              </th>
              <th scope="col" colSpan={2} className={cn(head, "text-right")}>
                {t.columns.deltaPct}
              </th>
              <th scope="col" className={cn(head, "text-left")}>
                {t.columns.better}
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <Fragment key={group.id}>
                <tr>
                  <th
                    scope="colgroup"
                    colSpan={7}
                    className="border-b bg-muted/45 px-2.5 py-1 text-left text-2xs font-semibold uppercase tracking-wide text-foreground/60"
                  >
                    {t.groups[group.id]}
                  </th>
                </tr>
                {group.rows.map((row) => (
                  <tr key={row.key} data-metric={row.key} data-better={row.better ?? "none"}>
                    <th scope="row" className={cn(cell, "text-left font-normal")}>
                      {row.label}
                    </th>
                    <td className={cn(cell, "num whitespace-nowrap text-right")}>
                      <Value
                        unit={row.unit}
                        value={row.a}
                        note={row.key === "prep_time_s" ? prepNote(a.prep_time_source) : null}
                      />
                    </td>
                    <td className={cn(cell, "num whitespace-nowrap text-right")}>
                      <Value
                        unit={row.unit}
                        value={row.b}
                        note={row.key === "prep_time_s" ? prepNote(b.prep_time_source) : null}
                      />
                    </td>
                    <td
                      className={cn(
                        cell,
                        "num whitespace-nowrap text-right",
                        row.delta === null && "text-muted-foreground",
                      )}
                    >
                      {formatDelta(row.unit, row.delta)}
                    </td>
                    <td
                      className={cn(
                        cell,
                        "num whitespace-nowrap pr-1 text-right",
                        row.delta_pct === null && "text-muted-foreground",
                      )}
                    >
                      {formatDeltaPct(row.delta_pct)}
                    </td>
                    <td className={cn(cell, "w-28 pl-1")}>
                      <DeltaBar row={row} />
                    </td>
                    <td className={cn(cell, "whitespace-nowrap text-xs")}>
                      <Advantage row={row} />
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
        {partial.map(({ side, metrics }) => (
          <p key={side} data-testid="partial-actual">
            {t.partialActual(side, metrics.distance_actual_trips, metrics.trips_count)}
          </p>
        ))}
        <p>{t.legend}</p>
      </div>
    </Section>
  );
}
