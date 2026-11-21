/**
 * Les deux cartes côte à côte (F8.5) : même cadrage et même échelle, tracés des tournées de chaque plan,
 * liste des tournées sous chaque carte (survol = mise en évidence, sélection = détail des arrêts) et
 * commandes non servies.
 *
 * Cadrage commun : `MapView` cadre sur son contenu ; les deux cartes reçoivent donc les mêmes marqueurs
 * (dépôts et stations des deux plans réunis), seules les tournées diffèrent.
 */
import { ChevronDown, ChevronRight } from "lucide-react";
import { Fragment, useMemo, useState } from "react";

import { MapView, routeColor, StatusBadge, type MapPoint, type MapRoute } from "@/components";
import { fr } from "@/i18n/fr";
import { EMPTY, formatDuration, formatKm, formatLiters, formatLocalTime, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

import {
  SIDE_LABEL,
  type Comparison,
  type PlanSummary,
  type Side,
  type TripRoute,
  type Unserved,
} from "./api";
import { Section, SideChip } from "./shared";

const t = fr.screens.comparison.maps;
const kinds = fr.screens.comparison.kinds;

const pointId = (kind: string, code: string) => `${kind}:${code}`;

/** Dépôts et stations des deux plans, sans doublon : mêmes marqueurs donc même emprise des deux côtés. */
export function sharedPoints(routesA: TripRoute[], routesB: TripRoute[]): MapPoint[] {
  const points = new Map<string, MapPoint>();
  for (const route of [...routesA, ...routesB]) {
    for (const point of route.points) {
      const id = pointId(point.kind, point.code);
      if (points.has(id)) continue;
      points.set(id, {
        id,
        kind: point.kind === "depot" ? "depot" : "station",
        lat: point.lat,
        lon: point.lon,
        label: point.name,
        detail: [point.code],
      });
    }
  }
  return [...points.values()];
}

const deliveriesText = (stop: TripRoute["stops"][number]) =>
  stop.deliveries
    .map((delivery) => `${delivery.product_code ?? EMPTY} ${formatLiters(delivery.planned_l)}`)
    .join(" · ");

function toMapRoute(route: TripRoute, index: number, active: string | null): MapRoute {
  const stopBySeq = new Map(route.stops.map((stop) => [stop.seq, stop]));
  return {
    id: route.trip_id,
    color: routeColor(index),
    label: t.trip(route.seq),
    dimmed: active !== null && active !== route.trip_id,
    path: route.points.map((point) => ({ lat: point.lat, lon: point.lon })),
    stops: route.points
      .filter((point) => point.kind !== "depot" && point.seq !== null)
      .map((point) => {
        const stop = stopBySeq.get(point.seq as number);
        return {
          id: stop?.stop_id ?? `${route.trip_id}:${point.seq}`,
          seq: point.seq as number,
          lat: point.lat,
          lon: point.lon,
          label: point.name,
          detail: [
            `${t.trip(route.seq)} · ${route.truck_plate ?? EMPTY}`,
            ...(stop ? [t.stopDetail(formatLocalTime(stop.planned_arrival_at), deliveriesText(stop))] : []),
          ],
        };
      }),
  };
}

function TripDetail({ route }: { route: TripRoute }) {
  const d = t.detail;
  const hasActual = route.stops.some((stop) => stop.actual_arrival_at !== null);
  const th = "px-2 py-0.5 text-left text-2xs font-semibold uppercase tracking-wide text-foreground/60";
  return (
    <div className="flex flex-col gap-1.5 border-l-2 border-foreground/15 py-1 pl-2.5">
      <p className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
        <span>{d.depot(route.depot_code ?? EMPTY)}</span>
        <span>
          {d.depart} <span className="num text-foreground">{formatLocalTime(route.planned_depart_at)}</span>
        </span>
        <span>
          {d.back} <span className="num text-foreground">{formatLocalTime(route.planned_return_at)}</span>
        </span>
        {route.actual_distance_m !== null && (
          <span>
            {d.actualDistance}{" "}
            <span className="num text-foreground">{formatKm(route.actual_distance_m)}</span>
          </span>
        )}
        <StatusBadge kind="trip" value={route.status} />
      </p>
      <table className="w-full border-separate border-spacing-0 text-xs">
        <caption className="sr-only">{d.title(route.seq)}</caption>
        <thead>
          <tr>
            <th scope="col" className={cn(th, "w-8 text-right")}>
              {d.stop}
            </th>
            <th scope="col" className={th}>
              {d.station}
            </th>
            <th scope="col" className={th}>
              {d.arrival}
            </th>
            {hasActual && (
              <th scope="col" className={th}>
                {d.actualArrival}
              </th>
            )}
            <th scope="col" className={th}>
              {d.deliveries}
            </th>
            <th scope="col" className={cn(th, "text-right")}>
              {d.leg}
            </th>
          </tr>
        </thead>
        <tbody>
          {route.stops.map((stop) => (
            <tr key={stop.stop_id}>
              <td className="num px-2 py-0.5 text-right">{stop.seq}</td>
              <td className="px-2 py-0.5">
                {stop.station_name ?? EMPTY}{" "}
                <span className="num text-2xs text-muted-foreground">{stop.station_code}</span>
              </td>
              <td className="num px-2 py-0.5">{formatLocalTime(stop.planned_arrival_at)}</td>
              {hasActual && <td className="num px-2 py-0.5">{formatLocalTime(stop.actual_arrival_at)}</td>}
              <td className="num px-2 py-0.5">{deliveriesText(stop)}</td>
              <td className="num px-2 py-0.5 text-right">{formatKm(stop.distance_from_prev_m)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UnservedList({ rows }: { rows: Unserved[] }) {
  const c = t.unservedColumns;
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">{t.unservedNone}</p>;
  }
  const th = "border-b px-2 py-1 text-left text-xs font-semibold text-foreground/70";
  return (
    <div className="overflow-x-auto rounded-md border border-warning/35 bg-card">
      <table className="w-full border-separate border-spacing-0 text-xs">
        <caption className="border-b bg-warning-soft px-2 py-1 text-left text-xs font-semibold text-warning">
          {t.unservedTitle(rows.length)}
        </caption>
        <thead>
          <tr>
            <th scope="col" className={th}>
              {c.station}
            </th>
            <th scope="col" className={th}>
              {c.product}
            </th>
            <th scope="col" className={cn(th, "text-right")}>
              {c.volume}
            </th>
            <th scope="col" className={th}>
              {c.reason}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.order_id}>
              <td className="px-2 py-1">
                {row.station_name ?? EMPTY}{" "}
                <span className="num text-2xs text-muted-foreground">{row.station_code}</span>
              </td>
              <td className="num px-2 py-1">{row.product_code ?? EMPTY}</td>
              <td className="num px-2 py-1 text-right">{formatLiters(row.requested_l)}</td>
              <td className="px-2 py-1">
                {row.reason_text ??
                  (fr.status.unserved as Record<string, string>)[row.reason_code] ??
                  row.reason_code}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PlanMap({
  side,
  plan,
  routes,
  unserved,
  points,
}: {
  side: Side;
  plan: PlanSummary;
  routes: TripRoute[];
  unserved: Unserved[];
  points: MapPoint[];
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const selectedRoute = routes.find((route) => route.trip_id === selected) ?? null;
  const active = hovered ?? selectedRoute?.trip_id ?? null;
  const mapRoutes = useMemo(
    () => routes.map((route, index) => toMapRoute(route, index, active)),
    [routes, active],
  );
  const toggle = (tripId: string) => setSelected((current) => (current === tripId ? null : tripId));
  const c = t.columns;
  const th = "border-b bg-muted px-2 py-1 text-xs font-semibold text-foreground/70";
  const label = SIDE_LABEL[side];

  return (
    <article className="flex min-w-0 flex-col gap-2" data-testid={`plan-${side}`} aria-label={plan.title}>
      <header className="flex min-w-0 items-center gap-2">
        <SideChip side={side} />
        <h3 className="min-w-0 truncate text-sm font-semibold" title={plan.title}>
          {plan.title}
        </h3>
        <span className="shrink-0 text-xs text-muted-foreground">
          {kinds[plan.kind]} · {t.trips(routes.length)}
        </span>
      </header>

      <MapView
        className="h-[340px]"
        label={t.mapLabel(label)}
        points={points}
        routes={mapRoutes}
        onSelect={(id, kind) => {
          if (kind !== "stop") return;
          const owner = routes.find((route) => route.stops.some((stop) => stop.stop_id === id));
          if (owner) toggle(owner.trip_id);
        }}
      />

      {routes.length === 0 ? (
        <p className="rounded-md border bg-card px-3 py-4 text-center text-xs text-muted-foreground">
          {t.noTrips}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border bg-card">
          <table className="w-full border-separate border-spacing-0 text-xs">
            <caption className="sr-only">{t.tripsCaption(label)}</caption>
            <thead>
              <tr>
                <th scope="col" className={cn(th, "text-left")}>
                  {c.trip}
                </th>
                <th scope="col" className={cn(th, "text-left")}>
                  {c.truck}
                </th>
                <th scope="col" className={cn(th, "text-left")}>
                  {c.driver}
                </th>
                <th scope="col" className={cn(th, "text-right")}>
                  {c.stops}
                </th>
                <th scope="col" className={cn(th, "text-right")}>
                  {c.volume}
                </th>
                <th scope="col" className={cn(th, "text-right")}>
                  {c.distance}
                </th>
                <th scope="col" className={cn(th, "text-right")}>
                  {c.duration}
                </th>
                <th scope="col" className={cn(th, "text-right")}>
                  {c.fill}
                </th>
              </tr>
            </thead>
            <tbody>
              {routes.map((route, index) => {
                const open = selected === route.trip_id;
                return (
                  <Fragment key={route.trip_id}>
                    <tr
                      data-trip={route.trip_id}
                      data-active={active === route.trip_id || undefined}
                      onMouseEnter={() => setHovered(route.trip_id)}
                      onMouseLeave={() => setHovered(null)}
                      onClick={() => toggle(route.trip_id)}
                      className={cn(
                        "cursor-pointer",
                        active === route.trip_id ? "bg-accent" : "hover:bg-muted/60",
                      )}
                    >
                      <th scope="row" className="border-b px-2 py-1 text-left font-medium">
                        <button
                          type="button"
                          aria-expanded={open}
                          aria-label={t.trip(route.seq)}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggle(route.trip_id);
                          }}
                          onFocus={() => setHovered(route.trip_id)}
                          onBlur={() => setHovered(null)}
                          className="focus-ring flex items-center gap-1.5 rounded-sm"
                        >
                          {open ? (
                            <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
                          ) : (
                            <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />
                          )}
                          <span
                            aria-hidden
                            className="size-2.5 rounded-full"
                            style={{ background: routeColor(index) }}
                          />
                          <span className="num">{t.tripShort(route.seq)}</span>
                        </button>
                      </th>
                      <td className="num whitespace-nowrap border-b px-2 py-1">
                        {route.truck_plate ?? EMPTY}
                      </td>
                      <td className="border-b px-2 py-1">
                        {route.driver_name ?? <span className="text-muted-foreground">{t.noDriver}</span>}
                      </td>
                      <td className="num border-b px-2 py-1 text-right">{route.stops.length}</td>
                      <td className="num whitespace-nowrap border-b px-2 py-1 text-right">
                        {formatLiters(route.volume_planned_l)}
                      </td>
                      <td className="num whitespace-nowrap border-b px-2 py-1 text-right">
                        {formatKm(route.distance_m)}
                      </td>
                      <td className="num whitespace-nowrap border-b px-2 py-1 text-right">
                        {formatDuration(route.duration_s)}
                      </td>
                      <td className="num whitespace-nowrap border-b px-2 py-1 text-right">
                        {formatPercent(route.fill_rate_pct)}
                      </td>
                    </tr>
                    {open && (
                      <tr data-testid="trip-detail">
                        <td colSpan={8} className="border-b bg-muted/30 px-2 py-1.5">
                          <TripDetail route={route} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <UnservedList rows={unserved} />
    </article>
  );
}

export function RouteMaps({ comparison }: { comparison: Comparison }) {
  const points = useMemo(
    () => sharedPoints(comparison.routes_a, comparison.routes_b),
    [comparison.routes_a, comparison.routes_b],
  );
  return (
    <Section id="maps-heading" title={t.heading} hint={t.hint}>
      <div className="grid gap-4 xl:grid-cols-2">
        <PlanMap
          side="a"
          plan={comparison.plan_a}
          routes={comparison.routes_a}
          unserved={comparison.unserved_a}
          points={points}
        />
        <PlanMap
          side="b"
          plan={comparison.plan_b}
          routes={comparison.routes_b}
          unserved={comparison.unserved_b}
          points={points}
        />
      </div>
    </Section>
  );
}
