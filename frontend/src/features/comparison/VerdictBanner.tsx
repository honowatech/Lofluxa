/**
 * Verdict du test A/B, lisible en trois secondes : l'écart kilométrique en grand, les deux kilométrages
 * à la même échelle avec l'objectif, puis les trois critères. Tout vient du champ `verdict` de
 * `GET /comparison` ; un résultat défavorable est affiché avec la même force qu'un résultat favorable.
 */
import { CircleCheck, CircleHelp, CircleX, Info, TriangleAlert } from "lucide-react";

import { fr } from "@/i18n/fr";
import { formatKm, formatNumber, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { Comparison } from "./api";
import { formatDelta, formatDeltaPct } from "./metricFormat";
import { SIDE_BG, SideChip } from "./shared";

const t = fr.screens.comparison.verdict;

type Outcome = "success" | "reserve" | "failure" | "unknown";

/** Ton de l'en-tête : l'objectif kilométrique (critère 2) et les deux conditions du critère 1 de la spec §13. */
export function verdictOutcome(verdict: Comparison["verdict"]): Outcome {
  if (verdict.success === null) return "unknown";
  if (!verdict.success) return "failure";
  return verdict.no_blocking_violation && verdict.orders_served_ok ? "success" : "reserve";
}

const TONE: Record<Outcome, { box: string; text: string; icon: typeof CircleCheck }> = {
  success: { box: "border-success/40 bg-success-soft/50", text: "text-success", icon: CircleCheck },
  reserve: { box: "border-warning/45 bg-warning-soft/50", text: "text-warning", icon: TriangleAlert },
  failure: { box: "border-blocking/40 bg-blocking-soft/60", text: "text-blocking", icon: CircleX },
  unknown: { box: "border-border bg-muted/60", text: "text-muted-foreground", icon: CircleHelp },
};

function Criterion({ ok, label, value }: { ok: boolean | null; label: string; value: string }) {
  const Icon = ok === null ? CircleHelp : ok ? CircleCheck : CircleX;
  const state = ok === null ? t.unknown : ok ? t.met : t.notMet;
  return (
    <li className="flex items-start gap-2" data-met={ok === null ? "unknown" : String(ok)}>
      <Icon
        aria-hidden
        className={cn(
          "mt-0.5 size-4 shrink-0",
          ok === null ? "text-muted-foreground" : ok ? "text-success" : "text-blocking",
        )}
      />
      <div className="min-w-0">
        <p className="text-sm font-medium leading-snug">
          {label}
          <span className="sr-only"> — {state}</span>
        </p>
        <p
          className={cn(
            "text-xs tabular-nums",
            ok === false ? "font-medium text-blocking" : "text-muted-foreground",
          )}
        >
          {value}
        </p>
      </div>
    </li>
  );
}

/** Deux barres à la même échelle (km estimés de A et de B) et le repère de l'objectif. */
function DistanceBars({ verdict }: { verdict: Comparison["verdict"] }) {
  const max = Math.max(verdict.distance_a_m, verdict.distance_b_m);
  const share = (meters: number) => (max > 0 ? (meters / max) * 100 : 0);
  const targetM = verdict.distance_a_m * (1 - verdict.threshold_pct / 100);
  const showTarget = max > 0 && verdict.distance_a_m > 0;
  const rows = [
    { side: "a" as const, meters: verdict.distance_a_m },
    { side: "b" as const, meters: verdict.distance_b_m },
  ];
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground/60">{t.barsTitle}</h3>
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5">
        {rows.map(({ side, meters }) => (
          <div key={side} className="contents">
            <SideChip side={side} />
            <div className="relative h-5">
              <div
                role="img"
                aria-label={t.barLabel(side.toUpperCase(), formatKm(meters))}
                className={cn("h-full min-w-0.5 rounded-r-[4px]", SIDE_BG[side])}
                style={{ width: `${share(meters)}%` }}
              />
              {showTarget && (
                <span
                  aria-hidden
                  className="absolute -inset-y-1 w-0 border-l-2 border-dashed border-foreground/70"
                  style={{ left: `${share(targetM)}%` }}
                />
              )}
            </div>
            <span className="num text-right text-sm font-medium">{formatKm(meters)}</span>
          </div>
        ))}
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        {showTarget && (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="h-3 w-0 border-l-2 border-dashed border-foreground/70" />
            {t.target(formatKm(targetM), formatPercent(verdict.threshold_pct, 1))}
          </span>
        )}
        <span className="tabular-nums">{t.gap(formatDelta("m", -verdict.gain_m))}</span>
      </p>
    </div>
  );
}

export function VerdictBanner({ comparison }: { comparison: Comparison }) {
  const { verdict, metrics_a: a, metrics_b: b, plan_a: planA, plan_b: planB } = comparison;
  const outcome = verdictOutcome(verdict);
  const tone = TONE[outcome];
  const Icon = tone.icon;

  // Variation du kilométrage de B par rapport à A : l'opposé du gain renvoyé par le serveur.
  const variation = verdict.gain_pct === null ? null : -verdict.gain_pct;
  const caption =
    variation === null ? null : variation === 0 ? t.heroEqual : variation < 0 ? t.heroLess : t.heroMore;

  const approximate =
    planA.approximate && planB.approximate
      ? t.approximateBoth
      : planA.approximate
        ? t.approximateOne("A")
        : planB.approximate
          ? t.approximateOne("B")
          : null;

  return (
    <section
      aria-labelledby="verdict-heading"
      data-testid="verdict"
      data-outcome={outcome}
      className={cn("rounded-md border border-l-4 px-4 py-3", tone.box)}
    >
      <h2 id="verdict-heading" className="sr-only">
        {t.heading}
      </h2>
      <div className="grid gap-x-8 gap-y-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1.25fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-1">
          <p
            className={cn(
              "flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide",
              tone.text,
            )}
            data-testid="verdict-status"
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            {t.status[outcome]}
          </p>
          {variation === null ? (
            <p className="text-2xl font-semibold leading-tight">{t.heroUnknown}</p>
          ) : (
            <p className="flex flex-wrap items-baseline gap-x-2" data-testid="verdict-hero">
              <span className="text-[2.5rem] font-semibold tabular-nums leading-none tracking-tight">
                {formatDeltaPct(variation)}
              </span>
              <span className="text-sm font-medium text-foreground/80">{caption}</span>
            </p>
          )}
          <p className="text-sm leading-snug text-foreground/90" data-testid="verdict-message">
            {verdict.message}
          </p>
        </div>

        <div className="flex min-w-0 flex-col justify-center gap-2">
          <DistanceBars verdict={verdict} />
          {verdict.gain_vs_actual_pct !== null && a.distance_actual_m !== null && (
            <p className="text-xs text-muted-foreground">
              {t.vsActual(formatDeltaPct(-verdict.gain_vs_actual_pct), formatKm(a.distance_actual_m))}
            </p>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground/60">
            {t.criteriaTitle}
          </h3>
          <ul className="flex flex-col gap-1.5">
            <Criterion
              ok={verdict.success}
              label={t.criteria.gain(formatPercent(verdict.threshold_pct, 1))}
              value={
                verdict.gain_pct === null
                  ? t.criteria.gainUnknown
                  : t.criteria.gainValue(
                      `${verdict.gain_pct < 0 ? "−" : ""}${formatPercent(Math.abs(verdict.gain_pct), 1)}`,
                    )
              }
            />
            <Criterion
              ok={verdict.orders_served_ok}
              label={t.criteria.orders}
              value={t.criteria.ordersValue(formatNumber(b.orders_served), formatNumber(a.orders_served))}
            />
            <Criterion
              ok={verdict.no_blocking_violation}
              label={t.criteria.blocking}
              value={t.criteria.blockingValue(b.violations_blocking)}
            />
          </ul>
        </div>
      </div>

      {approximate && (
        <p
          className="mt-3 flex items-start gap-1.5 border-t border-foreground/10 pt-2 text-xs text-foreground/75"
          data-testid="verdict-approximate"
        >
          <Info className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            <strong className="font-semibold">{t.approximateTitle}.</strong> {t.approximate(approximate)}
          </span>
        </p>
      )}
    </section>
  );
}
