/**
 * Assistant de réaffectation (F6.1 panne de camion, F6.2 chauffeur indisponible) en quatre étapes courtes :
 * incident → tournée → remplaçant → confirmation. RM-19 : seuls les arrêts « à livrer » sont transférés.
 */
import { CheckCircle2, Truck, UserX } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { notify } from "@/components/notify";
import { Notice } from "@/components/PageHeader";
import { EmptyState, ErrorState, LoadingState, Spinner } from "@/components/states";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ViolationsPanel } from "@/components/ViolationsPanel";
import { fr } from "@/i18n/fr";
import { errorMessage, isApiError } from "@/lib/api";
import { EMPTY, formatLiters, formatLocalTime } from "@/lib/format";
import type { IsoDate } from "@/lib/types";
import { cn } from "@/lib/utils";

import {
  useDriverUnavailable,
  usePublishedTrips,
  useReplacementOptions,
  useTruckBreakdown,
  type IncidentKind,
  type PlanStopOut,
  type PublishedTrip,
  type ReassignmentResult,
} from "./api";
import { planLink } from "./summary";

const t = fr.screens.events.assistant;
const STEPS = ["kind", "trip", "replacement", "confirm"] as const;

/** Carte de choix (bouton radio habillé) : grande cible, utilisable au clavier. */
function Choice({
  name,
  value,
  checked,
  onChange,
  disabled,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 transition-colors",
        checked ? "border-primary bg-accent/60" : "hover:bg-muted/60",
        disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="mt-1 size-3.5 accent-[hsl(var(--primary))]"
      />
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  );
}

function StopList({ title, stops }: { title: string; stops: PlanStopOut[] }) {
  return (
    <div>
      <p className="text-xs font-medium">{title}</p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {stops.map((stop) => (
          <li key={stop.id} className="flex items-center gap-2 text-xs">
            <span className="num w-4 text-right text-muted-foreground">{stop.seq}</span>
            <span className="min-w-0 flex-1 truncate">{stop.station_name ?? stop.station_code ?? EMPTY}</span>
            <span className="num text-muted-foreground">{formatLocalTime(stop.planned_arrival_at)}</span>
            <span className="num w-16 text-right">{formatLiters(stop.planned_l)}</span>
            <StatusBadge kind="stop" value={stop.status} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Rm19({ item }: { item: PublishedTrip }) {
  const pending = item.trip.stops.filter((stop) => stop.status === "pending");
  const kept = item.trip.stops.filter((stop) => stop.status !== "pending");
  return (
    <section className="rounded-md border bg-muted/40 px-3 py-2" aria-label={t.rm19.title}>
      <p className="mb-1.5 text-xs font-semibold">{t.rm19.title}</p>
      <div className="flex flex-col gap-2">
        <StopList title={t.rm19.toTransfer(pending.length)} stops={pending} />
        {kept.length > 0 ? (
          <StopList title={t.rm19.kept(kept.length)} stops={kept} />
        ) : (
          <p className="text-xs text-muted-foreground">{t.rm19.noneKept}</p>
        )}
      </div>
    </section>
  );
}

function RecapRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </>
  );
}

export function ReassignDialog({
  day,
  open,
  onOpenChange,
}: {
  day: IsoDate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ids = useId();
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<IncidentKind>("truck");
  const [tripId, setTripId] = useState<string | null>(null);
  const [truckId, setTruckId] = useState<string | null>(null);
  const [driverId, setDriverId] = useState<string | null>(null);
  const [done, setDone] = useState<ReassignmentResult | null>(null);

  const trips = usePublishedTrips(day, open);
  const options = useReplacementOptions(tripId, kind, open && step >= 2);
  const truckBreakdown = useTruckBreakdown();
  const driverUnavailable = useDriverUnavailable();
  const mutation = kind === "truck" ? truckBreakdown : driverUnavailable;

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setKind("truck");
    setTripId(null);
    setTruckId(null);
    setDriverId(null);
    setDone(null);
    truckBreakdown.reset();
    driverUnavailable.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selected = trips.data?.find((item) => item.trip.id === tripId) ?? null;
  const pendingCount = (item: PublishedTrip) =>
    item.trip.stops.filter((stop) => stop.status === "pending").length;
  const truck = options.data?.trucks.find((item) => item.id === truckId) ?? null;
  const driver = options.data?.drivers.find((item) => item.id === driverId) ?? null;

  const canContinue =
    step === 0 ||
    (step === 1 && !!selected) ||
    (step === 2 && (kind === "truck" ? !!truck : !!driver)) ||
    step === 3;

  const chooseKind = (next: IncidentKind) => {
    setKind(next);
    setTruckId(null);
    setDriverId(null);
  };
  const chooseTrip = (id: string) => {
    setTripId(id);
    setTruckId(null);
    setDriverId(null);
  };

  const confirm = async () => {
    if (!selected) return;
    try {
      const result =
        kind === "truck"
          ? await truckBreakdown.mutateAsync({
              trip_id: selected.trip.id,
              replacement_truck_id: truckId as string,
              ...(driverId ? { replacement_driver_id: driverId } : {}),
            })
          : await driverUnavailable.mutateAsync({
              trip_id: selected.trip.id,
              replacement_driver_id: driverId as string,
            });
      setDone(result);
      notify.success(t.done.toast);
    } catch {
      // L'erreur reste affichée dans la boîte (state de la mutation).
    }
  };

  const error = mutation.error;
  const stepName = STEPS[step];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" aria-describedby={`${ids}-description`}>
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription id={`${ids}-description`}>{t.description}</DialogDescription>
        </DialogHeader>

        {done ? (
          <>
            <DialogBody className="flex flex-col gap-3">
              <Notice tone="info" icon={<CheckCircle2 className="size-4" aria-hidden />}>
                <strong className="font-semibold">{t.done.title}.</strong>{" "}
                {t.done.newVersion(done.plan_version)}
                {done.transferred_stop_count !== null &&
                  ` ${t.done.transferred(done.transferred_stop_count)}`}
              </Notice>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {fr.common.close}
              </Button>
              {done.plan_id && (
                <Button asChild>
                  <Link to={planLink(done.plan_id, day)} onClick={() => onOpenChange(false)}>
                    {t.done.openPlan}
                  </Link>
                </Button>
              )}
            </DialogFooter>
          </>
        ) : (
          <>
            <ol
              className="flex gap-1 border-b px-5 py-2 text-xs"
              aria-label={t.stepOf(step + 1, STEPS.length)}
            >
              {STEPS.map((name, index) => (
                <li
                  key={name}
                  aria-current={index === step ? "step" : undefined}
                  className={cn(
                    "flex items-center gap-1.5 rounded-sm px-1.5 py-0.5",
                    index === step
                      ? "bg-accent font-semibold text-accent-foreground"
                      : index < step
                        ? "text-foreground/80"
                        : "text-muted-foreground",
                  )}
                >
                  <span className="num">{index + 1}</span>
                  {t.steps[name]}
                </li>
              ))}
            </ol>

            <DialogBody className="flex min-h-[16rem] flex-col gap-3">
              {stepName === "kind" && (
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1.5 text-sm font-medium">{t.kinds.label}</legend>
                  <Choice
                    name={`${ids}-kind`}
                    value="truck"
                    checked={kind === "truck"}
                    onChange={() => chooseKind("truck")}
                  >
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      <Truck className="size-4" aria-hidden />
                      {t.kinds.truck}
                    </span>
                    <span className="block text-xs text-muted-foreground">{t.kinds.truckHint}</span>
                  </Choice>
                  <Choice
                    name={`${ids}-kind`}
                    value="driver"
                    checked={kind === "driver"}
                    onChange={() => chooseKind("driver")}
                  >
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      <UserX className="size-4" aria-hidden />
                      {t.kinds.driver}
                    </span>
                    <span className="block text-xs text-muted-foreground">{t.kinds.driverHint}</span>
                  </Choice>
                </fieldset>
              )}

              {stepName === "trip" &&
                (trips.isLoading ? (
                  <LoadingState compact label={t.trips.loadingPlans} />
                ) : trips.error ? (
                  <ErrorState compact error={trips.error} onRetry={() => trips.refetch()} />
                ) : (trips.data ?? []).length === 0 ? (
                  <EmptyState compact description={t.trips.none} />
                ) : (
                  <>
                    <fieldset className="flex flex-col gap-1.5">
                      <legend className="mb-1.5 text-sm font-medium">{t.trips.label}</legend>
                      {(trips.data ?? []).map((item) => {
                        const pending = pendingCount(item);
                        return (
                          <Choice
                            key={item.trip.id}
                            name={`${ids}-trip`}
                            value={item.trip.id}
                            checked={tripId === item.trip.id}
                            onChange={() => chooseTrip(item.trip.id)}
                            disabled={pending === 0}
                          >
                            <span className="flex flex-wrap items-center gap-x-2 text-sm">
                              <span className="font-medium">
                                {t.trips.option(
                                  item.trip.seq,
                                  item.trip.truck_plate ?? null,
                                  item.trip.driver_name ?? null,
                                )}
                              </span>
                              <StatusBadge kind="trip" value={item.trip.status} />
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {t.trips.stops(pending, item.trip.stops.length)}
                              {pending === 0 && ` — ${t.trips.nonePending}`}
                            </span>
                          </Choice>
                        );
                      })}
                    </fieldset>
                    {selected && <Rm19 item={selected} />}
                  </>
                ))}

              {stepName === "replacement" &&
                (options.isLoading ? (
                  <LoadingState compact label={t.replacement.loading} />
                ) : options.error ? (
                  <ErrorState compact error={options.error} onRetry={() => options.refetch()} />
                ) : kind === "truck" ? (
                  <>
                    {(options.data?.trucks ?? []).length === 0 ? (
                      <EmptyState compact description={t.replacement.noTruck} />
                    ) : (
                      <fieldset className="flex flex-col gap-1.5">
                        <legend className="mb-1.5 text-sm font-medium">{t.replacement.truckLabel}</legend>
                        {(options.data?.trucks ?? []).map((item) => (
                          <Choice
                            key={item.id}
                            name={`${ids}-truck`}
                            value={item.id}
                            checked={truckId === item.id}
                            onChange={() => setTruckId(item.id)}
                            disabled={!item.suitable}
                          >
                            <span className="flex flex-wrap items-center gap-x-2 text-sm">
                              <span className="font-medium">{item.plate}</span>
                              {!item.suitable && <Badge tone="warning">{t.replacement.unsuitable}</Badge>}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {[
                                item.size ? fr.status.size[item.size as keyof typeof fr.status.size] : null,
                                item.total_capacity_l !== null
                                  ? t.replacement.capacity(formatLiters(item.total_capacity_l))
                                  : null,
                                item.carrier_name,
                                item.reason,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </Choice>
                        ))}
                      </fieldset>
                    )}
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`${ids}-driver`}>{t.replacement.driverOptional}</Label>
                      <NativeSelect
                        id={`${ids}-driver`}
                        value={driverId ?? ""}
                        onChange={(event) => setDriverId(event.target.value || null)}
                        className="max-w-sm"
                      >
                        <option value="">
                          {t.replacement.keepDriver(selected?.trip.driver_name ?? null)}
                        </option>
                        {(options.data?.drivers ?? [])
                          .filter((item) => item.suitable)
                          .map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.full_name}
                            </option>
                          ))}
                      </NativeSelect>
                    </div>
                  </>
                ) : (options.data?.drivers ?? []).length === 0 ? (
                  <EmptyState compact description={t.replacement.noDriver} />
                ) : (
                  <fieldset className="flex flex-col gap-1.5">
                    <legend className="mb-1.5 text-sm font-medium">{t.replacement.driverLabel}</legend>
                    {(options.data?.drivers ?? []).map((item) => (
                      <Choice
                        key={item.id}
                        name={`${ids}-driver`}
                        value={item.id}
                        checked={driverId === item.id}
                        onChange={() => setDriverId(item.id)}
                        disabled={!item.suitable}
                      >
                        <span className="flex flex-wrap items-center gap-x-2 text-sm">
                          <span className="font-medium">{item.full_name}</span>
                          {!item.suitable && <Badge tone="warning">{t.replacement.unsuitable}</Badge>}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {[item.phone, item.reason].filter(Boolean).join(" · ")}
                        </span>
                      </Choice>
                    ))}
                  </fieldset>
                ))}

              {stepName === "confirm" && selected && (
                <>
                  <section aria-label={t.recap.title}>
                    <h3 className="mb-1.5 text-sm font-medium">{t.recap.title}</h3>
                    <dl className="grid grid-cols-[11rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 rounded-md border px-3 py-2">
                      <RecapRow label={t.recap.incident}>
                        {kind === "truck" ? t.kinds.truck : t.kinds.driver}
                      </RecapRow>
                      <RecapRow label={t.recap.trip}>
                        {t.trips.option(
                          selected.trip.seq,
                          selected.trip.truck_plate ?? null,
                          selected.trip.driver_name ?? null,
                        )}
                      </RecapRow>
                      {kind === "truck" ? (
                        <>
                          <RecapRow label={t.recap.currentTruck}>
                            {selected.trip.truck_plate ?? EMPTY}
                          </RecapRow>
                          <RecapRow label={t.recap.newTruck}>
                            <span className="font-medium">{truck?.plate ?? EMPTY}</span>
                          </RecapRow>
                          <RecapRow label={t.recap.newDriver}>
                            {driver?.full_name ?? t.recap.unchangedDriver}
                          </RecapRow>
                        </>
                      ) : (
                        <>
                          <RecapRow label={t.recap.currentDriver}>
                            {selected.trip.driver_name ?? EMPTY}
                          </RecapRow>
                          <RecapRow label={t.recap.newDriver}>
                            <span className="font-medium">{driver?.full_name ?? EMPTY}</span>
                          </RecapRow>
                        </>
                      )}
                      <RecapRow label={t.recap.stops}>
                        {t.trips.stops(pendingCount(selected), selected.trip.stops.length)}
                      </RecapRow>
                    </dl>
                    <p className="mt-1.5 text-xs text-muted-foreground">{t.recap.effect}</p>
                  </section>
                  {error && (
                    <Notice tone="blocking">
                      <strong className="font-semibold">{t.failed}.</strong> {errorMessage(error)}
                      {isApiError(error) && error.isConflict && (
                        <span className="mt-0.5 block font-normal">{t.conflictHint}</span>
                      )}
                    </Notice>
                  )}
                  {isApiError(error) && <ViolationsPanel violations={error.violations} hideWhenEmpty />}
                </>
              )}
            </DialogBody>

            <DialogFooter>
              <Button variant="ghost" className="mr-auto" onClick={() => onOpenChange(false)}>
                {fr.common.cancel}
              </Button>
              {step > 0 && (
                <Button variant="outline" onClick={() => setStep(step - 1)} disabled={mutation.isPending}>
                  {t.previous}
                </Button>
              )}
              {step < STEPS.length - 1 ? (
                <Button onClick={() => setStep(step + 1)} disabled={!canContinue}>
                  {t.next}
                </Button>
              ) : (
                <Button onClick={() => void confirm()} disabled={mutation.isPending}>
                  {mutation.isPending && <Spinner className="text-current" />}
                  {mutation.isPending ? t.confirming : t.confirm}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
