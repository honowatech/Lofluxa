/**
 * Un arrêt de la tournée : heures prévues / réelles, volumes livrés par commande, arrêt sauté (motif).
 * La saisie n'est ouverte que sur une tournée « En cours » ; livré ↔ sauté n'est pas réversible (question L6-13).
 */
import { Ban, Check, Clock, Pencil, Save } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Notice } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { NumberInput, TimeInput } from "@/components/forms";
import { notify } from "@/components/notify";
import { Spinner } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fr } from "@/i18n/fr";
import { isApiError } from "@/lib/api";
import { formatDuration, formatLiters, formatLocalTime } from "@/lib/format";
import type { IsoDate } from "@/lib/types";
import { cn } from "@/lib/utils";

import { useRecordDelivery, type PlanStop } from "./api";
import { delaySeconds, isTimeHM, localTimeToUtc, nowLocalTime, utcToLocalTime } from "./time";

const t = fr.screens.deliveries;

export function DelayBadge({ seconds, className }: { seconds: number | null; className?: string }) {
  if (seconds === null) return null;
  const minutes = Math.round(seconds / 60);
  const duration = formatDuration(Math.abs(minutes) * 60);
  return (
    <Badge
      tone={minutes > 0 ? "warning" : "success"}
      className={className}
      title={t.delay.label}
      data-testid="delay"
    >
      {minutes > 0 ? t.delay.late(duration) : minutes < 0 ? t.delay.early(duration) : t.delay.onTime}
    </Badge>
  );
}

type Mode = "view" | "deliver" | "skip";

export function StopCard({
  stop,
  day,
  writable,
  autoFocus,
}: {
  stop: PlanStop;
  day: IsoDate;
  /** Vrai si l'utilisateur peut écrire ET si la tournée est en cours. */
  writable: boolean;
  autoFocus?: boolean;
}) {
  const record = useRecordDelivery(stop.id);
  const pending = stop.status === "pending";
  const [mode, setMode] = useState<Mode>("view");
  const [arrival, setArrival] = useState(utcToLocalTime(stop.actual_arrival_at));
  const [departure, setDeparture] = useState(utcToLocalTime(stop.actual_departure_at));
  // Volume proposé : celui déjà saisi, sinon le volume planifié (cas courant : livraison conforme).
  const [volumes, setVolumes] = useState<Record<string, number | null>>(() =>
    Object.fromEntries(stop.deliveries.map((line) => [line.order_id, line.actual_l ?? line.planned_l])),
  );
  const [reason, setReason] = useState("");
  const [submitted, setSubmitted] = useState(false);

  // Le premier arrêt à livrer est ouvert d'office ; les suivants s'ouvrent à la demande (peu de défilement).
  const form: Mode = writable && pending && autoFocus && mode === "view" ? "deliver" : mode;
  const editing = writable && form !== "view";
  const error = record.error && isApiError(record.error) ? record.error : null;

  const problems: string[] = [];
  if (form === "deliver") {
    if (!isTimeHM(arrival)) problems.push(t.validation.arrival);
    if (departure !== "" && !isTimeHM(departure)) problems.push(t.validation.time);
    if (isTimeHM(arrival) && isTimeHM(departure) && departure < arrival) problems.push(t.validation.order);
    if (
      stop.deliveries.some(
        ({ order_id }) => !(typeof volumes[order_id] === "number" && volumes[order_id]! >= 0),
      )
    )
      problems.push(t.validation.volume);
  } else if (form === "skip") {
    if (arrival !== "" && !isTimeHM(arrival)) problems.push(t.validation.time);
    if (reason.trim() === "") problems.push(t.validation.reason);
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!editing || record.isPending || problems.length > 0) return;
    const at = (hm: string) => (isTimeHM(hm) ? localTimeToUtc(day, hm) : null);
    const input =
      form === "skip"
        ? { actual_arrival_at: at(arrival), skip_reason: reason.trim() }
        : {
            actual_arrival_at: at(arrival),
            actual_departure_at: at(departure),
            deliveries: stop.deliveries.map((line) => ({
              order_id: line.order_id,
              actual_l: volumes[line.order_id] as number,
            })),
          };
    record.mutate(input, {
      onSuccess: () => {
        notify.success(form === "skip" ? t.stop.skipped(stop.seq) : t.stop.saved(stop.seq));
        setMode("view");
        setSubmitted(false);
      },
      // L'explication reste lisible même si le rechargement referme le formulaire (tournée clôturée ailleurs…).
      onError: (failure) =>
        isApiError(failure) && t.errors[failure.code]
          ? notify.error(t.errors[failure.code], failure.message)
          : notify.apiError(failure, t.stop.failed),
    });
  };

  const delay =
    stop.status === "pending" ? null : delaySeconds(stop.planned_arrival_at, stop.actual_arrival_at);
  const big = "h-10 text-base";

  const timeField = (
    label: string,
    aria: string,
    value: string,
    onChange: (value: string) => void,
    focus?: boolean,
  ) => (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-foreground/80">{label}</span>
      <div className="flex items-center gap-1">
        <TimeInput
          aria-label={aria}
          value={value}
          onChange={onChange}
          autoFocus={focus}
          aria-invalid={submitted && value !== "" && !isTimeHM(value)}
          className={cn(big, "w-24")}
        />
        <Button
          variant="outline"
          size="icon"
          className="size-10"
          aria-label={t.stop.nowFor(aria)}
          title={t.stop.now}
          onClick={() => onChange(nowLocalTime())}
        >
          <Clock aria-hidden />
        </Button>
      </div>
    </div>
  );

  return (
    <li
      data-testid={`stop-${stop.seq}`}
      className={cn(
        "rounded-md border bg-card",
        stop.status === "delivered" && "border-success/30",
        stop.status === "skipped" && "border-warning/40",
        editing && pending && "border-primary/60 shadow-[inset_3px_0_0_hsl(var(--primary))]",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
        <span
          className={cn(
            "num inline-flex size-7 shrink-0 items-center justify-center rounded-full border text-sm font-semibold",
            stop.status === "delivered" && "border-success bg-success text-white",
            stop.status === "skipped" && "border-warning bg-warning-soft text-warning",
          )}
        >
          {stop.status === "delivered" ? <Check className="size-4" aria-hidden /> : stop.seq}
        </span>
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">
            {t.stop.title(stop.seq, stop.station_name ?? stop.station_code ?? "")}
          </h3>
          <p className="text-xs text-muted-foreground">
            <span className="num">{stop.station_code}</span>
            {stop.station_city ? ` · ${stop.station_city}` : ""} · {t.stop.planned}{" "}
            <span className="num">
              {t.stop.plannedWindow(
                formatLocalTime(stop.planned_arrival_at),
                formatLocalTime(stop.planned_departure_at),
              )}
            </span>
            {stop.actual_arrival_at && (
              <>
                {" "}
                · {t.stop.actual}{" "}
                <span className="num font-medium text-foreground">
                  {formatLocalTime(stop.actual_arrival_at)}
                  {stop.actual_departure_at ? ` → ${formatLocalTime(stop.actual_departure_at)}` : ""}
                </span>
              </>
            )}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <DelayBadge seconds={delay} />
          <StatusBadge kind="stop" value={stop.status} />
          {writable && stop.status === "delivered" && mode === "view" && (
            <Button variant="outline" size="sm" onClick={() => setMode("deliver")}>
              <Pencil aria-hidden />
              {t.stop.edit}
            </Button>
          )}
          {writable && pending && form === "view" && (
            <Button variant="outline" size="sm" onClick={() => setMode("deliver")}>
              <Pencil aria-hidden />
              {t.stop.open}
            </Button>
          )}
        </div>
      </div>

      {!editing ? (
        <div className="flex flex-col gap-1 border-t px-3 py-2">
          <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            {stop.deliveries.map((line) => (
              <li key={line.id} className="flex items-center gap-1.5">
                <span
                  className="size-2.5 rounded-full border"
                  style={{ background: line.product_color ?? undefined }}
                  aria-hidden
                />
                <span className="font-medium">{line.product_label ?? line.product_code}</span>
                {stop.status === "delivered" ? (
                  <>
                    <span className="num font-semibold">{formatLiters(line.actual_l)}</span>
                    <span className="text-xs text-muted-foreground">
                      ({t.stop.plannedVolume(formatLiters(line.planned_l))})
                    </span>
                  </>
                ) : (
                  <span className="num text-muted-foreground">{formatLiters(line.planned_l)}</span>
                )}
                {line.order_status && stop.status !== "pending" && (
                  <StatusBadge kind="order" value={line.order_status} />
                )}
              </li>
            ))}
          </ul>
          {stop.status === "skipped" && (
            <>
              <p className="text-sm">{t.stop.skippedBecause(stop.skip_reason ?? "")}</p>
              <p className="text-xs text-muted-foreground">{t.stop.skippedLocked}</p>
            </>
          )}
          {stop.status === "delivered" && writable && (
            <p className="text-xs text-muted-foreground">{t.stop.deliveredLocked}</p>
          )}
        </div>
      ) : (
        <form noValidate onSubmit={submit} className="flex flex-col gap-2 border-t px-3 py-2.5">
          {form === "deliver" ? (
            <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
              {timeField(t.stop.arrival, t.stop.arrivalFor(stop.seq), arrival, setArrival, autoFocus)}
              {timeField(t.stop.departure, t.stop.departureFor(stop.seq), departure, setDeparture)}
              {stop.deliveries.map((line) => {
                const product = line.product_label ?? line.product_code ?? "";
                const value = volumes[line.order_id];
                return (
                  <div key={line.id} className="flex flex-col gap-1">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-foreground/80">
                      <span
                        className="size-2.5 rounded-full border"
                        style={{ background: line.product_color ?? undefined }}
                        aria-hidden
                      />
                      {product}
                      <span className="font-normal text-muted-foreground">
                        {t.stop.plannedVolume(formatLiters(line.planned_l))}
                      </span>
                    </span>
                    <div className="w-36">
                      <NumberInput
                        aria-label={t.stop.volumeFor(product, stop.seq)}
                        value={value}
                        onChange={(next) => setVolumes((current) => ({ ...current, [line.order_id]: next }))}
                        unit={t.stop.litersUnit}
                        grouped
                        aria-invalid={submitted && !(typeof value === "number" && value >= 0)}
                        className={big}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
              {timeField(t.stop.arrival, t.stop.arrivalFor(stop.seq), arrival, setArrival)}
              <div className="flex min-w-64 flex-1 flex-col gap-1">
                <span className="text-xs font-medium text-foreground/80">{t.stop.skipReason}</span>
                <Input
                  aria-label={t.stop.skipReasonFor(stop.seq)}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder={t.stop.skipPlaceholder}
                  autoFocus
                  aria-invalid={submitted && reason.trim() === ""}
                  className={big}
                />
              </div>
            </div>
          )}

          {form === "deliver" && stop.deliveries.some((line) => volumes[line.order_id] === 0) && (
            <p className="text-xs text-warning">{t.stop.zeroHint}</p>
          )}
          {form === "skip" && <p className="text-xs text-warning">{t.stop.skipWarning}</p>}
          {submitted && problems.length > 0 && (
            <Notice tone="blocking">
              <ul className="list-inside list-disc">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </Notice>
          )}
          {error && (
            <Notice tone="blocking">
              <p className="font-semibold">{t.errors[error.code] ?? t.stop.failed}</p>
              <p>{error.message}</p>
            </Notice>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              size="lg"
              variant={form === "skip" ? "destructive" : "default"}
              className="h-10 px-4"
              disabled={record.isPending}
            >
              {record.isPending ? (
                <Spinner className="text-current" />
              ) : form === "skip" ? (
                <Ban aria-hidden />
              ) : (
                <Save aria-hidden />
              )}
              {form === "skip" ? t.stop.skipConfirm : pending ? t.stop.save : t.stop.update}
            </Button>
            {form === "deliver" && pending && (
              <Button
                variant="destructive-outline"
                className="h-10"
                onClick={() => {
                  setMode("skip");
                  setSubmitted(false);
                  record.reset();
                }}
              >
                <Ban aria-hidden />
                {t.stop.skip}
              </Button>
            )}
            {(form === "skip" || !pending || !autoFocus) && (
              <Button
                variant="ghost"
                className="h-10"
                onClick={() => {
                  setMode("view");
                  setSubmitted(false);
                  record.reset();
                }}
              >
                {fr.common.cancel}
              </Button>
            )}
          </div>
        </form>
      )}
    </li>
  );
}
