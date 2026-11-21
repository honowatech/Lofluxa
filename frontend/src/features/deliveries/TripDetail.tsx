/** Détail d'une tournée en exécution : avancement, arrêts, clôture (heure de retour, kilomètres réels). */
import { ArrowRight, Flag, Info, Truck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

import { useConfirm } from "@/components/ConfirmDialog";
import { Notice } from "@/components/PageHeader";
import { PdfButton } from "@/components/PdfButton";
import { StatusBadge } from "@/components/StatusBadge";
import { NumberInput, TimeInput } from "@/components/forms";
import { notify } from "@/components/notify";
import { Spinner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { fr } from "@/i18n/fr";
import { isApiError } from "@/lib/api";
import { formatKm, formatLiters, formatLocalTime } from "@/lib/format";
import type { IsoDate } from "@/lib/types";
import { withDay } from "@/lib/useDay";
import { cn } from "@/lib/utils";

import { useCloseTrip, type PlanTrip, type TripSummary } from "./api";
import { DelayBadge, StopCard } from "./StopCard";
import { delaySeconds, isTimeHM, localTimeToUtc } from "./time";

const t = fr.screens.deliveries;

/** Écart de la tournée sur son horaire : dernier arrêt traité, sinon départ du dépôt. */
export function tripDelay(trip: TripSummary, planTrip: PlanTrip | undefined): number | null {
  const reached = [...(planTrip?.stops ?? [])].reverse().find((stop) => stop.actual_arrival_at);
  if (reached) return delaySeconds(reached.planned_arrival_at, reached.actual_arrival_at);
  if (trip.status === "completed") return delaySeconds(trip.planned_return_at, trip.actual_return_at);
  return delaySeconds(trip.planned_depart_at, trip.actual_depart_at);
}

export function ProgressBar({ done, total, className }: { done: number; total: number; className?: string }) {
  return (
    <div
      role="progressbar"
      aria-label={t.list.progressLabel(done, total)}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      className={cn("flex h-1.5 gap-0.5", className)}
    >
      {Array.from({ length: total }, (_, index) => (
        <span key={index} className={cn("flex-1 rounded-full", index < done ? "bg-success" : "bg-border")} />
      ))}
    </div>
  );
}

export function TripDetail({
  trip,
  planTrip,
  canWrite,
}: {
  trip: TripSummary;
  planTrip: PlanTrip;
  canWrite: boolean;
}) {
  const day = trip.day as IsoDate;
  const stops = [...planTrip.stops].sort((a, b) => a.seq - b.seq);
  const done = stops.filter((stop) => stop.status !== "pending").length;
  const pendingCount = stops.length - done;
  const firstPending = stops.find((stop) => stop.status === "pending");
  const writable = canWrite && trip.status === "in_progress";
  const deliveredL = stops.reduce(
    (sum, stop) => sum + stop.deliveries.reduce((inner, line) => inner + (line.actual_l ?? 0), 0),
    0,
  );
  const gate = t.gate[trip.status];

  return (
    <section
      aria-label={t.list.trip(trip.seq)}
      data-testid="trip-detail"
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-md border bg-card p-4"
    >
      <header className="flex flex-wrap items-start gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold leading-tight">
            <Truck className="size-4 text-muted-foreground" aria-hidden />
            {t.list.trip(trip.seq)} — <span className="num">{trip.truck_plate}</span>
            <StatusBadge kind="trip" value={trip.status} />
            <DelayBadge seconds={trip.status === "planned" ? null : tripDelay(trip, planTrip)} />
          </h2>
          <p className="text-xs text-muted-foreground">
            {trip.driver_name ?? t.list.noDriver} · {trip.depot_name ?? trip.depot_code}
          </p>
        </div>
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
          <Fact label={t.trip.plannedDepart} value={formatLocalTime(trip.planned_depart_at)} />
          <Fact label={t.trip.actualDepart} value={formatLocalTime(trip.actual_depart_at)} />
          <Fact label={t.trip.plannedReturn} value={formatLocalTime(trip.planned_return_at)} />
          {trip.status === "completed" && (
            <>
              <Fact label={t.trip.actualReturn} value={formatLocalTime(trip.actual_return_at)} />
              <Fact label={t.trip.actualDistance} value={formatKm(trip.actual_distance_m)} />
            </>
          )}
          <Fact label={t.trip.distance} value={formatKm(trip.distance_m)} />
        </dl>
        <div className="ml-auto">
          <PdfButton
            path={`/trips/${trip.id}/route-sheet.pdf`}
            label={t.trip.routeSheet}
            fallbackName="feuille-de-route.pdf"
          />
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border bg-muted/30 px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">{t.trip.progress}</span>
        <ProgressBar done={done} total={stops.length} className="h-2 min-w-40 flex-1" />
        <span className="text-sm font-semibold" data-testid="trip-progress">
          {t.list.progress(done, stops.length)}
        </span>
        <span className="text-xs text-muted-foreground">
          {t.trip.delivered(formatLiters(deliveredL), formatLiters(trip.planned_total_l))}
        </span>
      </div>

      {gate && (
        <Notice
          tone={trip.status === "completed" ? "neutral" : "info"}
          icon={<Info className="size-4 shrink-0" aria-hidden />}
          action={
            trip.status !== "completed" && (
              <Button variant="outline" size="sm" asChild>
                <Link to={withDay(`/chargement?trip=${trip.id}`, day)}>
                  {t.trip.toLoading}
                  <ArrowRight aria-hidden />
                </Link>
              </Button>
            )
          }
        >
          {gate}
        </Notice>
      )}

      <ol className="flex flex-col gap-2">
        {stops.map((stop) => (
          <StopCard
            key={`${stop.id}:${stop.status}`}
            stop={stop}
            day={day}
            writable={writable}
            autoFocus={stop.id === firstPending?.id}
          />
        ))}
      </ol>

      {writable && <CloseTrip trip={trip} pendingCount={pendingCount} />}
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

function CloseTrip({ trip, pendingCount }: { trip: TripSummary; pendingCount: number }) {
  const close = useCloseTrip(trip.id);
  const confirm = useConfirm();
  const [returnAt, setReturnAt] = useState("");
  const [km, setKm] = useState<number | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const error = close.error && isApiError(close.error) ? close.error : null;
  const blocked = pendingCount > 0;

  const problems: string[] = [];
  if (returnAt !== "" && !isTimeHM(returnAt)) problems.push(t.validation.time);
  if (km !== null && !(km >= 0)) problems.push(t.validation.distance);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (blocked || close.isPending || problems.length > 0) return;
    if (
      !(await confirm({
        title: t.close.confirmTitle,
        description: t.close.confirmDescription,
        confirmLabel: t.close.submit,
      }))
    )
      return;
    close.mutate(
      {
        status: "completed",
        ...(returnAt !== "" ? { actual_return_at: localTimeToUtc(trip.day as IsoDate, returnAt) } : {}),
        ...(km !== null ? { actual_distance_m: Math.round(km * 1000) } : {}),
      },
      {
        onSuccess: () => notify.success(t.close.done(trip.seq)),
        onError: (failure) =>
          isApiError(failure) && t.errors[failure.code]
            ? notify.error(t.errors[failure.code], failure.message)
            : notify.apiError(failure, t.close.failed),
      },
    );
  };

  return (
    <form
      noValidate
      onSubmit={submit}
      aria-label={t.close.title}
      className="flex flex-col gap-2 rounded-md border bg-muted/30 px-3 py-2.5"
    >
      <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
        <h3 className="flex items-center gap-1.5 self-center text-sm font-semibold">
          <Flag className="size-4 text-muted-foreground" aria-hidden />
          {t.close.title}
        </h3>
        <div className="flex flex-col gap-1">
          <label htmlFor="close-return" className="text-xs font-medium text-foreground/80">
            {t.close.returnAt}
          </label>
          <TimeInput
            id="close-return"
            value={returnAt}
            onChange={setReturnAt}
            disabled={blocked}
            title={t.close.returnHint}
            aria-invalid={submitted && returnAt !== "" && !isTimeHM(returnAt)}
            className="h-10 w-24 text-base"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="close-km" className="text-xs font-medium text-foreground/80">
            {t.close.distance}{" "}
            <span className="font-normal text-muted-foreground">
              ({t.close.distanceHint(formatKm(trip.distance_m))})
            </span>
          </label>
          <div className="w-36">
            <NumberInput
              id="close-km"
              value={km}
              onChange={setKm}
              unit={t.close.distanceUnit}
              disabled={blocked}
              aria-invalid={submitted && km !== null && !(km >= 0)}
              className="h-10 text-base"
            />
          </div>
        </div>
        <Button type="submit" size="lg" className="h-10 px-4" disabled={blocked || close.isPending}>
          {close.isPending ? <Spinner className="text-current" /> : <Flag aria-hidden />}
          {t.close.submit}
        </Button>
      </div>
      <p
        className={cn("text-xs", blocked ? "text-muted-foreground" : "text-success")}
        data-testid="close-hint"
      >
        {blocked ? t.close.pending(pendingCount) : t.close.ready}
      </p>
      {submitted && problems.length > 0 && <Notice tone="blocking">{problems.join(" ")}</Notice>}
      {error && (
        <Notice tone="blocking">
          <p className="font-semibold">{t.errors[error.code] ?? t.close.failed}</p>
          <p>{error.message}</p>
        </Notice>
      )}
    </form>
  );
}
