/**
 * Volet « Suivi de la journée B » (F8.6) : avancement des tournées du plan publié du jour J, retards
 * estimés, alertes actives — `GET /dashboard?day=`. La spec ne donne pas d'écran propre au tableau de
 * bord : il est logé ici pour la direction (voir docs/questions/l14-ecran-comparaison.md).
 */
import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import { EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components";
import { Button } from "@/components/ui/button";
import { fr } from "@/i18n/fr";
import { EMPTY, formatDate, formatDuration, formatLiters, formatLocalTime, formatNumber } from "@/lib/format";
import type { IsoDate } from "@/lib/types";
import { cn } from "@/lib/utils";

import { useDashboard, type Dashboard, type DashboardTrip } from "./api";
import { Section } from "./shared";

const t = fr.screens.comparison.dashboard;

function Tile({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: "warning" | "blocking";
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md border bg-card px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "text-xl font-semibold tabular-nums leading-tight",
          tone === "warning" && "text-warning",
          tone === "blocking" && "text-blocking",
        )}
      >
        {value}
      </p>
      {detail && <p className="truncate text-2xs text-muted-foreground">{detail}</p>}
    </div>
  );
}

function Delay({ seconds }: { seconds: number | null }) {
  if (seconds === null) return <span className="text-muted-foreground">{EMPTY}</span>;
  if (Math.abs(seconds) < 60) return <span className="text-success">{t.onTime}</span>;
  if (seconds > 0) {
    return <span className="font-medium tabular-nums text-warning">{t.late(formatDuration(seconds))}</span>;
  }
  return <span className="tabular-nums text-muted-foreground">{t.early(formatDuration(-seconds))}</span>;
}

function Progress({ trip }: { trip: DashboardTrip }) {
  const share = trip.stops_total > 0 ? (trip.stops_delivered / trip.stops_total) * 100 : 0;
  return (
    <div className="flex items-center gap-2">
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={trip.stops_total}
        aria-valuenow={trip.stops_delivered}
        aria-label={t.progressLabel(trip.stops_delivered, trip.stops_total)}
        className="h-2 w-20 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${share}%` }} />
      </div>
      <span className="num">
        {trip.stops_delivered}/{trip.stops_total}
      </span>
    </div>
  );
}

function Content({ data }: { data: Dashboard }) {
  const { summary, trips, delays, alerts } = data;
  const c = t.columns;
  const th = "border-b bg-muted px-2.5 py-1.5 text-left text-xs font-semibold text-foreground/70";
  const td = "border-b px-2.5 py-1";
  const inProgress = summary.trips_by_status.in_progress ?? 0;

  return (
    <>
      {data.plan === null ? (
        <EmptyState
          compact
          title={t.noPlanTitle}
          description={t.noPlanBody}
          className="rounded-md border bg-card"
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5" data-testid="dashboard-tiles">
            <Tile
              label={t.tiles.trips}
              value={t.of(
                formatNumber(summary.trips_by_status.completed ?? 0),
                formatNumber(summary.trips_total),
              )}
              detail={t.inProgress(inProgress)}
            />
            <Tile
              label={t.tiles.stops}
              value={t.of(formatNumber(summary.stops_delivered), formatNumber(summary.stops_total))}
              detail={summary.stops_skipped > 0 ? t.skipped(summary.stops_skipped) : undefined}
            />
            <Tile
              label={t.tiles.volume}
              value={formatLiters(summary.volume_delivered_l)}
              detail={t.of(formatLiters(summary.volume_delivered_l), formatLiters(summary.volume_planned_l))}
            />
            <Tile
              label={t.tiles.late}
              value={formatNumber(summary.trips_late)}
              tone={summary.trips_late > 0 ? "warning" : undefined}
              detail={summary.trips_late > 0 ? t.maxDelay(formatDuration(summary.max_delay_s)) : t.noDelay}
            />
            <Tile
              label={t.tiles.alerts}
              value={formatNumber(summary.alerts_total)}
              tone={summary.alerts_blocking > 0 ? "blocking" : undefined}
              detail={t.blockingAlerts(summary.alerts_blocking)}
            />
          </div>

          <Section id="dashboard-trips" title={t.tripsTitle}>
            <div className="overflow-x-auto rounded-md border bg-card">
              <table
                className="w-full border-separate border-spacing-0 text-sm"
                data-testid="dashboard-trips"
              >
                <caption className="sr-only">{t.tripsCaption}</caption>
                <thead>
                  <tr>
                    <th scope="col" className={th}>
                      {c.trip}
                    </th>
                    <th scope="col" className={th}>
                      {c.truck}
                    </th>
                    <th scope="col" className={th}>
                      {c.driver}
                    </th>
                    <th scope="col" className={th}>
                      {c.status}
                    </th>
                    <th scope="col" className={th}>
                      {c.progress}
                    </th>
                    <th scope="col" className={cn(th, "text-right")}>
                      {c.volume}
                    </th>
                    <th scope="col" className={th}>
                      {c.delay}
                    </th>
                    <th scope="col" className={th}>
                      {c.next}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {trips.map((trip) => (
                    <tr key={trip.trip_id}>
                      <th scope="row" className={cn(td, "num text-left font-medium")}>
                        {fr.screens.comparison.maps.tripShort(trip.seq)}
                      </th>
                      <td className={cn(td, "num whitespace-nowrap")}>{trip.truck_plate ?? EMPTY}</td>
                      <td className={td}>{trip.driver_name ?? EMPTY}</td>
                      <td className={td}>
                        <StatusBadge kind="trip" value={trip.status} />
                      </td>
                      <td className={td}>
                        <Progress trip={trip} />
                      </td>
                      <td className={cn(td, "num whitespace-nowrap text-right")}>
                        {formatLiters(trip.volume_delivered_l)}
                        <span className="text-muted-foreground">
                          {" "}
                          / {formatLiters(trip.volume_planned_l)}
                        </span>
                      </td>
                      <td className={cn(td, "whitespace-nowrap")}>
                        <Delay seconds={trip.delay_s} />
                      </td>
                      <td className={td}>
                        {trip.next_station_name ? (
                          <>
                            {trip.next_station_name}{" "}
                            <span className="text-xs tabular-nums text-muted-foreground">
                              {t.planned(formatLocalTime(trip.next_planned_arrival_at))}
                              {trip.next_estimated_arrival_at &&
                                trip.next_estimated_arrival_at !== trip.next_planned_arrival_at &&
                                ` · ${t.eta(formatLocalTime(trip.next_estimated_arrival_at))}`}
                            </span>
                          </>
                        ) : (
                          <span className="text-muted-foreground">{EMPTY}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Section id="dashboard-alerts" title={t.alertsTitle(alerts.length)}>
          {alerts.length === 0 ? (
            <p className="rounded-md border bg-card px-3 py-3 text-xs text-muted-foreground">
              {t.alertsNone}
            </p>
          ) : (
            <ul className="flex flex-col divide-y rounded-md border bg-card" data-testid="dashboard-alerts">
              {alerts.map((alert, index) => (
                <li
                  key={`${alert.code}-${alert.event_id ?? alert.trip_id ?? ""}-${index}`}
                  className={cn(
                    "flex items-start gap-2 border-l-[3px] px-2.5 py-1.5 text-sm",
                    alert.severity === "blocking" ? "border-l-blocking" : "border-l-warning",
                  )}
                >
                  <StatusBadge kind="severity" value={alert.severity} className="mt-px shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="leading-snug">
                      <span className="num mr-1.5 text-xs font-medium text-foreground/70">{alert.code}</span>
                      {alert.message}
                    </p>
                    <p className="num text-2xs text-muted-foreground">
                      {[
                        alert.trip_seq !== null ? t.alertTrip(alert.trip_seq) : null,
                        alert.occurred_at ? formatLocalTime(alert.occurred_at) : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section id="dashboard-delays" title={t.delaysTitle(delays.length)}>
          {delays.length === 0 ? (
            <p className="rounded-md border bg-card px-3 py-3 text-xs text-muted-foreground">
              {t.delaysNone}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border bg-card">
              <table
                className="w-full border-separate border-spacing-0 text-sm"
                data-testid="dashboard-delays"
              >
                <thead>
                  <tr>
                    <th scope="col" className={th}>
                      {t.delayColumns.trip}
                    </th>
                    <th scope="col" className={th}>
                      {t.delayColumns.station}
                    </th>
                    <th scope="col" className={th}>
                      {t.delayColumns.planned}
                    </th>
                    <th scope="col" className={th}>
                      {t.delayColumns.actual}
                    </th>
                    <th scope="col" className={cn(th, "text-right")}>
                      {t.delayColumns.delay}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {delays.map((delay) => (
                    <tr key={delay.stop_id}>
                      <td className={cn(td, "num whitespace-nowrap")}>
                        {fr.screens.comparison.maps.tripShort(delay.trip_seq)} · {delay.truck_plate ?? EMPTY}
                      </td>
                      <td className={td}>{delay.station_name ?? delay.station_code ?? EMPTY}</td>
                      <td className={cn(td, "num")}>{formatLocalTime(delay.planned_at)}</td>
                      <td className={cn(td, "num")}>{formatLocalTime(delay.actual_at)}</td>
                      <td className={cn(td, "num whitespace-nowrap text-right font-medium text-warning")}>
                        {t.late(formatDuration(delay.delay_s))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>
    </>
  );
}

export function DashboardPanel({ day }: { day: IsoDate }) {
  const query = useDashboard(day);
  return (
    <div className="flex flex-col gap-4" data-testid="dashboard-panel">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight">{t.heading(formatDate(day))}</h2>
          <p className="max-w-3xl text-xs text-muted-foreground">{t.intro}</p>
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {query.data?.plan && <span>{t.plan(query.data.plan.version)}</span>}
          {query.data && (
            <span className="tabular-nums">{t.updated(formatLocalTime(query.data.generated_at))}</span>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw className={cn(query.isFetching && "animate-spin")} />
            {t.refresh}
          </Button>
        </div>
      </div>
      {query.isLoading ? (
        <LoadingState />
      ) : query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data ? (
        <Content data={query.data} />
      ) : null}
    </div>
  );
}
