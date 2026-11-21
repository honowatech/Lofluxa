/** Ce que l'utilisateur peut faire sur le plan affiché (lecture seule, publication…), et pourquoi. */
import { fr } from "@/i18n/fr";

import type { Plan, PlanSummary } from "./types";

const t = fr.screens.plan;

export interface PlanAccess {
  /** Édition manuelle, verrouillage, recalcul. */
  canEdit: boolean;
  /** Raison affichée quand le plan est en lecture seule. */
  readOnlyReason: string | null;
  /** Brouillon en cours de la même lignée, quand le plan affiché est publié. */
  draftOfLineage: PlanSummary | null;
  /** Version publiée de la même lignée, quand le plan affiché est un brouillon. */
  publishedOfLineage: PlanSummary | null;
  canPublish: boolean;
  /** Explication du bouton Publier désactivé. */
  publishBlockedReason: string | null;
}

const rootOf = (plan: { id: string; root_plan_id?: string | null }) => plan.root_plan_id ?? plan.id;

export function planAccess(
  plan: Plan,
  plansOfDay: PlanSummary[],
  canWrite: boolean,
  busy: boolean,
): PlanAccess {
  const lineage = plansOfDay.filter((other) => rootOf(other) === rootOf(plan) && other.id !== plan.id);
  const draftOfLineage =
    plan.status === "published" ? (lineage.find((other) => other.status === "draft") ?? null) : null;
  const publishedOfLineage =
    plan.status === "draft" ? (lineage.find((other) => other.status === "published") ?? null) : null;

  let readOnlyReason: string | null = null;
  if (!canWrite) readOnlyReason = t.readOnly.role;
  else if (plan.kind === "manual_reference") readOnlyReason = t.readOnly.reference;
  else if (plan.status === "archived") readOnlyReason = t.readOnly.archived;
  else if (draftOfLineage) readOnlyReason = t.readOnly.publishedWithDraft(draftOfLineage.version);

  let publishBlockedReason: string | null = null;
  if (plan.kind !== "computed") publishBlockedReason = t.publish.disabled.kind;
  else if (plan.status === "published") publishBlockedReason = t.publish.disabled.published;
  else if (plan.status === "archived") publishBlockedReason = t.publish.disabled.archived;
  else if (plan.blocking_count > 0) publishBlockedReason = t.publish.disabled.blocking(plan.blocking_count);

  return {
    canEdit: readOnlyReason === null,
    readOnlyReason,
    draftOfLineage,
    publishedOfLineage,
    canPublish: canWrite && publishBlockedReason === null && !busy,
    publishBlockedReason: canWrite ? publishBlockedReason : null,
  };
}

/** Plan affiché par défaut pour un jour : le plan calculé non archivé le plus récent (le brouillon en cours s'il existe). */
export function pickDefaultPlan(plans: PlanSummary[]): PlanSummary | null {
  return (
    plans.find((plan) => plan.kind === "computed" && plan.status !== "archived") ??
    plans.find((plan) => plan.status !== "archived") ??
    plans[0] ??
    null
  );
}

export { rootOf };
