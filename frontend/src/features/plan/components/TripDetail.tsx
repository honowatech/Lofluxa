/**
 * Panneau droit : détail de la tournée sélectionnée — affectation (camion, chauffeur), horaires, arrêts
 * réordonnables avec heures estimées et livraisons par produit, plan de chargement par compartiment.
 */
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { MousePointerClick } from "lucide-react";
import { useId, useMemo } from "react";

import { EmptyState, PdfButton, StatusBadge } from "@/components";
import { NativeSelect } from "@/components/ui/input";
import { fr } from "@/i18n/fr";
import { formatDuration, formatKm, formatLiters, formatLocalTime, formatPercent } from "@/lib/format";
import { useDay } from "@/lib/useDay";
import { cn } from "@/lib/utils";

import { useDriverDays, useTruckDays } from "../api";
import { tripColor, usePlanUi } from "../context";
import { isTripEditable } from "../edits";
import { usePlanStore } from "../store";
import type { Load, PlanViolation, Stop, Trip } from "../types";
import { dropTargetClass, stopDndId, useStopSortable, useTripDroppable } from "./dnd";
import { DeliveryChips, StopMoveMenu, useStopRow, ViolationMarks } from "./stopParts";
import { LockButton } from "./TripList";

const t = fr.screens.plan;

function DetailStop({ trip, stop, violations }: { trip: Trip; stop: Stop; violations: PlanViolation[] }) {
  const { canEdit } = usePlanUi();
  const sortable = useStopSortable("detail", trip, stop);
  const row = useStopRow("detail", trip, stop);
  const name = stop.station_name ?? stop.station_code ?? "";
  return (
    <li
      ref={(node) => {
        sortable.setNodeRef(node);
        row.ref.current = node;
      }}
      style={sortable.style}
      {...row.rowProps}
      aria-label={t.stops.stop(stop.seq, name)}
      aria-current={row.selected || undefined}
      className={cn(
        "group flex items-start gap-1 border-b px-1.5 py-1.5 outline-none last:border-b-0 hover:bg-muted/50 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        row.selected && "bg-accent",
        sortable.isDragging && "opacity-40",
        sortable.insertHere && "shadow-[inset_0_2px_0_0_hsl(var(--primary))]",
      )}
    >
      {canEdit && sortable.handle}
      <span
        className="num mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-2xs font-semibold text-white"
        style={{ backgroundColor: tripColor(trip) }}
        aria-hidden
      >
        {stop.seq}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{name}</span>
          <span className="num shrink-0 text-xs text-muted-foreground">{stop.station_code}</span>
          <ViolationMarks violations={violations} />
          {stop.status !== "pending" && <StatusBadge kind="stop" value={stop.status} />}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="num font-medium text-foreground">
            {t.stops.window(
              formatLocalTime(stop.planned_arrival_at),
              formatLocalTime(stop.planned_departure_at),
            )}
          </span>
          <span className="num">{t.stops.fromPrevious(formatKm(stop.distance_from_prev_m))}</span>
        </div>
        <DeliveryChips deliveries={stop.deliveries} className="mt-0.5" />
      </div>
      {row.movable && (
        <StopMoveMenu trip={trip} stop={stop} onMove={row.move} onMoveToTrip={row.moveToTrip} />
      )}
    </li>
  );
}

/** Plan de chargement : une jauge par compartiment, à la couleur du produit. */
export function LoadPlan({ trip, pending }: { trip: Trip; pending: boolean }) {
  const loads = useMemo(
    () => [...trip.loads].sort((a, b) => (a.compartment_position ?? 0) - (b.compartment_position ?? 0)),
    [trip.loads],
  );
  if (loads.length === 0) {
    return (
      <p className={cn("px-3 py-2 text-xs", pending ? "text-muted-foreground" : "text-blocking")}>
        {pending ? t.detail.loadsPending : t.detail.noLoads}
      </p>
    );
  }
  const usedCapacity = loads.reduce((sum, load) => sum + (load.capacity_l ?? 0), 0);
  const unused = (trip.truck_capacity_l ?? 0) - usedCapacity;
  return (
    <div className="px-3 py-2">
      <ul className="flex flex-col gap-1.5">
        {loads.map((load) => (
          <CompartmentGauge key={load.id} load={load} />
        ))}
      </ul>
      {unused > 0.5 && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t.detail.unusedCapacity(formatLiters(unused))}
        </p>
      )}
    </div>
  );
}

function CompartmentGauge({ load }: { load: Load }) {
  const ratio = load.capacity_l ? load.planned_l / load.capacity_l : 0;
  const over = ratio > 1;
  return (
    <li
      className="text-xs"
      aria-label={t.detail.compartmentLabel(
        load.compartment_position,
        load.product_label ?? load.product_code ?? "",
        formatLiters(load.planned_l),
        formatLiters(load.capacity_l),
      )}
    >
      <div className="flex items-baseline gap-2">
        <span className="num w-6 shrink-0 font-semibold text-foreground/70">
          {t.detail.compartment(load.compartment_position)}
        </span>
        <span className="min-w-0 flex-1 truncate" title={load.product_label ?? undefined}>
          {load.product_label ?? load.product_code}
        </span>
        <span className="num shrink-0">
          {formatLiters(load.planned_l)}
          <span className="text-muted-foreground"> / {formatLiters(load.capacity_l)}</span>
        </span>
        <span
          className={cn(
            "num w-10 shrink-0 text-right",
            over ? "font-semibold text-blocking" : "text-muted-foreground",
          )}
        >
          {formatPercent(ratio * 100)}
        </span>
      </div>
      <div
        className={cn(
          "relative ml-8 mt-0.5 h-2 overflow-hidden rounded-sm border bg-muted",
          over && "border-blocking",
        )}
        aria-hidden
      >
        <span
          className="absolute inset-y-0 left-0"
          style={{
            width: `${Math.min(100, ratio * 100)}%`,
            backgroundColor: load.product_color ?? "hsl(var(--primary))",
            opacity: 0.85,
          }}
        />
      </div>
    </li>
  );
}

function Assignment({ trip }: { trip: Trip }) {
  const { canEdit, edit, busy } = usePlanUi();
  const { day } = useDay();
  const editable = canEdit && isTripEditable(trip);
  const trucks = useTruckDays(day, editable);
  const drivers = useDriverDays(day, editable);
  const truckId = useId();
  const driverId = useId();

  if (!editable) {
    return (
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 px-3 py-2 text-sm">
        <dt className="text-xs text-muted-foreground">{t.detail.truck}</dt>
        <dd className="num font-medium">
          {trip.truck_plate}
          {trip.truck_size && (
            <span className="ml-2 font-sans text-xs font-normal text-muted-foreground">
              {t.detail.sizes[trip.truck_size]} · {formatLiters(trip.truck_capacity_l)}
            </span>
          )}
        </dd>
        <dt className="text-xs text-muted-foreground">{t.detail.driver}</dt>
        <dd className={cn(!trip.driver_name && "text-blocking")}>{trip.driver_name ?? t.trips.noDriver}</dd>
      </dl>
    );
  }

  const truckOptions = trucks.data ?? [];
  const driverOptions = drivers.data ?? [];
  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1 px-3 py-2">
      <label htmlFor={truckId} className="text-xs text-muted-foreground">
        {t.detail.truck}
      </label>
      <NativeSelect
        id={truckId}
        className="h-7 min-w-0 py-0 text-sm"
        value={trip.truck_id}
        disabled={busy}
        onChange={(event) => {
          const truck = truckOptions.find((option) => option.truck_id === event.target.value);
          if (!truck) return;
          void edit({
            type: "assign",
            tripId: trip.id,
            truck: {
              id: truck.truck_id,
              plate: truck.plate,
              size: truck.size,
              capacity_l: truck.total_capacity_l,
            },
          });
        }}
      >
        {!truckOptions.some((option) => option.truck_id === trip.truck_id) && (
          <option value={trip.truck_id}>
            {trip.truck_plate}
            {trucks.data ? t.detail.outOfList : ""}
          </option>
        )}
        {truckOptions.map((option) => (
          <option key={option.truck_id} value={option.truck_id}>
            {t.detail.truckOption(option.plate, formatLiters(option.total_capacity_l))}
            {option.assignable ? "" : t.detail.notAssignable(option.block_reason)}
          </option>
        ))}
      </NativeSelect>
      <label htmlFor={driverId} className="text-xs text-muted-foreground">
        {t.detail.driver}
      </label>
      <NativeSelect
        id={driverId}
        className={cn("h-7 min-w-0 py-0 text-sm", !trip.driver_id && "border-blocking text-blocking")}
        value={trip.driver_id ?? ""}
        disabled={busy}
        onChange={(event) => {
          const driver = driverOptions.find((option) => option.driver_id === event.target.value);
          void edit({
            type: "assign",
            tripId: trip.id,
            driver: driver ? { id: driver.driver_id, name: driver.full_name, phone: driver.phone } : null,
          });
        }}
      >
        <option value="">{t.detail.noDriverOption}</option>
        {trip.driver_id && !driverOptions.some((option) => option.driver_id === trip.driver_id) && (
          <option value={trip.driver_id}>
            {trip.driver_name}
            {drivers.data ? t.detail.outOfList : ""}
          </option>
        )}
        {driverOptions.map((option) => (
          <option key={option.driver_id} value={option.driver_id}>
            {option.full_name}
            {option.assignable ? "" : t.detail.notAssignable(option.block_reason)}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-2xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="num whitespace-nowrap text-sm font-medium">
        {value}
        {sub && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{sub}</span>}
      </dd>
    </div>
  );
}

export function TripDetail({ className }: { className?: string }) {
  const trip = usePlanStore((state) => state.plan?.trips.find((x) => x.id === state.selectedTripId));
  const violations = usePlanStore((state) => state.plan?.violations);
  const pending = usePlanStore((state) => state.pendingOp !== null);
  const { canEdit, showRouteSheets } = usePlanUi();

  return (
    <section
      aria-label={t.detail.title}
      className={cn("flex min-h-0 flex-col overflow-hidden rounded-md border bg-card", className)}
    >
      {trip ? (
        <TripDetailBody
          trip={trip}
          violations={violations ?? []}
          pending={pending}
          canEdit={canEdit}
          showRouteSheets={showRouteSheets}
        />
      ) : (
        <EmptyState
          compact
          className="m-auto"
          icon={<MousePointerClick className="size-6 text-muted-foreground/60" aria-hidden />}
          title={t.detail.none}
          description={t.detail.noneHint}
        />
      )}
    </section>
  );
}

function TripDetailBody({
  trip,
  violations,
  pending,
  canEdit,
  showRouteSheets,
}: {
  trip: Trip;
  violations: PlanViolation[];
  pending: boolean;
  canEdit: boolean;
  showRouteSheets: boolean;
}) {
  const { setNodeRef, isTarget, accepts } = useTripDroppable(trip, "detail");
  const ids = trip.stops.map((stop) => stopDndId("detail", stop.id));
  const byStop = useMemo(() => {
    const map = new Map<string, PlanViolation[]>();
    for (const violation of violations) {
      if (!violation.stop_id) continue;
      map.set(violation.stop_id, [...(map.get(violation.stop_id) ?? []), violation]);
    }
    return map;
  }, [violations]);

  return (
    <>
      <header className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5">
        <span
          className="num rounded-sm px-1.5 text-xs font-semibold text-white"
          style={{ backgroundColor: tripColor(trip) }}
        >
          {t.trips.tripShort(trip.seq)}
        </span>
        <h2 className="text-sm font-semibold">{t.trips.trip(trip.seq)}</h2>
        <StatusBadge kind="trip" value={trip.status} />
        <span className="ml-auto flex items-center gap-1">
          {showRouteSheets && (
            <PdfButton
              path={`/trips/${trip.id}/route-sheet.pdf`}
              label={t.header.routeSheet}
              fallbackName={`feuille-de-route-tournee-${trip.seq}.pdf`}
              size="sm"
            />
          )}
          <LockButton trip={trip} />
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Assignment trip={trip} />

        <dl
          className={cn(
            "grid grid-cols-3 gap-x-3 gap-y-1.5 border-y bg-muted/20 px-3 py-2",
            pending && "opacity-60",
          )}
        >
          <Fact label={t.detail.depotArrival} value={formatLocalTime(trip.planned_start_at)} />
          <Fact label={t.detail.depotDeparture} value={formatLocalTime(trip.planned_depart_at)} />
          <Fact label={t.detail.depotReturn} value={formatLocalTime(trip.planned_return_at)} />
          <Fact label={t.detail.distance} value={formatKm(trip.distance_m)} />
          <Fact label={t.detail.duration} value={formatDuration(trip.duration_s)} />
          <Fact
            label={t.detail.volume}
            value={formatLiters(trip.planned_l)}
            sub={formatPercent(
              trip.fill_rate === null || trip.fill_rate === undefined ? null : trip.fill_rate * 100,
            )}
          />
        </dl>
        <p className="truncate px-3 pt-1.5 text-xs text-muted-foreground">
          {t.detail.depot} : <span className="text-foreground">{trip.depot_name ?? trip.depot_code}</span>
        </p>

        <div className="flex items-baseline gap-2 px-3 pb-1 pt-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground/70">
            {t.detail.stopsTitle}
          </h3>
          <span className="num text-xs text-muted-foreground">{trip.stops.length}</span>
          {canEdit && (
            <span className="ml-auto truncate text-2xs text-muted-foreground">{t.detail.stopsHint}</span>
          )}
        </div>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ol
            ref={setNodeRef}
            data-stop-zone="detail"
            aria-busy={pending}
            className={cn(
              "mx-1.5 rounded-md border",
              pending && "[&_.num]:opacity-70",
              dropTargetClass(isTarget, accepts),
            )}
          >
            {trip.stops.map((stop) => (
              <DetailStop key={stop.id} trip={trip} stop={stop} violations={byStop.get(stop.id) ?? []} />
            ))}
          </ol>
        </SortableContext>

        <h3 className="px-3 pb-0.5 pt-3 text-xs font-semibold uppercase tracking-wide text-foreground/70">
          {t.detail.loadsTitle}
        </h3>
        <LoadPlan trip={trip} pending={pending} />
      </div>
    </>
  );
}
