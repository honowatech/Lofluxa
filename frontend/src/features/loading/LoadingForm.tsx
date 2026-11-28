/**
 * Formulaire de chargement par compartiment (F7.1, F7.2) : heures, bon dépôt, volume observé, température,
 * densité ; volume à 15 °C et écart calculés en direct (RM-12, RM-13). Pensé pour une saisie rapide au
 * clavier : Entrée passe au champ suivant, Ctrl + Entrée enregistre.
 */
import { AlertTriangle, CheckCircle2, Clock, Info, Lock, Save } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Notice } from "@/components/PageHeader";
import { NumberInput, TimeInput } from "@/components/forms";
import { notify } from "@/components/notify";
import { Spinner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fr } from "@/i18n/fr";
import { isApiError } from "@/lib/api";
import { formatLiters, formatNumber, formatPercent } from "@/lib/format";
import type { IsoDate } from "@/lib/types";
import { cn } from "@/lib/utils";

import {
  LOADING_EDITABLE,
  useSaveLoading,
  type Loading,
  type LoadingInput,
  type PlannedLoad,
  type Product,
  type TripLoading,
} from "./api";
import {
  computeGap,
  decomposeGap,
  isTimeHM,
  localTimeToUtc,
  nowLocalTime,
  utcToLocalTime,
  volumeAt15,
  type Gap,
  type GapParts,
} from "./conversion";

const t = fr.screens.loading;

interface Row {
  observed: number | null;
  temp: number | null;
  density: number | null;
}
interface Draft {
  arrived: string;
  started: string;
  finished: string;
  ticket: string;
  rows: Record<string, Row>;
}
type TimeKey = "arrived" | "started" | "finished";

const EMPTY_ROW: Row = { observed: null, temp: null, density: null };

function initialDraft(loads: PlannedLoad[], loading: Loading | null): Draft {
  const rows: Record<string, Row> = {};
  for (const load of loads) {
    const line = loading?.lines.find((item) => item.compartment_id === load.compartment_id);
    rows[load.compartment_id] = line
      ? { observed: line.observed_l, temp: line.observed_temp_c, density: line.observed_density ?? null }
      : { ...EMPTY_ROW };
  }
  return {
    arrived: utcToLocalTime(loading?.arrived_at),
    started: utcToLocalTime(loading?.started_at),
    finished: utcToLocalTime(loading?.finished_at),
    ticket: loading?.depot_ticket_no ?? "",
    rows,
  };
}

const valid = (value: number | null): value is number => value !== null && !Number.isNaN(value);
const rowFilled = (row: Row) => row.observed !== null || row.temp !== null || row.density !== null;

function signed(value: number, digits: number): string {
  const text = formatNumber(Math.abs(value), digits);
  return value > 0 ? `+${text}` : value < 0 ? `−${text}` : text;
}
function signedPct(value: number | null): string {
  if (value === null) return formatPercent(null);
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatPercent(Math.abs(value), 2)}`;
}
const liters = (value: number, digits = 0) => `${signed(value, digits)}\u00a0${t.form.litersUnit}`;

interface LineView {
  load: PlannedLoad;
  row: Row;
  /** Volume à 15 °C : valeur du serveur si la ligne n'a pas été modifiée, calcul en direct sinon. */
  at15: number | null;
  gap: Gap | null;
  /** Part de la température et part du volume chargé dans l'écart. */
  parts: GapParts | null;
  errors: { observed?: string; temp?: string; density?: string };
}

export interface LoadingFormProps {
  trip: TripLoading;
  loads: PlannedLoad[];
  loading: Loading | null;
  products: Product[];
  /** Tolérance RM-13 courante (`loading_tolerance_pct`), `null` si indisponible. */
  tolerancePct: number | null;
  canWrite: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}

export function LoadingForm({
  trip,
  loads,
  loading,
  products,
  tolerancePct,
  canWrite,
  onDirtyChange,
}: LoadingFormProps) {
  const day = trip.day as IsoDate;
  const [draft, setDraft] = useState<Draft>(() => initialDraft(loads, loading));
  const [pristine, setPristine] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const [serverDetails, setServerDetails] = useState<string[]>([]);
  const formRef = useRef<HTMLFormElement>(null);
  const save = useSaveLoading(trip.id);

  const editable = canWrite && LOADING_EDITABLE.includes(trip.status);
  const locked = !LOADING_EDITABLE.includes(trip.status);

  // Le chargement relu du serveur remplace la saisie tant que rien n'a été modifié localement.
  useEffect(() => {
    if (pristine) setDraft(initialDraft(loads, loading));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, loads]);
  useEffect(() => onDirtyChange?.(!pristine), [pristine, onDirtyChange]);

  const edit = (change: (current: Draft) => Draft) => {
    setDraft(change);
    setPristine(false);
    setServerDetails([]);
  };
  const setRow = (compartmentId: string, patch: Partial<Row>) =>
    edit((current) => ({
      ...current,
      rows: { ...current.rows, [compartmentId]: { ...current.rows[compartmentId], ...patch } },
    }));

  const tolerance = tolerancePct ?? loading?.tolerance_pct ?? null;
  const useServer = pristine && loading !== null;

  const lines = useMemo<LineView[]>(
    () =>
      loads.map((load) => {
        const row = draft.rows[load.compartment_id] ?? EMPTY_ROW;
        const saved = useServer
          ? loading?.lines.find((item) => item.compartment_id === load.compartment_id)
          : undefined;
        const errors: LineView["errors"] = {};
        if (rowFilled(row)) {
          if (!valid(row.observed) || row.observed <= 0) errors.observed = t.validation.observed;
          if (!valid(row.temp) || row.temp < -50 || row.temp > 100) errors.temp = t.validation.temperature;
          if (row.density !== null && (!valid(row.density) || row.density <= 0 || row.density >= 10))
            errors.density = t.validation.density;
        }
        let at15: number | null = null;
        let gap: Gap | null = null;
        let parts: GapParts | null = null;
        if (saved) {
          if (saved.gap_temperature_l !== null && saved.gap_observed_l !== null) {
            parts = {
              temperatureL: saved.gap_temperature_l,
              temperaturePct: saved.gap_temperature_pct,
              observedL: saved.gap_observed_l,
              observedPct: saved.gap_observed_pct,
            };
          }
          at15 = saved.volume_15_l;
          gap = {
            plannedL: saved.planned_l ?? load.planned_l,
            loadedL: saved.volume_15_l,
            gapL: saved.gap_l ?? 0,
            gapPct: saved.gap_pct ?? null,
            outOfTolerance: saved.out_of_tolerance,
          };
        } else if (useServer) {
          // Compartiment planifié mais absent du chargement enregistré : compte pour 0 L (L6-2).
          gap = computeGap(0, load.planned_l, tolerance);
        } else if (valid(row.observed) && valid(row.temp) && !errors.observed && !errors.temp) {
          const coeff = products.find((product) => product.id === load.product_id)?.thermal_coeff;
          if (coeff !== undefined) {
            at15 = volumeAt15(row.observed, row.temp, coeff);
            gap = computeGap(at15, load.planned_l, tolerance);
            parts = decomposeGap(row.observed, at15, load.planned_l);
          }
        }
        return { load, row, at15, gap, parts, errors };
      }),
    [loads, draft.rows, useServer, loading, products, tolerance],
  );

  const filled = lines.filter((line) => rowFilled(line.row));
  const anyFilled = useServer || filled.length > 0;
  const plannedTotal = loads.reduce((sum, load) => sum + load.planned_l, 0);
  const observedTotal = useServer
    ? (loading?.observed_total_l ?? 0)
    : lines.reduce((sum, line) => sum + (valid(line.row.observed) ? line.row.observed : 0), 0);
  const at15Total = useServer
    ? (loading?.volume_15_total_l ?? 0)
    : lines.reduce((sum, line) => sum + (line.at15 ?? 0), 0);
  const totalGap: Gap | null = !anyFilled
    ? null
    : useServer && loading
      ? {
          plannedL: loading.planned_total_l,
          loadedL: loading.volume_15_total_l,
          gapL: loading.gap_l,
          gapPct: loading.gap_pct ?? null,
          outOfTolerance: computeGap(
            loading.volume_15_total_l,
            loading.planned_total_l,
            loading.tolerance_pct,
          ).outOfTolerance,
        }
      : computeGap(at15Total, plannedTotal, tolerance);

  const totalParts: GapParts | null = !anyFilled
    ? null
    : useServer && loading
      ? {
          temperatureL: loading.gap_temperature_l,
          temperaturePct: loading.gap_temperature_pct,
          observedL: loading.gap_observed_l,
          observedPct: loading.gap_observed_pct,
        }
      : decomposeGap(observedTotal, at15Total, plannedTotal);

  // RM-13 : compartiments hors tolérance (un compartiment planifié non chargé compte pour 0 L) et total.
  const warnings: string[] = [];
  if (anyFilled) {
    for (const line of lines) {
      const position = line.load.compartment_position ?? "?";
      if (line.gap?.outOfTolerance) {
        warnings.push(t.rm13.compartment(position, liters(line.gap.gapL), signedPct(line.gap.gapPct)));
      } else if (!useServer && !rowFilled(line.row) && tolerance !== null) {
        warnings.push(
          t.rm13.compartment(
            position,
            t.form.notLoadedLine,
            signedPct(computeGap(0, line.load.planned_l, 0).gapPct),
          ),
        );
      }
    }
    if (totalGap?.outOfTolerance)
      warnings.push(t.rm13.total(liters(totalGap.gapL), signedPct(totalGap.gapPct)));
  }
  const toleranceLabel =
    tolerance === null ? "" : formatPercent(tolerance, Number.isInteger(tolerance) ? 0 : 2);

  /* ------------------------------------------------------------ validation */

  const timeErrors: Partial<Record<TimeKey, string>> = {};
  for (const key of ["arrived", "started", "finished"] as const) {
    if (draft[key] !== "" && !isTimeHM(draft[key])) timeErrors[key] = t.validation.time;
  }
  const times = (["arrived", "started", "finished"] as const).map((key) => draft[key]).filter(isTimeHM);
  const orderError = times.some((value, index) => index > 0 && value < times[index - 1])
    ? t.validation.order
    : null;
  const ticketError = draft.ticket.trim().length > 64 ? t.validation.ticket : null;
  const lineErrors = filled.flatMap((line) => Object.values(line.errors));
  const formErrors = [
    ...new Set([
      ...Object.values(timeErrors),
      ...(orderError ? [orderError] : []),
      ...(ticketError ? [ticketError] : []),
      ...lineErrors,
      ...(filled.length === 0 ? [t.validation.noLine] : []),
    ]),
  ];

  const submit = () => {
    setSubmitted(true);
    if (!editable || save.isPending || formErrors.length > 0) return;
    const at = (hm: string) => (hm === "" ? null : localTimeToUtc(day, hm));
    const input: LoadingInput = {
      arrived_at: at(draft.arrived),
      started_at: at(draft.started),
      finished_at: at(draft.finished),
      depot_ticket_no: draft.ticket.trim() || null,
      lines: filled.map((line) => ({
        compartment_id: line.load.compartment_id,
        product_id: line.load.product_id,
        observed_l: line.row.observed as number,
        observed_temp_c: line.row.temp as number,
        observed_density: line.row.density,
      })),
    };
    save.mutate(input, {
      onSuccess: (result) => {
        setDraft(initialDraft(loads, result));
        setPristine(true);
        setSubmitted(false);
        if (result.out_of_tolerance)
          notify.warning(t.form.savedWithWarning, result.warning_message ?? undefined);
        else notify.success(t.form.saved);
      },
      onError: (error) => {
        setServerDetails(
          isApiError(error)
            ? error.details.map((detail) => detail.message).filter((message): message is string => !!message)
            : [],
        );
        notify.apiError(error, t.form.saveFailed);
      },
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Enter") return;
    // Ctrl + Entrée enregistre, où que soit le focus dans le formulaire.
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      if (event.target instanceof HTMLElement) event.target.blur();
      submit();
      return;
    }
    if (!(event.target instanceof HTMLInputElement)) return;
    event.preventDefault();
    const fields = [
      ...(formRef.current?.querySelectorAll<HTMLElement>("input:not([disabled]), button[type=submit]") ?? []),
    ];
    fields[fields.indexOf(event.target) + 1]?.focus();
  };

  const saveError = save.error && isApiError(save.error) ? save.error : null;
  const big = "h-10 text-base";

  const timeField = (key: TimeKey, label: string) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`loading-${key}`} className="text-xs font-medium text-foreground/80">
        {label}
      </label>
      <div className="flex items-center gap-1">
        <TimeInput
          id={`loading-${key}`}
          value={draft[key]}
          onChange={(value) => edit((current) => ({ ...current, [key]: value }))}
          disabled={!editable}
          aria-invalid={submitted && (!!timeErrors[key] || !!orderError)}
          className={cn(big, "w-24")}
        />
        {editable && (
          <Button
            variant="outline"
            size="icon"
            className="size-10"
            aria-label={t.form.nowFor(label)}
            title={t.form.now}
            onClick={() => edit((current) => ({ ...current, [key]: nowLocalTime() }))}
          >
            <Clock aria-hidden />
          </Button>
        )}
      </div>
    </div>
  );

  if (loads.length === 0) return <Notice tone="neutral">{t.form.noPlannedLoads}</Notice>;

  return (
    <form
      ref={formRef}
      noValidate
      aria-label={t.form.title}
      className="flex flex-col gap-3"
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {locked && (
        <Notice tone="neutral" icon={<Lock className="size-3.5" aria-hidden />}>
          {loading ? t.form.locked(fr.status.trip[trip.status]) : t.form.lockedNoLoading}
        </Notice>
      )}

      <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
        {timeField("arrived", t.form.arrivedAt)}
        {timeField("started", t.form.startedAt)}
        {timeField("finished", t.form.finishedAt)}
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <label htmlFor="loading-ticket" className="text-xs font-medium text-foreground/80">
            {t.form.ticket}
          </label>
          <Input
            id="loading-ticket"
            value={draft.ticket}
            onChange={(event) => edit((current) => ({ ...current, ticket: event.target.value }))}
            placeholder={t.form.ticketPlaceholder}
            disabled={!editable}
            aria-invalid={submitted && !!ticketError}
            autoComplete="off"
            className={cn(big, "num max-w-xs")}
          />
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{t.form.compartments}</caption>
          <thead>
            <tr className="border-b bg-muted/60 text-left text-xs text-muted-foreground">
              <Th>{t.form.position}</Th>
              <Th>{t.form.product}</Th>
              <Th right>{t.form.planned}</Th>
              <Th className="w-32">{`${t.form.observed} (${t.form.litersUnit})`}</Th>
              <Th className="w-24">{`${t.form.temperature} (${t.form.tempUnit})`}</Th>
              <Th className="w-24">{`${t.form.density} (${t.form.densityUnit})`}</Th>
              <Th right>{t.form.at15}</Th>
              <Th right>{t.form.gap}</Th>
              <Th right>{t.form.gapPct}</Th>
            </tr>
          </thead>
          <tbody>
            {lines.map(({ load, row, at15, gap, parts, errors }) => {
              const position = load.compartment_position ?? 0;
              const out = gap?.outOfTolerance === true;
              return (
                <tr
                  key={load.compartment_id}
                  data-testid={`compartment-${position}`}
                  className={cn("border-b last:border-b-0", out && "bg-warning-soft/50")}
                >
                  <td className="px-2 py-1.5">
                    <span className="num inline-flex size-7 items-center justify-center rounded-sm border bg-muted text-sm font-semibold">
                      {position}
                    </span>
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="flex items-center gap-1.5 font-medium">
                      <span
                        className="size-2.5 shrink-0 rounded-full border"
                        style={{ background: load.product_color ?? undefined }}
                        aria-hidden
                      />
                      {load.product_label ?? load.product_code}
                    </span>
                    <span className="whitespace-nowrap text-xs text-muted-foreground">
                      {t.form.capacity} <span className="num">{formatLiters(load.capacity_l)}</span>
                    </span>
                  </td>
                  <td className="num px-2 py-1.5 text-right">{formatNumber(load.planned_l)}</td>
                  <td className="px-2 py-1.5">
                    <NumberInput
                      aria-label={t.form.observedFor(position)}
                      value={row.observed}
                      onChange={(value) => setRow(load.compartment_id, { observed: value })}
                      disabled={!editable}
                      aria-invalid={submitted && !!errors.observed}
                      grouped
                      className={big}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <NumberInput
                      aria-label={t.form.temperatureFor(position)}
                      value={row.temp}
                      onChange={(value) => setRow(load.compartment_id, { temp: value })}
                      disabled={!editable}
                      aria-invalid={submitted && !!errors.temp}
                      className={big}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <NumberInput
                      aria-label={t.form.densityFor(position)}
                      value={row.density}
                      onChange={(value) => setRow(load.compartment_id, { density: value })}
                      disabled={!editable}
                      aria-invalid={submitted && !!errors.density}
                      className={big}
                    />
                  </td>
                  <td className="num px-2 py-1.5 text-right text-base font-semibold" data-testid="at15">
                    {formatNumber(at15, 2)}
                  </td>
                  <td className={cn("num px-2 py-1.5 text-right", out && "font-semibold text-warning")}>
                    {gap ? signed(gap.gapL, 2) : formatNumber(null)}
                    {parts && (
                      <span
                        className="block whitespace-nowrap font-sans text-xs font-normal tabular-nums text-muted-foreground"
                        data-testid="gap-parts"
                      >
                        {t.form.partsShort(signed(parts.temperatureL, 0), signed(parts.observedL, 0))}
                      </span>
                    )}
                  </td>
                  <td className={cn("num px-2 py-1.5 text-right", out && "font-semibold text-warning")}>
                    <span className="inline-flex items-center justify-end gap-1">
                      {out && <AlertTriangle className="size-3.5" aria-hidden />}
                      {gap ? signedPct(gap.gapPct) : formatPercent(null)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr
              data-testid="loading-total"
              className={cn(
                "border-t-2 bg-muted/40 font-semibold",
                totalGap?.outOfTolerance && "bg-warning-soft/60",
              )}
            >
              <td className="px-2 py-2" colSpan={2}>
                {t.form.total}
              </td>
              <td className="num px-2 py-2 text-right">{formatNumber(plannedTotal)}</td>
              <td className="num px-2 py-2 pr-4 text-right">
                {anyFilled ? formatNumber(observedTotal) : ""}
              </td>
              <td colSpan={2} />
              <td className="num px-2 py-2 text-right text-base">
                {anyFilled ? formatNumber(at15Total, 2) : ""}
              </td>
              <td className={cn("num px-2 py-2 text-right", totalGap?.outOfTolerance && "text-warning")}>
                {totalGap ? signed(totalGap.gapL, 2) : ""}
              </td>
              <td className={cn("num px-2 py-2 text-right", totalGap?.outOfTolerance && "text-warning")}>
                {totalGap ? signedPct(totalGap.gapPct) : ""}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {anyFilled && warnings.length > 0 && (
        <Notice tone="warning" icon={<AlertTriangle className="size-4 shrink-0" aria-hidden />}>
          <p className="font-semibold" data-testid="rm13-warning">
            {t.rm13.title(toleranceLabel)}
          </p>
          <p>{warnings.join(" ; ")}.</p>
          {totalParts && (
            <p data-testid="rm13-parts">
              {t.rm13.parts(
                liters(totalParts.temperatureL),
                signedPct(totalParts.temperaturePct),
                liters(totalParts.observedL),
                signedPct(totalParts.observedPct),
              )}
            </p>
          )}
          {useServer && loading?.gap_explanation && <p>{loading.gap_explanation}</p>}
          {!useServer && <p className="opacity-80">{t.rm13.liveSuffix}</p>}
        </Notice>
      )}
      {anyFilled && warnings.length === 0 && tolerance !== null && lineErrors.length === 0 && (
        <Notice tone="success" icon={<CheckCircle2 className="size-4 shrink-0" aria-hidden />}>
          {t.rm13.within(toleranceLabel)}
        </Notice>
      )}
      {tolerance === null && <Notice tone="neutral">{t.form.toleranceUnknown}</Notice>}

      {submitted && formErrors.length > 0 && (
        <Notice tone="blocking">
          <ul className="list-inside list-disc">
            {formErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </Notice>
      )}
      {saveError && (
        <Notice tone="blocking">
          <p className="font-semibold">{t.errors[saveError.code] ?? saveError.message}</p>
          {t.errors[saveError.code] && <p>{saveError.message}</p>}
          {serverDetails.length > 0 && (
            <ul className="list-inside list-disc">
              {serverDetails.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </Notice>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {editable && (
          <>
            <Button type="submit" size="lg" className="h-11 px-5 text-base" disabled={save.isPending}>
              {save.isPending ? <Spinner className="text-current" /> : <Save aria-hidden />}
              {save.isPending ? fr.common.saving : loading ? t.form.update : t.form.save}
            </Button>
            {!loading && (
              <Button
                variant="outline"
                size="lg"
                className="h-11"
                onClick={() =>
                  edit((current) => ({
                    ...current,
                    rows: Object.fromEntries(
                      loads.map((load) => [
                        load.compartment_id,
                        { ...(current.rows[load.compartment_id] ?? EMPTY_ROW), observed: load.planned_l },
                      ]),
                    ),
                  }))
                }
              >
                {t.form.copyPlanned}
              </Button>
            )}
            <span className="text-xs text-muted-foreground">{t.form.saveShortcut}</span>
          </>
        )}
        {loading?.entered_by_name && (
          <span className="ml-auto text-xs text-muted-foreground">
            {t.form.enteredBy(loading.entered_by_name)}
          </span>
        )}
      </div>

      <p className="flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="astm-note">
        <Info className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>
          {t.form.astmNote} {editable && t.form.liveHint}{" "}
          <span className="whitespace-nowrap">
            {[...new Set(loads.map((load) => load.product_id))]
              .map((id) => products.find((product) => product.id === id))
              .filter((product): product is Product => !!product)
              .map((product) => t.form.coefficient(product.code, formatNumber(product.thermal_coeff, 5)))
              .join(" · ")}
          </span>
        </span>
      </p>
    </form>
  );
}

function Th({ children, right, className }: { children: ReactNode; right?: boolean; className?: string }) {
  return (
    <th
      scope="col"
      className={cn("whitespace-nowrap px-2 py-1.5 font-medium", right && "text-right", className)}
    >
      {children}
    </th>
  );
}
