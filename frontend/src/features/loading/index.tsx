/** Écran 7 — Chargement (vue Fleet) : tournées du jour au dépôt, chargement par compartiment, fiche, départ. */
import { AlertTriangle, Lock } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import { Notice, PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { ChipsInput } from "@/components/forms";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/input";
import { fr } from "@/i18n/fr";
import { useCan, useRole } from "@/lib/auth";
import { formatDateLong, formatLiters, formatLocalTime } from "@/lib/format";
import { useDay } from "@/lib/useDay";
import { cn } from "@/lib/utils";

import { TRIP_FLOW, useDepots, useTripLoadings, type TripLoading, type TripStatus } from "./api";
import { TripPanel } from "./TripPanel";

const t = fr.screens.loading;
type LoadingFilter = "all" | "todo" | "done" | "warning";
const LOADING_FILTERS: Record<LoadingFilter, (trip: TripLoading) => boolean> = {
  all: () => true,
  todo: (trip) => !trip.loading_recorded,
  done: (trip) => trip.loading_recorded,
  warning: (trip) => !!trip.loading?.out_of_tolerance,
};

export default function LoadingPage() {
  const { day } = useDay();
  // L'API ouvre l'écriture à `fleet` et `dispatcher` (la table des droits du socle ne cite que `fleet`).
  const fleetWrite = useCan("loading.write");
  const role = useRole();
  const canWrite = fleetWrite || role === "dispatcher";
  const [params, setParams] = useSearchParams();
  const depotId = params.get("depot");
  const selectedId = params.get("trip");
  const loadingFilter = (params.get("loading") ?? "all") as LoadingFilter;
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

  const depots = useDepots();
  const list = useTripLoadings(day, depotId);
  const trips = useMemo(() => list.data ?? [], [list.data]);
  const shown = useMemo(
    () =>
      trips.filter(
        (trip) =>
          (LOADING_FILTERS[loadingFilter] ?? LOADING_FILTERS.all)(trip) &&
          (!statusFilter || statusFilter.includes(trip.status)),
      ),
    [trips, loadingFilter, statusFilter],
  );
  const selected = trips.find((trip) => trip.id === selectedId) ?? null;

  // Sans sélection, la première tournée encore au dépôt est ouverte : l'agent saisit sans chercher.
  useEffect(() => {
    if (selected || shown.length === 0) return;
    const first =
      shown.find((trip) => trip.status !== "in_progress" && trip.status !== "completed") ?? shown[0];
    setParam("trip", first.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, shown]);

  return (
    <div className="flex h-full flex-col gap-3 p-4" data-testid="screen-loading">
      <PageHeader
        title={fr.nav.screens.loading}
        subtitle={`${formatDateLong(day)} — ${t.subtitle}`}
        actions={
          <>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {t.filters.depot}
              <NativeSelect
                value={depotId ?? ""}
                onChange={(event) => setParam("depot", event.target.value || null)}
                className="h-9 w-48"
              >
                <option value="">{t.filters.allDepots}</option>
                {(depots.data ?? []).map((depot) => (
                  <option key={depot.id} value={depot.id}>
                    {depot.code} — {depot.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {t.filters.loading}
              <NativeSelect
                value={loadingFilter}
                onChange={(event) =>
                  setParam("loading", event.target.value === "all" ? null : event.target.value)
                }
                className="h-9 w-40"
              >
                <option value="all">{t.filters.loadingAll}</option>
                <option value="todo">{t.filters.loadingTodo}</option>
                <option value="done">{t.filters.loadingDone}</option>
                <option value="warning">{t.filters.loadingWarning}</option>
              </NativeSelect>
            </label>
          </>
        }
      />
      {!canWrite && (
        <Notice tone="neutral" icon={<Lock className="size-3.5" aria-hidden />}>
          {t.readOnly}
        </Notice>
      )}

      <div className="flex min-h-0 flex-1 gap-3">
        <aside className="flex w-[21rem] shrink-0 flex-col gap-2">
          <div className="flex flex-col gap-1.5">
            <ChipsInput
              label={t.filters.status}
              allLabel={t.filters.allStatuses}
              value={statusFilter}
              onChange={(value) => setParam("status", value ? value.join(",") : null)}
              options={TRIP_FLOW.map((status) => ({ value: status, label: fr.status.trip[status] }))}
            />
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {t.list.count(shown.length, trips.length)}
            </p>
          </div>
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
                    selected={trip.id === selected?.id}
                    onSelect={() => setParam("trip", trip.id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </aside>

        {selected ? (
          <TripPanel key={selected.id} trip={selected} canWrite={canWrite} />
        ) : (
          <div className="flex flex-1 items-center justify-center rounded-md border border-dashed">
            {!list.isLoading && trips.length > 0 && <EmptyState title={t.list.selectHint} />}
          </div>
        )}
      </div>
    </div>
  );
}

function TripCard({
  trip,
  selected,
  onSelect,
}: {
  trip: TripLoading;
  selected: boolean;
  onSelect: () => void;
}) {
  const warning = !!trip.loading?.out_of_tolerance;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      data-testid={`trip-card-${trip.seq}`}
      className={cn(
        "flex w-full flex-col gap-1 rounded-md border bg-card px-3 py-2 text-left focus-ring hover:bg-muted/60",
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
        {trip.driver_name ?? t.list.noDriver} · {trip.depot_code}
      </span>
      <span className="flex items-center gap-2 text-xs">
        <span>
          {t.list.depart} <span className="num font-medium">{formatLocalTime(trip.planned_depart_at)}</span>
        </span>
        <span className="text-muted-foreground">
          <span className="num">{formatLiters(trip.planned_total_l)}</span> · {t.list.stops(trip.stop_count)}
        </span>
      </span>
      <span className="flex items-center gap-1.5">
        {!trip.loading_recorded ? (
          <Badge tone="neutral">{t.list.notLoaded}</Badge>
        ) : (
          <>
            <Badge tone={warning ? "warning" : "success"}>
              {warning && <AlertTriangle className="size-3" aria-hidden />}
              {warning ? t.list.gapWarning : t.list.loaded}
            </Badge>
            <span className="num text-xs text-muted-foreground">
              {formatLiters(trip.loading?.volume_15_total_l)} {t.list.at15}
            </span>
          </>
        )}
      </span>
    </button>
  );
}
