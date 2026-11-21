/**
 * Écran 5 — Plan de tournées (spec §10, F4, F5) : liste des tournées, carte, détail, commandes non servies,
 * édition manuelle, verrouillage, recalcul, publication, versions.
 *
 * Données serveur : TanStack Query (`api.ts`). Plan en cours d'édition : Zustand (`store.ts`).
 * Adresse : `/plan?day=YYYY-MM-DD&plan=<id>` — sans `plan`, le plan calculé le plus récent du jour.
 */
import { useQueryClient } from "@tanstack/react-query";
import { CalendarSearch, Route } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Notice,
  PageHeader,
  ViolationsPanel,
  notify,
  useConfirm,
} from "@/components";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fr } from "@/i18n/fr";
import { usePublishAlerts, type AppAlert } from "@/lib/alerts";
import { ApiError, isApiError } from "@/lib/api";
import { useCan, useCanSee } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import type { Violation } from "@/lib/types";
import { useDay, withDay } from "@/lib/useDay";

import { pickDefaultPlan, planAccess } from "./access";
import { planKeys, publishPlan, usePlanCache, usePlanQuery, usePlansOfDay } from "./api";
import { PlanDnd } from "./components/dnd";
import { PlanHeader } from "./components/PlanHeader";
import { PlanMap } from "./components/PlanMap";
import { PlanTable } from "./components/PlanTable";
import { TripDetail } from "./components/TripDetail";
import { TripList } from "./components/TripList";
import { UnservedBanner } from "./components/UnservedBanner";
import { VersionsDialog } from "./components/VersionsDialog";
import { PlanUiContext, type PlanUi } from "./context";
import { usePlanStore } from "./store";
import type { Plan, PlanSummary } from "./types";
import { usePlanEditor } from "./usePlanEditor";
import { useRecompute } from "./useRecompute";

const t = fr.screens.plan;
const PLAN_PARAM = "plan";
const NO_PLANS: PlanSummary[] = [];

export default function PlanPage() {
  const { day } = useDay();
  const canWrite = useCan("plan.write");
  const [params, setParams] = useSearchParams();
  const requested = params.get(PLAN_PARAM);

  const plans = usePlansOfDay(day);
  const planList = plans.data ?? NO_PLANS;
  const planId = requested ?? pickDefaultPlan(planList)?.id ?? null;
  const planQuery = usePlanQuery(planId);

  const openPlan = useCallback(
    (id: string | null) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (id) next.set(PLAN_PARAM, id);
          else next.delete(PLAN_PARAM);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // Un plan demandé dans l'adresse qui n'existe pas, ou qui appartient à un autre jour : le jour l'emporte.
  const fetched = planQuery.data && planQuery.data.id === planId ? planQuery.data : null;
  const foreign = !!requested && !!fetched && fetched.day !== day;
  const missing =
    !!requested &&
    isApiError(planQuery.error) &&
    (planQuery.error.isNotFound || planQuery.error.isValidation);
  useEffect(() => {
    if (foreign || missing) openPlan(null);
  }, [foreign, missing, openPlan]);

  // Le plan affiché vient du store d'édition, alimenté par les lectures du serveur.
  useEffect(() => {
    if (fetched && fetched.day === day) usePlanStore.getState().load(fetched);
  }, [fetched, day]);
  useEffect(() => {
    if (!planId) usePlanStore.getState().reset();
  }, [planId]);
  useEffect(() => () => usePlanStore.getState().reset(), []);

  const storePlan = usePlanStore((state) => state.plan);
  const plan = storePlan && storePlan.id === planId && storePlan.day === day ? storePlan : null;

  if (plan) return <PlanScreen plan={plan} plans={planList} canWrite={canWrite} openPlan={openPlan} />;

  const error = plans.error ?? (missing ? null : planQuery.error);
  return (
    <div className="flex h-full flex-col gap-3 p-4" data-testid="screen-plan">
      <PageHeader title={t.title} />
      {error ? (
        <ErrorState
          error={error}
          onRetry={() => {
            void plans.refetch();
            void planQuery.refetch();
          }}
        />
      ) : plans.isLoading || planId ? (
        <LoadingState className="flex-1" />
      ) : (
        <EmptyState
          className="flex-1"
          icon={<CalendarSearch className="size-8 text-muted-foreground/60" aria-hidden />}
          title={t.empty.title}
          description={t.empty.body(formatDate(day))}
          action={
            <Button asChild>
              <Link to={withDay("/journee", day)}>{t.empty.action}</Link>
            </Button>
          }
        />
      )}
    </div>
  );
}

function PlanScreen({
  plan,
  plans,
  canWrite,
  openPlan,
}: {
  plan: Plan;
  plans: PlanSummary[];
  canWrite: boolean;
  openPlan: (planId: string | null) => void;
}) {
  const client = useQueryClient();
  const confirm = useConfirm();
  const cache = usePlanCache();
  const view = usePlanStore((state) => state.view);
  const pending = usePlanStore((state) => state.pendingOp !== null);
  const announcement = usePlanStore((state) => state.announcement);
  const canSeeEvents = useCanSee("events");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<ApiError | null>(null);

  const { edit } = usePlanEditor(openPlan);
  const recompute = useRecompute(plan, openPlan);
  const busy = pending || publishing || recompute.running;
  const access = useMemo(() => planAccess(plan, plans, canWrite, busy), [plan, plans, canWrite, busy]);
  const canEdit = access.canEdit && !recompute.running && !publishing;

  const ui = useMemo<PlanUi>(
    () => ({
      canEdit,
      busy,
      edit,
      showRouteSheets: plan.status !== "draft",
      published: plan.status === "published",
    }),
    [canEdit, busy, edit, plan.status],
  );

  const urgentUnserved = plan.unserved.filter(
    (order) =>
      order.priority === "urgent" && order.order_status !== "postponed" && order.order_status !== "cancelled",
  ).length;
  const alerts = useMemo<AppAlert[]>(() => {
    if (plan.status !== "draft" || plan.kind !== "computed") return [];
    const to = `${withDay("/plan", plan.day)}&${PLAN_PARAM}=${plan.id}`;
    const list: AppAlert[] = [];
    if (plan.blocking_count > 0)
      list.push({ id: "blocking", severity: "blocking", title: t.alerts.blocking(plan.blocking_count), to });
    if (urgentUnserved > 0)
      list.push({ id: "urgent", severity: "blocking", title: t.alerts.urgentUnserved(urgentUnserved), to });
    return list;
  }, [plan.blocking_count, plan.day, plan.id, plan.kind, plan.status, urgentUnserved]);
  usePublishAlerts("plan", alerts);

  // La version affichée peut être archivée par ailleurs (publication d'une autre version après une panne ou
  // une pénurie, lot L10) : la liste du jour, relue régulièrement, le révèle — on relit alors le plan, on
  // l'annonce, et le bandeau propose de basculer sur la version en vigueur.
  const listed = plans.find((other) => other.id === plan.id);
  useEffect(() => {
    if (listed && listed.status !== plan.status && !pending) {
      void client.invalidateQueries({ queryKey: planKeys.one(plan.id) });
    }
  }, [client, listed, pending, plan.id, plan.status]);
  const seen = useRef<{ id: string; status: Plan["status"] }>({ id: plan.id, status: plan.status });
  useEffect(() => {
    const before = seen.current;
    seen.current = { id: plan.id, status: plan.status };
    if (before.id !== plan.id || before.status !== "published" || plan.status !== "archived") return;
    void client.invalidateQueries({ queryKey: planKeys.ofDay(plan.day) });
    const current = access.supersededBy?.version;
    const message = current ? t.readOnly.supersededNow(plan.version, current) : t.readOnly.archived;
    notify.warning(t.readOnly.supersededTitle, message);
    usePlanStore.getState().announce(message);
  }, [access.supersededBy, client, plan.day, plan.id, plan.status, plan.version]);

  const selectViolation = useCallback((violation: Violation) => {
    const store = usePlanStore.getState();
    if (violation.stop_id) store.selectStop(violation.stop_id);
    else if (violation.trip_id) store.selectTrip(violation.trip_id);
  }, []);

  const onPublish = async () => {
    const published = plans.find((other) => other.id === access.publishedOfLineage?.id);
    const accepted = await confirm({
      title: t.publish.confirmTitle,
      description: (
        <>
          {t.publish.confirmBody(plan.trips.length, plan.version)}
          {published && <span className="mt-1 block">{t.publish.confirmArchive(published.version)}</span>}
          {plan.warning_count > 0 && (
            <span className="mt-1 block">{t.publish.confirmWarnings(plan.warning_count)}</span>
          )}
          {plan.unserved.length > 0 && (
            <span className="mt-1 block">{t.publish.confirmUnserved(plan.unserved.length)}</span>
          )}
        </>
      ),
      confirmLabel: t.header.publish,
    });
    if (!accepted) return;
    setPublishing(true);
    try {
      const result = await publishPlan(plan.id);
      usePlanStore.getState().commit(result);
      cache(result);
      void client.invalidateQueries({ queryKey: planKeys.all });
      notify.success(t.publish.done(result.version), t.publish.doneHint);
      usePlanStore.getState().announce(t.publish.done(result.version));
    } catch (error) {
      void client.invalidateQueries({ queryKey: planKeys.one(plan.id) });
      if (isApiError(error) && error.code === "rule_violation") setPublishError(error);
      else notify.apiError(error, t.publish.failed);
    } finally {
      setPublishing(false);
    }
  };

  const onRecompute = async () => {
    const locked = plan.trips.filter((trip) => trip.locked).length;
    const accepted = await confirm({
      title: t.recompute.confirmTitle,
      description: (
        <>
          {t.recompute.confirmBody(locked, plan.trips.length - locked)}
          {plan.status === "published" && <span className="mt-1 block">{t.recompute.confirmPublished}</span>}
        </>
      ),
      confirmLabel: t.recompute.confirm,
      destructive: locked === 0,
    });
    if (accepted) await recompute.start();
  };

  const progress = recompute.task?.progress ?? 0;

  return (
    <PlanUiContext.Provider value={ui}>
      <div
        className="flex h-full min-h-0 flex-col gap-2 p-3"
        data-testid="screen-plan"
        data-plan-id={plan.id}
      >
        <PlanHeader
          plan={plan}
          plans={plans}
          access={access}
          canWrite={canWrite}
          busy={busy}
          publishing={publishing}
          recomputing={recompute.running}
          onSelectPlan={openPlan}
          onHistory={() => setHistoryOpen(true)}
          onRecompute={() => void onRecompute()}
          onPublish={() => void onPublish()}
        />

        {recompute.running && (
          <div
            role="status"
            data-testid="recompute-progress"
            className="flex items-center gap-3 rounded-md border border-info/30 bg-info-soft px-3 py-1.5 text-xs text-info"
          >
            <span className="font-semibold">{t.recompute.running}</span>
            <span
              role="progressbar"
              aria-label={t.recompute.running}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
              className="relative h-1.5 w-48 overflow-hidden rounded-full bg-card"
            >
              <span
                className="absolute inset-y-0 left-0 bg-info transition-[width]"
                style={{ width: `${progress}%` }}
              />
            </span>
            <span className="num">{t.recompute.progress(progress)}</span>
            <span className="min-w-0 flex-1 truncate">{recompute.task?.message ?? t.recompute.waiting}</span>
            <Button variant="ghost" size="sm" onClick={recompute.stop}>
              {t.recompute.stop}
            </Button>
          </div>
        )}

        {access.supersededBy ? (
          <Notice
            tone="warning"
            action={
              <span className="flex items-center gap-1.5">
                {canSeeEvents && (
                  <Button asChild variant="ghost" size="sm">
                    <Link to={withDay("/journal", plan.day)}>{t.readOnly.toEvents}</Link>
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={() => openPlan(access.supersededBy?.id ?? null)}>
                  {t.readOnly.openCurrent}
                </Button>
              </span>
            }
          >
            {t.readOnly.superseded(access.supersededBy.version)}
          </Notice>
        ) : access.readOnlyReason ? (
          <Notice
            tone="neutral"
            action={
              access.draftOfLineage &&
              canWrite && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openPlan(access.draftOfLineage?.id ?? null)}
                >
                  {t.readOnly.openDraft}
                </Button>
              )
            }
          >
            {access.readOnlyReason}
          </Notice>
        ) : plan.status === "published" ? (
          <Notice tone="info">{t.readOnly.published}</Notice>
        ) : access.publishedOfLineage ? (
          <Notice
            tone="warning"
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => openPlan(access.publishedOfLineage?.id ?? null)}
              >
                {t.readOnly.openPublished}
              </Button>
            }
          >
            {t.readOnly.draftOfPublished(plan.version, access.publishedOfLineage.version)}
          </Notice>
        ) : plan.kind === "replay" ? (
          <Notice tone="info">{t.readOnly.replay}</Notice>
        ) : null}

        <UnservedBanner
          plan={plan}
          canPostpone={canWrite && plan.status === "draft" && plan.kind === "computed"}
        />

        <PlanDnd>
          <div
            className={
              view === "map"
                ? "grid min-h-0 flex-1 grid-cols-[17.5rem_minmax(0,1fr)_23.5rem] gap-2"
                : "grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_23.5rem] gap-2"
            }
          >
            {plan.trips.length === 0 ? (
              <EmptyState
                className="col-span-full rounded-md border bg-card"
                icon={<Route className="size-8 text-muted-foreground/60" aria-hidden />}
                title={t.empty.noTrips}
                description={plan.unserved.length > 0 ? t.empty.noTripsHint : undefined}
              />
            ) : (
              <>
                {view === "map" && <TripList trips={plan.trips} />}
                {view === "map" ? <PlanMap plan={plan} /> : <PlanTable plan={plan} />}
                <div className="flex min-h-0 flex-col gap-2">
                  <TripDetail className="flex-1" />
                  <ViolationsPanel
                    violations={plan.violations}
                    onSelect={selectViolation}
                    title={t.violations.title}
                    className="shrink-0 [&_ul]:max-h-40"
                  />
                </div>
              </>
            )}
          </div>
        </PlanDnd>

        <p className="sr-only" role="status" aria-live="polite" data-testid="plan-announcement">
          {announcement}
        </p>
      </div>

      <VersionsDialog
        plan={plan}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        canRestore={canWrite && plan.kind !== "manual_reference"}
        openPlan={openPlan}
      />

      <Dialog open={publishError !== null} onOpenChange={(open) => !open && setPublishError(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.publish.blockedTitle}</DialogTitle>
            <DialogDescription>{publishError?.message}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {publishError && publishError.ruleCodes.length > 0 && (
              <p className="num mb-2 text-xs font-medium text-blocking">
                {t.publish.blockedRules(publishError.ruleCodes.join(", "))}
              </p>
            )}
            <ViolationsPanel
              violations={publishError?.violations}
              onSelect={(violation) => {
                selectViolation(violation);
                setPublishError(null);
              }}
            />
          </DialogBody>
        </DialogContent>
      </Dialog>
    </PlanUiContext.Provider>
  );
}
