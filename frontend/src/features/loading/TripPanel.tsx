/** Détail d'une tournée au dépôt : étapes de statut, formulaire de chargement, fiche PDF et envoi par e-mail. */
import { ArrowRight, Mail, PackageCheck, Truck, Warehouse } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { Notice } from "@/components/PageHeader";
import { PdfButton } from "@/components/PdfButton";
import { StatusBadge } from "@/components/StatusBadge";
import { Steps } from "@/components/Steps";
import { TimeInput } from "@/components/forms";
import { notify } from "@/components/notify";
import { ErrorState, LoadingState, Spinner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { fr } from "@/i18n/fr";
import { isApiError, useSettings } from "@/lib/api";
import { formatKm, formatLiters, formatLocalTime } from "@/lib/format";
import type { IsoDate } from "@/lib/types";
import { withDay } from "@/lib/useDay";

import {
  TRIP_FLOW,
  useChangeStatus,
  useLoading,
  usePlan,
  useProducts,
  useStations,
  type TripLoading,
  type TripStatus,
} from "./api";
import { isTimeHM, localTimeToUtc } from "./conversion";
import { EmailDialog } from "./EmailDialog";
import { LoadingForm } from "./LoadingForm";

const t = fr.screens.loading;

export function TripPanel({ trip, canWrite }: { trip: TripLoading; canWrite: boolean }) {
  const plan = usePlan(trip.plan_id);
  const loading = useLoading(trip.id, trip.loading_recorded);
  const products = useProducts();
  const stations = useStations();
  const settings = useSettings();
  const [dirty, setDirty] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);

  const planTrip = plan.data?.trips.find((item) => item.id === trip.id);
  const toleranceValue = settings.data?.find((setting) => setting.key === "loading_tolerance_pct")?.value;
  const tolerancePct = typeof toleranceValue === "number" ? toleranceValue : null;
  const pending =
    plan.isLoading ||
    products.isLoading ||
    settings.isLoading ||
    (trip.loading_recorded && loading.isLoading);
  const failure = plan.error ?? products.error ?? (trip.loading_recorded ? loading.error : null);

  return (
    <section
      aria-label={t.list.trip(trip.seq)}
      data-testid="trip-panel"
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-md border bg-card p-4"
    >
      <header className="flex flex-wrap items-start gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold leading-tight">
            <Truck className="size-4 text-muted-foreground" aria-hidden />
            {t.list.trip(trip.seq)} — <span className="num">{trip.truck_plate}</span>
            <StatusBadge kind="trip" value={trip.status} />
          </h2>
          <p className="text-xs text-muted-foreground">
            {trip.driver_name ?? t.list.noDriver} · {trip.depot_name ?? trip.depot_code}
          </p>
        </div>
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
          <Fact label={t.trip.plannedStart} value={formatLocalTime(trip.planned_start_at)} />
          <Fact label={t.trip.plannedDepart} value={formatLocalTime(trip.planned_depart_at)} />
          {trip.actual_depart_at && (
            <Fact label={t.trip.actualDepart} value={formatLocalTime(trip.actual_depart_at)} />
          )}
          <Fact label={t.trip.plannedVolume} value={formatLiters(trip.planned_total_l)} />
          <Fact label={t.trip.stops} value={`${trip.stop_count} · ${formatKm(trip.distance_m)}`} />
        </dl>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <PdfButton
            path={`/trips/${trip.id}/loading-sheet.pdf`}
            label={t.trip.loadingSheet}
            fallbackName="fiche-chargement.pdf"
            disabled={!trip.loading_recorded}
            title={trip.loading_recorded ? undefined : t.trip.loadingSheetHint}
            className="h-10"
          />
          {canWrite && (
            <Button
              variant="outline"
              className="h-10"
              disabled={!trip.loading_recorded}
              title={trip.loading_recorded ? undefined : t.trip.loadingSheetHint}
              onClick={() => setEmailOpen(true)}
            >
              <Mail aria-hidden />
              {t.trip.email}
            </Button>
          )}
        </div>
      </header>

      <StatusSteps trip={trip} canWrite={canWrite} dirty={dirty} />

      {pending ? (
        <LoadingState />
      ) : failure ? (
        <ErrorState
          error={failure}
          onRetry={() => {
            void plan.refetch();
            void products.refetch();
            if (trip.loading_recorded) void loading.refetch();
          }}
        />
      ) : (
        <LoadingForm
          key={trip.id}
          trip={trip}
          loads={[...(planTrip?.loads ?? [])].sort(
            (a, b) => (a.compartment_position ?? 0) - (b.compartment_position ?? 0),
          )}
          loading={trip.loading_recorded ? (loading.data ?? null) : null}
          products={products.data ?? []}
          tolerancePct={tolerancePct}
          canWrite={canWrite}
          onDirtyChange={setDirty}
        />
      )}

      {emailOpen && (
        <EmailDialog
          trip={trip}
          planTrip={planTrip}
          stations={stations.data ?? []}
          open={emailOpen}
          onOpenChange={setEmailOpen}
        />
      )}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="num text-sm font-medium">{value}</dd>
    </div>
  );
}

const NEXT_LABEL: Partial<Record<TripStatus, string>> = {
  planned: t.steps.toAtDepot,
  at_depot: t.steps.toLoaded,
  loaded: t.steps.toInProgress,
};
const NEXT_ICON = { planned: Warehouse, at_depot: PackageCheck, loaded: ArrowRight } as const;

/** Frise des cinq statuts et bouton de l'étape suivante (un seul pas en avant, question L6-12). */
function StatusSteps({ trip, canWrite, dirty }: { trip: TripLoading; canWrite: boolean; dirty: boolean }) {
  const change = useChangeStatus(trip.id);
  const [departTime, setDepartTime] = useState("");
  const index = TRIP_FLOW.indexOf(trip.status);
  const next = TRIP_FLOW[index + 1];
  const label = NEXT_LABEL[trip.status];
  const Icon = NEXT_ICON[trip.status as keyof typeof NEXT_ICON];
  const needsLoading = trip.status === "at_depot" && !trip.loading_recorded;
  const blockedByDraft = dirty && trip.status !== "planned";
  const timeInvalid = departTime !== "" && !isTimeHM(departTime);
  const error = change.error && isApiError(change.error) ? change.error : null;

  const advance = () =>
    change.mutate(
      {
        status: next,
        ...(trip.status === "loaded" && departTime !== ""
          ? { actual_depart_at: localTimeToUtc(trip.day as IsoDate, departTime) }
          : {}),
      },
      {
        onSuccess: (updated) => notify.success(t.steps.done(fr.status.trip[updated.status])),
        onError: (failure) => notify.apiError(failure, t.steps.failed),
      },
    );

  return (
    <div className="flex flex-col gap-2 rounded-md border bg-muted/30 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Steps
          label={t.steps.label}
          current={trip.status}
          steps={TRIP_FLOW.map((status) => ({ id: status, label: fr.status.trip[status] }))}
        />
        <div className="ml-auto flex flex-wrap items-end gap-2">
          {canWrite && trip.status === "loaded" && (
            <div className="flex flex-col gap-0.5">
              <label htmlFor="depart-time" className="text-xs text-muted-foreground">
                {t.steps.departTime}
              </label>
              <TimeInput
                id="depart-time"
                value={departTime}
                onChange={setDepartTime}
                aria-invalid={timeInvalid}
                title={t.steps.departTimeHint}
                className="h-10 w-24 text-base"
              />
            </div>
          )}
          {canWrite && label && (
            <Button
              size="lg"
              className="h-11 px-5 text-base"
              disabled={change.isPending || needsLoading || blockedByDraft || timeInvalid}
              onClick={advance}
            >
              {change.isPending ? <Spinner className="text-current" /> : Icon && <Icon aria-hidden />}
              {label}
            </Button>
          )}
          {(trip.status === "in_progress" || trip.status === "completed") && (
            <Button variant="outline" className="h-10" asChild>
              <Link to={withDay(`/suivi?trip=${trip.id}`, trip.day as IsoDate)}>
                {t.trip.followUp}
                <ArrowRight aria-hidden />
              </Link>
            </Button>
          )}
        </div>
      </div>
      {canWrite && needsLoading && (
        <p className="text-xs text-muted-foreground">{t.steps.loadedNeedsLoading}</p>
      )}
      {canWrite && label && blockedByDraft && !needsLoading && (
        <p className="text-xs text-warning">{t.steps.unsavedChanges}</p>
      )}
      {trip.status === "in_progress" && (
        <p className="text-xs text-muted-foreground">{t.steps.inProgressHint}</p>
      )}
      {trip.status === "completed" && (
        <p className="text-xs text-muted-foreground">{t.steps.completedHint}</p>
      )}
      {error && (
        <Notice tone="blocking">
          <p className="font-semibold">{t.errors[error.code] ?? t.steps.failed}</p>
          <p>{error.message}</p>
        </Notice>
      )}
    </div>
  );
}
