/**
 * Écran 9 — Comparaison A / B (spec §10, F8) : choix de deux plans, verdict, tableau d'indicateurs avec
 * écarts, deux cartes côte à côte, export PDF ; import de la journée de référence et rejeu par le moteur
 * (dispatcher) ; volet « Suivi de la journée B » (F8.6).
 *
 * La sélection vit dans l'URL (`a`, `b`, `da`, `db`, `vue`) : un lien copié rouvre la même comparaison.
 */
import { Lock, Play, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import {
  EmptyState,
  ErrorState,
  LoadingState,
  Notice,
  notify,
  PageHeader,
  PdfButton,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tip,
} from "@/components";
import { Button } from "@/components/ui/button";
import { fr } from "@/i18n/fr";
import { useCan } from "@/lib/auth";
import { isValidDay } from "@/lib/format";
import type { IsoDate } from "@/lib/types";
import { useDay } from "@/lib/useDay";

import { useComparison, useInvalidatePlans, usePlans, type PlanRow, type ReferenceDayImport } from "./api";
import { DashboardPanel } from "./DashboardPanel";
import { MetricsTable } from "./MetricsTable";
import { PlanPicker } from "./PlanPicker";
import { ReferenceDayDialog } from "./ReferenceDayDialog";
import { RouteMaps } from "./RouteMaps";
import { useReplay } from "./useReplay";
import { VerdictBanner } from "./VerdictBanner";

const t = fr.screens.comparison;

const VIEWS = ["comparaison", "suivi"] as const;
type View = (typeof VIEWS)[number];

interface Selection {
  a: string | null;
  b: string | null;
  da: IsoDate;
  db: IsoDate;
}

/**
 * Présélection : en A, la journée de référence du jour (non archivée, la plus récente) ; en B, son dernier
 * rejeu, à défaut la version publiée la plus récente du plan calculé du jour (journée B : une panne ou une
 * pénurie crée une nouvelle version publiée et archive l'ancienne).
 * `plans` est trié du plus récent au plus ancien par l'API.
 */
export function preselect(plans: PlanRow[]): { a: string | null; b: string | null } {
  const reference = plans.find((plan) => plan.kind === "manual_reference" && plan.status !== "archived");
  const replay = reference
    ? plans.find(
        (plan) =>
          plan.kind === "replay" && plan.parent_plan_id === reference.id && plan.status !== "archived",
      )
    : undefined;
  const published = plans
    .filter((plan) => plan.kind === "computed" && plan.status === "published")
    .sort((x, y) => y.version - x.version)[0];
  return { a: reference?.id ?? null, b: replay?.id ?? published?.id ?? null };
}

export default function ComparisonPage() {
  const { day } = useDay();
  const canWrite = useCan("comparison.write");
  const [params, setParams] = useSearchParams();
  const [importOpen, setImportOpen] = useState(false);
  const invalidatePlans = useInvalidatePlans();

  const requestedView = params.get("vue");
  const view: View = VIEWS.includes(requestedView as View) ? (requestedView as View) : "comparaison";

  const paramDay = (name: string): IsoDate => {
    const value = params.get(name);
    return isValidDay(value) ? value : day;
  };
  const dayA = paramDay("da");
  const dayB = paramDay("db");
  const explicit = ["a", "b", "da", "db"].some((name) => params.has(name));

  const plansA = usePlans(dayA);
  const plansB = usePlans(dayB);

  // Sans choix dans l'URL, les deux côtés portent sur le jour J : présélection de la référence et de son rejeu.
  const auto = useMemo(
    () => (explicit || !plansA.data ? { a: null, b: null } : preselect(plansA.data)),
    [explicit, plansA.data],
  );
  const selection: Selection = useMemo(
    () => ({
      a: explicit ? params.get("a") : auto.a,
      b: explicit ? params.get("b") : auto.b,
      da: dayA,
      db: dayB,
    }),
    [explicit, params, auto, dayA, dayB],
  );

  const select = useCallback(
    (change: Partial<Selection>, options: { replace?: boolean } = {}) => {
      const next = { ...selection, ...change };
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          for (const name of ["a", "b"] as const) {
            const value = next[name];
            if (value) updated.set(name, value);
            else updated.delete(name);
          }
          updated.set("da", next.da);
          updated.set("db", next.db);
          return updated;
        },
        { replace: options.replace ?? false },
      );
    },
    [selection, setParams],
  );

  const comparison = useComparison(selection.a, selection.b);
  const result = comparison.data;

  // Lien ouvert sans `da` / `db` (ou avec un jour erroné) : les sélecteurs se calent sur le jour réel des plans.
  useEffect(() => {
    if (!result || !explicit) return;
    if (result.plan_a.id !== selection.a || result.plan_b.id !== selection.b) return;
    if (result.plan_a.day !== selection.da || result.plan_b.day !== selection.db) {
      select({ da: result.plan_a.day, db: result.plan_b.day }, { replace: true });
    }
  }, [result, explicit, selection, select]);

  const planA = plansA.data?.find((plan) => plan.id === selection.a) ?? null;

  const replay = useReplay((referenceId, replayId) => {
    void invalidatePlans();
    notify.success(t.replay.done);
    select({ a: referenceId, b: replayId, db: selection.da });
  });

  const replayBlocked = !selection.a
    ? t.actions.replayHintNoPlan
    : (result?.plan_a.id === selection.a ? result.plan_a.kind : planA?.kind) !== "manual_reference"
      ? t.actions.replayHintNotReference
      : planA?.status === "archived"
        ? t.actions.replayHintArchived
        : null;

  const onImported = (imported: ReferenceDayImport) => {
    void invalidatePlans();
    if (!imported.plan_id) return;
    const importedDay = imported.day ?? selection.da;
    select({ a: imported.plan_id, b: null, da: importedDay, db: importedDay });
  };

  const replayButton = (primary: boolean) =>
    canWrite && (
      <Tip label={replayBlocked}>
        <span>
          <Button
            variant={primary ? "default" : "outline"}
            disabled={!!replayBlocked || replay.running}
            onClick={() => selection.a && void replay.run(selection.a)}
          >
            {replay.running ? <Spinner className="text-current" /> : <Play />}
            {selection.b ? t.actions.replayAgain : t.actions.replay}
          </Button>
        </span>
      </Tip>
    );

  const importButton = (primary: boolean) =>
    canWrite && (
      <Button variant={primary ? "default" : "outline"} onClick={() => setImportOpen(true)}>
        <Upload />
        {t.actions.import}
      </Button>
    );

  const pdfReady = !!result && !comparison.isFetching;

  let body;
  if (plansA.isLoading || plansB.isLoading) {
    body = <LoadingState />;
  } else if (!selection.a && !selection.b) {
    body = (
      <EmptyState
        className="rounded-md border bg-card"
        title={t.empty.title}
        description={canWrite ? t.empty.bodyWrite : t.empty.body}
        action={importButton(true)}
      />
    );
  } else if (!selection.b) {
    body = (
      <EmptyState
        className="rounded-md border bg-card"
        title={t.empty.needB}
        description={canWrite && !replayBlocked ? t.empty.needBReplay : t.empty.needBBody}
        action={!replayBlocked ? replayButton(true) : undefined}
      />
    );
  } else if (!selection.a) {
    body = (
      <EmptyState
        className="rounded-md border bg-card"
        title={t.empty.needA}
        description={t.empty.needABody}
      />
    );
  } else if (selection.a === selection.b) {
    body = <Notice tone="warning">{t.picker.samePlan}</Notice>;
  } else if (comparison.isLoading) {
    body = <LoadingState />;
  } else if (comparison.error) {
    body = <ErrorState error={comparison.error} onRetry={() => void comparison.refetch()} />;
  } else if (result) {
    body = (
      <>
        <VerdictBanner comparison={result} />
        <MetricsTable comparison={result} />
        <RouteMaps key={`${result.plan_a.id}:${result.plan_b.id}`} comparison={result} />
      </>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4" data-testid="screen-comparison">
      <PageHeader
        title={t.title}
        subtitle={t.subtitle}
        actions={
          <>
            {importButton(false)}
            {replayButton(false)}
            <Tip label={pdfReady ? null : t.actions.pdfHint}>
              <span>
                <PdfButton
                  path="/comparison.pdf"
                  query={{ plan_a: selection.a, plan_b: selection.b }}
                  label={t.actions.pdf}
                  fallbackName={t.actions.pdfName(result?.plan_a.day ?? day)}
                  disabled={!pdfReady}
                />
              </span>
            </Tip>
          </>
        }
      />

      {!canWrite && (
        <Notice tone="neutral" icon={<Lock className="size-3.5" />}>
          {t.readOnly}
        </Notice>
      )}

      <Tabs
        value={view}
        onValueChange={(value) =>
          setParams(
            (current) => {
              const updated = new URLSearchParams(current);
              if (value === "comparaison") updated.delete("vue");
              else updated.set("vue", value);
              return updated;
            },
            { replace: true },
          )
        }
        className="flex flex-col"
      >
        <TabsList>
          <TabsTrigger value="comparaison">{t.tabs.comparison}</TabsTrigger>
          <TabsTrigger value="suivi">{t.tabs.dashboard}</TabsTrigger>
        </TabsList>

        <TabsContent value="comparaison" className="flex flex-col gap-4 pt-3">
          <PlanPicker
            auto={!explicit}
            a={{
              day: selection.da,
              planId: selection.a,
              plans: plansA.data,
              loading: plansA.isFetching,
              error: plansA.error,
              onDayChange: (next) => select({ da: next, a: null }),
              onPlanChange: (id) => select({ a: id }),
            }}
            b={{
              day: selection.db,
              planId: selection.b,
              plans: plansB.data,
              loading: plansB.isFetching,
              error: plansB.error,
              onDayChange: (next) => select({ db: next, b: null }),
              onPlanChange: (id) => select({ b: id }),
            }}
            onSwap={() => select({ a: selection.b, b: selection.a, da: selection.db, db: selection.da })}
          />

          {replay.state.phase === "running" && (
            <div
              role="status"
              data-testid="replay-progress"
              className="flex items-center gap-3 rounded-md border border-info/30 bg-info-soft px-3 py-2 text-sm text-info"
            >
              <Spinner className="text-current" />
              <span className="font-medium">{t.replay.running}</span>
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={replay.state.progress}
                aria-label={t.replay.running}
                className="h-1.5 w-48 overflow-hidden rounded-full bg-info/20"
              >
                <div
                  className="h-full rounded-full bg-info transition-[width]"
                  style={{ width: `${Math.max(4, replay.state.progress)}%` }}
                />
              </div>
              <span className="num text-xs">{t.replay.progress(replay.state.progress)}</span>
              <span className="min-w-0 truncate text-xs">{replay.state.message ?? t.replay.starting}</span>
            </div>
          )}
          {replay.state.phase === "failed" && (
            <Notice
              tone="blocking"
              action={
                <span className="flex gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => replay.state.phase === "failed" && void replay.run(replay.state.planId)}
                  >
                    {t.replay.retry}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={replay.dismiss}>
                    {t.replay.dismiss}
                  </Button>
                </span>
              }
            >
              <strong className="font-semibold">{t.replay.failed}.</strong> {replay.state.error}
            </Notice>
          )}

          {body}
        </TabsContent>

        <TabsContent value="suivi" className="pt-3">
          <DashboardPanel day={day} />
        </TabsContent>
      </Tabs>

      {canWrite && (
        <ReferenceDayDialog open={importOpen} onOpenChange={setImportOpen} onImported={onImported} />
      )}
    </div>
  );
}
