/** Écran 8 — Suivi des livraisons : réalisations par tournée du plan publié (F7.4). */
import { Lock } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import { Notice, PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { ChipsInput } from "@/components/forms";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { fr } from "@/i18n/fr";
import { useCan } from "@/lib/auth";
import { formatDateLong, formatLocalTime } from "@/lib/format";
import { useDay } from "@/lib/useDay";
import { cn } from "@/lib/utils";

import { TRIP_FLOW, usePlans, useTrips, type PlanTrip, type TripStatus, type TripSummary } from "./api";
import { DelayBadge } from "./StopCard";
import { ProgressBar, TripDetail, tripDelay } from "./TripDetail";

const t = fr.screens.deliveries;

export default function DeliveriesPage() {
  const { day } = useDay();
  const canWrite = useCan("deliveries.write");
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("trip");
  const statusFilter = useMemo(
    () =>
      params
        .get("status")
        ?.split(",")
        .filter((status) => TRIP_FLOW.includes(status as TripStatus)) ?? null,
    [params],
  );
  const setParam = (name: string, value: string | null) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(name, value);
        else next.delete(name);
        return next;
      },
      { replace: true },
    );

  const list = useTrips(day);
  const trips = useMemo(() => list.data ?? [], [list.data]);
  const planIds = useMemo(() => [...new Set(trips.map((trip) => trip.plan_id))], [trips]);
  const plans = usePlans(planIds);
  const shown = useMemo(
    () => trips.filter((trip) => !statusFilter || statusFilter.includes(trip.status)),
    [trips, statusFilter],
  );
  const selected = trips.find((trip) => trip.id === selectedId) ?? null;
  const selectedPlanTrip = selected ? plans.trips.get(selected.id) : undefined;

  // Sans sélection : la première tournée en cours, à défaut la première de la liste.
  useEffect(() => {
    if (selected || shown.length === 0) return;
    setParam("trip", (shown.find((trip) => trip.status === "in_progress") ?? shown[0]).id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, shown]);

  return (
    <div className="flex h-full flex-col gap-3 p-4" data-testid="screen-deliveries">
      <PageHeader title={fr.nav.screens.deliveries} subtitle={`${formatDateLong(day)} — ${t.subtitle}`} />
      {!canWrite && (
        <Notice tone="neutral" icon={<Lock className="size-3.5" aria-hidden />}>
          {t.readOnly}
        </Notice>
      )}

      <div className="flex min-h-0 flex-1 gap-3">
        <aside className="flex w-[21rem] shrink-0 flex-col gap-2">
          <ChipsInput
            label={t.filters.status}
            allLabel={t.filters.all}
            value={statusFilter}
            onChange={(value) => setParam("status", value ? value.join(",") : null)}
            options={TRIP_FLOW.map((status) => ({ value: status, label: fr.status.trip[status] }))}
          />
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {t.list.count(shown.length, trips.length)}
          </p>
          {list.isLoading ? (
            <LoadingState compact />
          ) : list.error ? (
            <ErrorState compact error={list.error} onRetry={() => list.refetch()} />
          ) : trips.length === 0 ? (
            <EmptyState compact title={t.list.emptyTitle} description={t.list.emptyHint} />
          ) : shown.length === 0 ? (
            <EmptyState compact title={t.list.emptyFiltered} />
          ) : (
            <ul
              aria-label={t.list.title}
              className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-0.5"
            >
              {shown.map((trip) => (
                <li key={trip.id}>
                  <TripCard
                    trip={trip}
                    planTrip={plans.trips.get(trip.id)}
                    selected={trip.id === selected?.id}
                    onSelect={() => setParam("trip", trip.id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </aside>

        {!selected ? (
          <div className="flex flex-1 items-center justify-center rounded-md border border-dashed">
            {!list.isLoading && trips.length > 0 && <EmptyState title={t.list.selectHint} />}
          </div>
        ) : selectedPlanTrip ? (
          <TripDetail key={selected.id} trip={selected} planTrip={selectedPlanTrip} canWrite={canWrite} />
        ) : (
          <div className="flex flex-1 items-center justify-center rounded-md border bg-card">
            {plans.error ? <ErrorState error={plans.error} onRetry={plans.refetch} /> : <LoadingState />}
          </div>
        )}
      </div>
    </div>
  );
}

function TripCard({
  trip,
  planTrip,
  selected,
  onSelect,
}: {
  trip: TripSummary;
  planTrip: PlanTrip | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  // L'avancement vient du plan quand il est chargé (à jour après chaque saisie), sinon du résumé.
  const done = planTrip ? planTrip.stops.filter((stop) => stop.status !== "pending").length : trip.stops_done;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      data-testid={`trip-card-${trip.seq}`}
      className={cn(
        "flex w-full flex-col gap-1.5 rounded-md border bg-card px-3 py-2 text-left focus-ring hover:bg-muted/60",
        selected &&
          "border-primary bg-accent/60 shadow-[inset_3px_0_0_hsl(var(--primary))] hover:bg-accent/60",
      )}
    >
      <span className="flex items-center gap-2">
        <span className="text-sm font-semibold">{t.list.trip(trip.seq)}</span>
        <span className="num text-sm">{trip.truck_plate}</span>
        <StatusBadge kind="trip" value={trip.status} className="ml-auto" />
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {trip.driver_name ?? t.list.noDriver} · {trip.depot_code} ·{" "}
        <span className="num">
          {formatLocalTime(trip.planned_depart_at)} → {formatLocalTime(trip.planned_return_at)}
        </span>
      </span>
      <ProgressBar done={done} total={trip.stop_count} />
      <span className="flex items-center gap-2 text-xs">
        <span className="font-medium">{t.list.progress(done, trip.stop_count)}</span>
        <DelayBadge
          seconds={trip.status === "planned" ? null : tripDelay(trip, planTrip)}
          className="ml-auto"
        />
      </span>
    </button>
  );
}
