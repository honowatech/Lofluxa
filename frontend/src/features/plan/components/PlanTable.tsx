/**
 * Vue tableau du plan (F5.1) : toutes les tournées et leurs arrêts, dans l'ordre. Les arrêts se glissent
 * d'une tournée à l'autre, ou se déplacent au clavier (Alt + ↑ / ↓ ; au bord, vers la tournée voisine).
 */
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { memo, useMemo } from "react";

import { StatusBadge } from "@/components";
import { fr } from "@/i18n/fr";
import { formatDuration, formatKm, formatLiters, formatLocalTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import { tripColor, usePlanUi } from "../context";
import { usePlanStore } from "../store";
import type { Plan, PlanViolation, Stop, Trip } from "../types";
import { dropTargetClass, stopDndId, useStopSortable, useTripDroppable } from "./dnd";
import { DeliveryChips, StopMoveMenu, useStopRow, ViolationMarks } from "./stopParts";
import { FillBar, LockButton, ViolationCounts } from "./TripList";

const t = fr.screens.plan;
const COLUMNS = 8;

function TableStop({ trip, stop, violations }: { trip: Trip; stop: Stop; violations: PlanViolation[] }) {
  const { canEdit } = usePlanUi();
  const sortable = useStopSortable("table", trip, stop);
  const row = useStopRow("table", trip, stop);
  const name = stop.station_name ?? stop.station_code ?? "";
  return (
    <tr
      ref={(node) => {
        sortable.setNodeRef(node);
        row.ref.current = node;
      }}
      style={sortable.style}
      {...row.rowProps}
      aria-label={t.stops.stop(stop.seq, name)}
      aria-selected={row.selected}
      className={cn(
        "border-b outline-none hover:bg-muted/50 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        row.selected && "bg-accent",
        sortable.isDragging && "opacity-40",
        sortable.insertHere && "shadow-[inset_0_2px_0_0_hsl(var(--primary))]",
      )}
    >
      <td className="w-7 py-0.5 pl-1.5">{canEdit && sortable.handle}</td>
      <td className="num w-8 px-1 text-right text-muted-foreground">{stop.seq}</td>
      <td className="px-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="num shrink-0 text-xs text-muted-foreground">{stop.station_code}</span>
          <span className="truncate font-medium">{name}</span>
          <ViolationMarks violations={violations} />
          {stop.status !== "pending" && <StatusBadge kind="stop" value={stop.status} />}
        </span>
      </td>
      <td className="num px-2">{formatLocalTime(stop.planned_arrival_at)}</td>
      <td className="num px-2 text-muted-foreground">{formatLocalTime(stop.planned_departure_at)}</td>
      <td className="px-2">
        <DeliveryChips deliveries={stop.deliveries} />
      </td>
      <td className="num px-2 text-right">{formatLiters(stop.planned_l)}</td>
      <td className="px-2 text-right">
        <span className="flex items-center justify-end gap-1">
          <span className="num text-muted-foreground">{formatKm(stop.distance_from_prev_m)}</span>
          {row.movable ? (
            <StopMoveMenu trip={trip} stop={stop} onMove={row.move} onMoveToTrip={row.moveToTrip} />
          ) : (
            <span className="size-6" />
          )}
        </span>
      </td>
    </tr>
  );
}

const TripSection = memo(function TripSection({
  trip,
  violations,
  selected,
}: {
  trip: Trip;
  violations: Map<string, PlanViolation[]>;
  selected: boolean;
}) {
  const { setNodeRef, isTarget, accepts } = useTripDroppable(trip, "table");
  const ids = trip.stops.map((stop) => stopDndId("table", stop.id));
  return (
    <tbody ref={setNodeRef} className={cn(dropTargetClass(isTarget, accepts))} data-trip-section={trip.id}>
      <tr className={cn("border-b bg-muted/50", selected && "bg-accent")}>
        <th colSpan={COLUMNS} scope="rowgroup" className="p-0 text-left font-normal">
          <div className="flex items-center gap-2 py-1 pl-0 pr-1.5">
            <span className="h-6 w-1 shrink-0" style={{ backgroundColor: tripColor(trip) }} aria-hidden />
            <button
              type="button"
              onClick={() => usePlanStore.getState().selectTrip(trip.id)}
              className="flex min-w-0 items-center gap-2 rounded-sm text-left focus-ring"
              aria-pressed={selected}
            >
              <span
                className="num rounded-sm px-1 text-xs font-semibold text-white"
                style={{ backgroundColor: tripColor(trip) }}
              >
                {t.trips.tripShort(trip.seq)}
              </span>
              <span className="sr-only">{t.trips.trip(trip.seq)}</span>
              <span className="num text-sm font-semibold">{trip.truck_plate}</span>
              <span className={cn("truncate text-xs", !trip.driver_name && "text-blocking")}>
                {trip.driver_name ?? t.trips.noDriver}
              </span>
            </button>
            {trip.status !== "planned" && <StatusBadge kind="trip" value={trip.status} />}
            <ViolationCounts trip={trip} />
            <span className="ml-auto flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
              <span className="num">
                {t.trips.schedule(
                  formatLocalTime(trip.planned_depart_at),
                  formatLocalTime(trip.planned_return_at),
                )}
              </span>
              <span className="num">{formatKm(trip.distance_m)}</span>
              <span className="num">{formatDuration(trip.duration_s)}</span>
              <FillBar rate={trip.fill_rate} className="text-foreground" />
            </span>
            <LockButton trip={trip} />
          </div>
        </th>
      </tr>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {trip.stops.map((stop) => (
          <TableStop key={stop.id} trip={trip} stop={stop} violations={violations.get(stop.id) ?? EMPTY} />
        ))}
      </SortableContext>
    </tbody>
  );
});

const EMPTY: PlanViolation[] = [];

export function PlanTable({ plan, className }: { plan: Plan; className?: string }) {
  const { canEdit } = usePlanUi();
  const selectedTripId = usePlanStore((state) => state.selectedTripId);
  const pending = usePlanStore((state) => state.pendingOp !== null);
  const byStop = useMemo(() => {
    const map = new Map<string, PlanViolation[]>();
    for (const violation of plan.violations) {
      if (!violation.stop_id) continue;
      map.set(violation.stop_id, [...(map.get(violation.stop_id) ?? []), violation]);
    }
    return map;
  }, [plan.violations]);

  return (
    <section
      aria-label={t.table.caption}
      className={cn("flex min-h-0 flex-col overflow-hidden rounded-md border bg-card", className)}
    >
      <div className="min-h-0 flex-1 overflow-auto" data-stop-zone="table" aria-busy={pending}>
        <table className={cn("w-full table-fixed border-collapse text-sm", pending && "[&_.num]:opacity-70")}>
          <caption className="sr-only">{t.table.caption}</caption>
          <thead className="sticky top-0 z-10 bg-card shadow-[0_1px_0_0_hsl(var(--border))]">
            <tr className="text-left text-xs uppercase tracking-wide text-foreground/70">
              <th scope="col" className="w-7" />
              <th scope="col" className="w-8 px-1 py-1.5 text-right font-semibold">
                {t.table.seq}
              </th>
              <th scope="col" className="w-[28%] px-2 font-semibold">
                {t.table.station}
              </th>
              <th scope="col" className="w-16 px-2 font-semibold">
                {t.table.arrival}
              </th>
              <th scope="col" className="w-16 px-2 font-semibold">
                {t.table.departure}
              </th>
              <th scope="col" className="px-2 font-semibold">
                {t.table.deliveries}
              </th>
              <th scope="col" className="w-24 px-2 text-right font-semibold">
                {t.table.volume}
              </th>
              <th scope="col" className="w-32 px-2 text-right font-semibold">
                {t.table.distance}
              </th>
            </tr>
          </thead>
          {plan.trips.map((trip) => (
            <TripSection
              key={trip.id}
              trip={trip}
              violations={byStop}
              selected={trip.id === selectedTripId}
            />
          ))}
        </table>
      </div>
      {canEdit && <p className="border-t px-3 py-1 text-2xs text-muted-foreground">{t.table.hint}</p>}
    </section>
  );
}
