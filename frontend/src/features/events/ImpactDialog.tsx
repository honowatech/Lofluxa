/**
 * Pénurie produit (F6.3) : impact à jour (`GET /events/{id}/impact`) et décisions du dispatcher par tournée
 * (`POST /events/{id}/resolve`) — réduire, reporter ou changer de dépôt, parmi les `options` du serveur.
 */
import { useEffect, useId, useState } from "react";

import { notify } from "@/components/notify";
import { Notice } from "@/components/PageHeader";
import { ErrorState, LoadingState, Spinner } from "@/components/states";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge, type Tone } from "@/components/ui/badge";
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
import { ViolationsPanel } from "@/components/ViolationsPanel";
import { fr } from "@/i18n/fr";
import { errorMessage, isApiError } from "@/lib/api";
import { formatLiters } from "@/lib/format";
import type { IsoDate } from "@/lib/types";

import {
  useResolveShortage,
  useShortageImpact,
  type ImpactedTripOut,
  type ResolveOut,
  type ShortageAction,
  type ShortageOut,
  type ShortageResolutionIn,
  type ShortageStatus,
} from "./api";
import { PlanResult } from "./PlanResult";

const t = fr.screens.events.impact;
const STATUS_TONE: Record<ShortageStatus, Tone> = {
  open: "warning",
  resolved: "success",
  no_impact: "muted",
};

function Figure({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={strong ? "num text-sm font-semibold text-warning" : "num text-sm"}>
        {formatLiters(value)}
      </dd>
    </div>
  );
}

/** Produit, dépôt, stocks et état d'une pénurie. */
export function ShortageOverview({ shortage }: { shortage: ShortageOut }) {
  return (
    <section className="rounded-md border px-3 py-2" data-testid="shortage-overview">
      <p className="flex items-center gap-2 text-sm font-medium">
        {t.stock(shortage.product_code, shortage.depot_code)}
        <Badge tone={STATUS_TONE[shortage.status]}>{t.status[shortage.status]}</Badge>
      </p>
      <dl className="mt-1.5 grid grid-cols-5 gap-2">
        <Figure label={t.figures.available} value={shortage.new_available_l} />
        <Figure label={t.figures.loaded} value={shortage.loaded_l} />
        <Figure label={t.figures.remaining} value={shortage.remaining_l} />
        <Figure label={t.figures.toLoad} value={shortage.planned_unloaded_l} />
        <Figure label={t.figures.shortfall} value={shortage.shortfall_l} strong={shortage.shortfall_l > 0} />
      </dl>
    </section>
  );
}

interface Decision {
  action: ShortageAction | "";
  depotId: string;
}

function TripCard({
  trip,
  decision,
  onChange,
  canResolve,
  showErrors,
}: {
  trip: ImpactedTripOut;
  decision: Decision;
  onChange: (next: Decision) => void;
  canResolve: boolean;
  showErrors: boolean;
}) {
  const decided = typeof trip.resolution?.text === "string" ? trip.resolution.text : null;
  const depot = trip.alternative_depots.find((item) => item.depot_id === decision.depotId);
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2" data-testid="impacted-trip">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="text-sm font-medium">
          {fr.screens.events.feed.trip(trip.trip_seq, trip.truck_plate)}
        </span>
        <StatusBadge kind="trip" value={trip.status} />
        {trip.driver_name && <span className="text-xs text-muted-foreground">{trip.driver_name}</span>}
        <span className="ml-auto text-xs">
          {t.planned} <span className="num">{formatLiters(trip.planned_l)}</span> · {t.covered}{" "}
          <span className="num">{formatLiters(trip.covered_l)}</span> ·{" "}
          <span className="font-medium text-warning">
            {t.shortfall} <span className="num">{formatLiters(trip.shortfall_l)}</span>
          </span>
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {t.orders(trip.orders.length)}
        {trip.orders.length > 0 && " : "}
        {trip.orders
          .map(
            (order) => `${order.station_name ?? order.station_code ?? ""} ${formatLiters(order.planned_l)}`,
          )
          .join(" · ")}
      </p>
      {decided ? (
        <p className="text-xs">{t.alreadyDecided(decided)}</p>
      ) : (
        canResolve && (
          <div className="flex flex-col gap-1">
            <div className="grid grid-cols-2 gap-2">
              <NativeSelect
                aria-label={t.decision(trip.trip_seq)}
                value={decision.action}
                onChange={(event) =>
                  onChange({ action: event.target.value as Decision["action"], depotId: "" })
                }
              >
                <option value="">{t.later}</option>
                {trip.options.map((option) => (
                  <option key={option} value={option}>
                    {t.actions[option]}
                  </option>
                ))}
              </NativeSelect>
              {decision.action === "change_depot" &&
                (trip.alternative_depots.length === 0 ? (
                  <p className="self-center text-xs text-muted-foreground">{t.noAlternative}</p>
                ) : (
                  <NativeSelect
                    aria-label={t.newDepot(trip.trip_seq)}
                    value={decision.depotId}
                    aria-invalid={showErrors && !decision.depotId}
                    onChange={(event) => onChange({ ...decision, depotId: event.target.value })}
                  >
                    <option value="">{fr.screens.events.shortage.choose}</option>
                    {trip.alternative_depots.map((item) => (
                      <option key={item.depot_id} value={item.depot_id}>
                        {t.depotOption(
                          item.code,
                          item.name,
                          item.remaining_l != null ? formatLiters(item.remaining_l) : null,
                          item.sufficient ?? null,
                        )}
                      </option>
                    ))}
                  </NativeSelect>
                ))}
            </div>
            {decision.action && (
              <p className="text-xs text-muted-foreground">{t.actionHints[decision.action]}</p>
            )}
            {decision.action === "change_depot" && showErrors && !decision.depotId && (
              <p className="text-xs text-destructive">{t.depotRequired}</p>
            )}
            {depot?.sufficient === false && <p className="text-xs text-warning">{t.insufficientDepot}</p>}
          </div>
        )
      )}
    </li>
  );
}

export function ImpactDialog({
  day,
  eventId,
  canResolve,
  onClose,
}: {
  day: IsoDate;
  eventId: string | null;
  canResolve: boolean;
  onClose: () => void;
}) {
  const ids = useId();
  const open = eventId !== null;
  const impact = useShortageImpact(eventId, open);
  const resolve = useResolveShortage(eventId);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [showErrors, setShowErrors] = useState(false);
  const [done, setDone] = useState<ResolveOut | null>(null);

  const restart = () => {
    setDecisions({});
    setShowErrors(false);
    setDone(null);
    resolve.reset();
  };
  useEffect(() => {
    if (open) restart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  const shortage = impact.data;
  const editable = canResolve && shortage?.status === "open";
  const chosen = Object.entries(decisions).filter(([, decision]) => decision.action !== "");
  const incomplete = chosen.some(([, decision]) => decision.action === "change_depot" && !decision.depotId);

  const submit = async () => {
    if (chosen.length === 0 || incomplete) {
      setShowErrors(true);
      return;
    }
    const resolutions = chosen.map(([trip_id, decision]): ShortageResolutionIn => ({
      trip_id,
      action: decision.action as ShortageAction,
      ...(decision.action === "change_depot" ? { depot_id: decision.depotId } : {}),
    }));
    try {
      setDone(await resolve.mutateAsync({ resolutions }));
      notify.success(t.done.toast);
    } catch {
      // L'erreur reste affichée dans la boîte (état de la mutation).
    }
  };

  const error = resolve.error;
  const remaining = done?.impacted_trips.filter((trip) => !trip.resolution).length ?? 0;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-3xl" aria-describedby={`${ids}-description`}>
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription id={`${ids}-description`}>
            {shortage?.event.summary ?? fr.screens.events.shortage.description}
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <>
            <DialogBody className="flex flex-col gap-3">
              <p className="text-sm font-medium">{t.done.title}</p>
              <ShortageOverview shortage={done} />
              {done.results.map((result) => (
                <PlanResult key={result.plan_id} result={result} day={day} onNavigate={onClose} />
              ))}
              <p className="text-sm">
                {done.status === "open" ? t.done.stillOpen(remaining) : t.done.resolved}
              </p>
            </DialogBody>
            <DialogFooter>
              {done.status === "open" && remaining > 0 && (
                <Button
                  variant="outline"
                  onClick={() => {
                    restart();
                    void impact.refetch();
                  }}
                >
                  {t.done.continue}
                </Button>
              )}
              <Button onClick={onClose}>{fr.common.close}</Button>
            </DialogFooter>
          </>
        ) : impact.isLoading ? (
          <DialogBody>
            <LoadingState compact />
          </DialogBody>
        ) : impact.error || !shortage ? (
          <DialogBody>
            <ErrorState compact error={impact.error} onRetry={() => impact.refetch()} />
          </DialogBody>
        ) : (
          <>
            <DialogBody className="flex flex-col gap-3">
              <ShortageOverview shortage={shortage} />
              {shortage.impacted_trips.length === 0 ? (
                <p className="text-sm">{t.none}</p>
              ) : (
                <section aria-label={t.impactedTitle(shortage.impacted_trips.length)}>
                  <h3 className="mb-1 text-sm font-medium">
                    {t.impactedTitle(shortage.impacted_trips.length)}
                  </h3>
                  <ul className="divide-y rounded-md border">
                    {shortage.impacted_trips.map((trip) => (
                      <TripCard
                        key={trip.trip_id}
                        trip={trip}
                        decision={decisions[trip.trip_id] ?? { action: "", depotId: "" }}
                        onChange={(next) => setDecisions((current) => ({ ...current, [trip.trip_id]: next }))}
                        canResolve={!!editable}
                        showErrors={showErrors}
                      />
                    ))}
                  </ul>
                </section>
              )}
              {!canResolve && shortage.status === "open" && <Notice tone="neutral">{t.readOnly}</Notice>}
              {showErrors && chosen.length === 0 && (
                <p role="alert" className="text-xs text-destructive">
                  {t.nothingChosen}
                </p>
              )}
              {error && (
                <Notice tone="blocking">
                  <strong className="font-semibold">{t.failed}.</strong> {errorMessage(error)}
                </Notice>
              )}
              {isApiError(error) && <ViolationsPanel violations={error.violations} hideWhenEmpty />}
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                {editable ? fr.common.cancel : fr.common.close}
              </Button>
              {editable && shortage.impacted_trips.length > 0 && (
                <Button onClick={() => void submit()} disabled={resolve.isPending}>
                  {resolve.isPending && <Spinner className="text-current" />}
                  {resolve.isPending ? t.submitting : t.submit}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
