/** Historique des versions d'un plan (F5.5) : qui a changé quoi, quand ; restauration avec confirmation. */
import { History, RotateCcw } from "lucide-react";
import { useState } from "react";

import { Badge, Button, ErrorState, LoadingState, StatusBadge, notify, useConfirm } from "@/components";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fr } from "@/i18n/fr";
import { formatDateTime, formatKm, formatLocalTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import { restoreVersion, usePlanCache, useVersions } from "../api";
import type { Plan, PlanVersion } from "../types";

const t = fr.screens.plan;

export function VersionsDialog({
  plan,
  open,
  onOpenChange,
  canRestore,
  openPlan,
}: {
  plan: Plan;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canRestore: boolean;
  openPlan: (planId: string) => void;
}) {
  const versions = useVersions(plan.id, open);
  const confirm = useConfirm();
  const cache = usePlanCache();
  const [restoring, setRestoring] = useState<number | null>(null);
  const items = [...(versions.data ?? [])].sort((a, b) => b.version - a.version);
  const draft = items.find((version) => version.status === "draft");

  const restore = async (version: PlanVersion) => {
    const accepted = await confirm({
      title: t.versions.restoreTitle(version.version),
      description: (
        <>
          {t.versions.restoreBody}
          {draft && (
            <span className="mt-1 block font-medium">{t.versions.restoreDraftAbandoned(draft.version)}</span>
          )}
        </>
      ),
      confirmLabel: t.versions.restoreConfirm,
      destructive: !!draft,
    });
    if (!accepted) return;
    setRestoring(version.version);
    try {
      const restored = await restoreVersion(plan.id, version.version);
      cache(restored);
      notify.success(t.versions.restored(version.version, restored.version));
      onOpenChange(false);
      openPlan(restored.id);
    } catch (error) {
      notify.apiError(error, t.versions.restoreFailed);
    } finally {
      setRestoring(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent placement="side" className="w-[min(100vw,34rem)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="size-4" aria-hidden />
            {t.versions.title}
          </DialogTitle>
          <DialogDescription>{t.versions.subtitle}</DialogDescription>
        </DialogHeader>
        <DialogBody className="min-h-0 flex-1 overflow-y-auto">
          {versions.isLoading ? (
            <LoadingState compact />
          ) : versions.error ? (
            <ErrorState compact error={versions.error} onRetry={() => void versions.refetch()} />
          ) : (
            <ol className="flex flex-col gap-3">
              {items.map((version) => {
                const displayed = version.plan_id === plan.id;
                return (
                  <li
                    key={version.plan_id}
                    data-testid={`version-${version.version}`}
                    className={cn("rounded-md border", displayed && "border-primary/50")}
                  >
                    <div className="flex flex-wrap items-center gap-1.5 border-b bg-muted/40 px-3 py-1.5">
                      <h3 className="text-sm font-semibold">{t.versions.version(version.version)}</h3>
                      <StatusBadge kind="plan" value={version.status} />
                      {version.is_current && <Badge tone="primary">{t.versions.current}</Badge>}
                      {displayed && <Badge tone="info">{t.versions.displayed}</Badge>}
                      <span className="ml-auto flex items-center gap-1">
                        {!displayed && (
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={t.versions.openLabel(version.version)}
                            onClick={() => {
                              onOpenChange(false);
                              openPlan(version.plan_id);
                            }}
                          >
                            {t.versions.open}
                          </Button>
                        )}
                        {canRestore && version.status !== "draft" && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={restoring !== null}
                            aria-label={t.versions.restoreLabel(version.version)}
                            onClick={() => void restore(version)}
                          >
                            <RotateCcw aria-hidden />
                            {t.versions.restore}
                          </Button>
                        )}
                      </span>
                    </div>
                    <div className="px-3 py-1.5 text-xs text-muted-foreground">
                      <p>
                        {t.versions.createdBy(version.created_by_name, formatDateTime(version.created_at))}
                      </p>
                      {version.published_at && (
                        <p>
                          {t.versions.publishedBy(
                            version.published_by_name,
                            formatDateTime(version.published_at),
                          )}
                        </p>
                      )}
                      {version.reason && <p className="text-foreground/80">{version.reason}</p>}
                      {version.metrics && (
                        <p className="num">
                          {t.versions.summary(
                            version.metrics.trips_count,
                            formatKm(Number(version.metrics.total_distance_m ?? NaN)),
                          )}
                        </p>
                      )}
                    </div>
                    {version.changes.length === 0 ? (
                      <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">
                        {t.versions.noChanges}
                      </p>
                    ) : (
                      <ul className="divide-y border-t">
                        {version.changes.map((change) => (
                          <li key={change.id} className="flex gap-2 px-3 py-1 text-xs">
                            <span
                              className="num w-[6.5rem] shrink-0 text-muted-foreground"
                              title={formatDateTime(change.occurred_at)}
                            >
                              {formatDateTime(change.occurred_at).slice(0, 5)}{" "}
                              {formatLocalTime(change.occurred_at)}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span>{change.summary ?? t.versions.types[change.type] ?? change.type}</span>
                              <span className="block text-muted-foreground">
                                {change.actor_name ?? t.versions.unknownActor}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
