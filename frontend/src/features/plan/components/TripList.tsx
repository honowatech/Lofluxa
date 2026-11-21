/** Panneau gauche : liste des tournées (camion, chauffeur, km, durée, remplissage, violations, cadenas, statut). */
import { CircleAlert, Lock, LockOpen, TriangleAlert } from "lucide-react";
import { memo, useCallback, type KeyboardEvent } from "react";

import { StatusBadge, Tip } from "@/components";
import { fr } from "@/i18n/fr";
import { formatDuration, formatKm, formatLocalTime, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

import { tripColor, usePlanUi } from "../context";
import { usePlanStore } from "../store";
import type { Trip } from "../types";
import { dropTargetClass, useTripDroppable } from "./dnd";

const t = fr.screens.plan;

export function FillBar({ rate, className }: { rate: number | null | undefined; className?: string }) {
  const percent = rate === null || rate === undefined ? null : Math.round(rate * 100);
  return (
    <span className={cn("flex items-center gap-1.5", className)} title={t.trips.fill}>
      <span className="relative h-1.5 w-14 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span
          className={cn(
            "absolute inset-y-0 left-0 rounded-full",
            (percent ?? 0) > 100 ? "bg-blocking" : "bg-primary",
          )}
          style={{ width: `${Math.min(100, percent ?? 0)}%` }}
        />
      </span>
      <span className="num text-xs">
        <span className="sr-only">{t.trips.fill} </span>
        {formatPercent(percent)}
      </span>
    </span>
  );
}

export function ViolationCounts({ trip }: { trip: Pick<Trip, "blocking_count" | "warning_count"> }) {
  return (
    <span className="flex items-center gap-1">
      {trip.blocking_count > 0 && (
        <span
          className="num flex items-center gap-0.5 rounded-sm bg-blocking px-1 text-xs font-medium text-white"
          title={t.trips.blocking(trip.blocking_count)}
        >
          <CircleAlert className="size-3" aria-hidden />
          {trip.blocking_count}
          <span className="sr-only">{t.trips.blocking(trip.blocking_count)}</span>
        </span>
      )}
      {trip.warning_count > 0 && (
        <span
          className="num flex items-center gap-0.5 rounded-sm bg-warning px-1 text-xs font-medium text-white"
          title={t.trips.warnings(trip.warning_count)}
        >
          <TriangleAlert className="size-3" aria-hidden />
          {trip.warning_count}
          <span className="sr-only">{t.trips.warnings(trip.warning_count)}</span>
        </span>
      )}
    </span>
  );
}

export function LockButton({ trip, className }: { trip: Trip; className?: string }) {
  const { canEdit, edit, busy } = usePlanUi();
  const Icon = trip.locked ? Lock : LockOpen;
  if (!canEdit) {
    return trip.locked ? (
      <span className={cn("grid size-6 place-items-center text-signal", className)} title={t.trips.locked}>
        <Lock className="size-3.5" aria-hidden />
        <span className="sr-only">{t.trips.locked}</span>
      </span>
    ) : null;
  }
  const label = trip.locked ? t.trips.unlock(trip.seq) : t.trips.lock(trip.seq);
  return (
    <Tip label={trip.locked ? t.trips.locked : t.trips.lockShort}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={trip.locked}
        disabled={busy}
        onClick={(event) => {
          event.stopPropagation();
          void edit({ type: "lock", tripId: trip.id, locked: !trip.locked });
        }}
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-sm focus-ring hover:bg-muted disabled:opacity-50",
          trip.locked ? "bg-signal/15 text-signal" : "text-muted-foreground/70",
          className,
        )}
      >
        <Icon className="size-3.5" aria-hidden />
      </button>
    </Tip>
  );
}

const TripCard = memo(function TripCard({
  trip,
  selected,
  hovered,
}: {
  trip: Trip;
  selected: boolean;
  hovered: boolean;
}) {
  const { setNodeRef, isTarget, accepts } = useTripDroppable(trip, "list");
  return (
    <li
      ref={setNodeRef}
      data-trip-card={trip.id}
      data-selected={selected || undefined}
      data-hovered={hovered || undefined}
      title={accepts ? t.trips.dropHere : undefined}
      className={cn(
        "relative flex gap-2 border-b py-1.5 pl-3 pr-1.5 hover:bg-muted/60",
        hovered && !selected && "bg-muted",
        selected && "bg-accent hover:bg-accent",
        dropTargetClass(isTarget, accepts),
      )}
    >
      <span
        className="absolute inset-y-0 left-0 w-1"
        style={{ backgroundColor: tripColor(trip) }}
        aria-hidden
      />
      <button
        type="button"
        data-trip-button
        aria-pressed={selected}
        aria-label={t.trips.select(trip.seq)}
        onClick={() => usePlanStore.getState().selectTrip(selected ? null : trip.id)}
        className="absolute inset-0 rounded-sm focus-ring"
      />
      <div className="pointer-events-none relative min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className="num rounded-sm px-1 text-xs font-semibold text-white"
            style={{ backgroundColor: tripColor(trip) }}
          >
            {t.trips.tripShort(trip.seq)}
          </span>
          <span className="num truncate text-sm font-semibold">{trip.truck_plate}</span>
          {trip.status !== "planned" && <StatusBadge kind="trip" value={trip.status} />}
          <span className="ml-auto">
            <ViolationCounts trip={trip} />
          </span>
        </div>
        <div className={cn("truncate text-xs", trip.driver_name ? "text-foreground/80" : "text-blocking")}>
          {trip.driver_name ?? t.trips.noDriver}
        </div>
        <div className="mt-0.5 flex items-center gap-x-2 text-xs text-muted-foreground">
          <span className="num">
            {t.trips.schedule(
              formatLocalTime(trip.planned_depart_at),
              formatLocalTime(trip.planned_return_at),
            )}
          </span>
          <span className="num">{formatKm(trip.distance_m)}</span>
          <span className="num">{formatDuration(trip.duration_s)}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          <FillBar rate={trip.fill_rate} className="text-foreground" />
          <span>{t.trips.stops(trip.stops.length)}</span>
        </div>
      </div>
      <LockButton trip={trip} className="relative self-start" />
    </li>
  );
});

export function TripList({ trips, className }: { trips: Trip[]; className?: string }) {
  const selectedTripId = usePlanStore((state) => state.selectedTripId);
  const hoveredTripId = usePlanStore((state) => state.hoveredTripId);
  const pending = usePlanStore((state) => state.pendingOp !== null);

  // ↑ / ↓ : tournée précédente / suivante ; Début / Fin : première / dernière.
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLUListElement>) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-trip-button]"));
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
    buttons[next]?.focus();
  }, []);

  return (
    <section
      aria-label={t.trips.listLabel}
      className={cn("flex min-h-0 flex-col overflow-hidden rounded-md border bg-card", className)}
    >
      <header className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-foreground/70">{t.trips.title}</h2>
        <span className="num ml-auto text-xs text-muted-foreground">{trips.length}</span>
      </header>
      <ul
        className={cn("min-h-0 flex-1 overflow-y-auto", pending && "[&_.num]:opacity-70")}
        aria-busy={pending}
        onKeyDown={onKeyDown}
      >
        {trips.map((trip) => (
          <TripCard
            key={trip.id}
            trip={trip}
            selected={trip.id === selectedTripId}
            hovered={trip.id === hoveredTripId}
          />
        ))}
      </ul>
    </section>
  );
}
