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
  /** Version en vigueur (publiée) de la lignée, quand la version affichée est archivée : elle a été remplacée. */
  supersededBy: PlanSummary | null;
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

  const supersededBy =
    plan.status === "archived" ? (lineage.find((other) => other.status === "published") ?? null) : null;

  let readOnlyReason: string | null = null;
  if (!canWrite) readOnlyReason = t.readOnly.role;
  else if (plan.kind === "manual_reference") readOnlyReason = t.readOnly.reference;
  else if (supersededBy) readOnlyReason = t.readOnly.superseded(supersededBy.version);
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
    supersededBy,
    canPublish: canWrite && publishBlockedReason === null && !busy,
    publishBlockedReason: canWrite ? publishBlockedReason : null,
  };
}

const tripsOf = (plan: PlanSummary): number => plan.metrics?.trips_count ?? 0;
const volumeOf = (plan: PlanSummary): number => plan.metrics?.planned_l ?? 0;

/** Plan en vigueur : `is_current` du serveur s'il est fourni, sinon « publié ». */
export function isInForce(plan: PlanSummary): boolean {
  return typeof plan.is_current === "boolean" ? plan.is_current : plan.status === "published";
}

/** Le plus important d'abord : le plus de tournées, puis le plus de volume, puis le plus récent. */
function byImportance(a: PlanSummary, b: PlanSummary): number {
  return tripsOf(b) - tripsOf(a) || volumeOf(b) - volumeOf(a) || b.created_at.localeCompare(a.created_at);
}

/**
 * Plan affiché par défaut pour un jour : le **plan du jour en vigueur le plus important** — parmi les plans
 * calculés en vigueur (publiés), celui qui a le plus de tournées (un second plan publié pour des reliquats
 * ne masque pas le plan principal). À défaut de plan en vigueur : le brouillon calculé le plus important ;
 * à défaut de plan calculé : le plan non archivé le plus récent (journée de référence, rejeu).
 */
export function pickDefaultPlan(plans: PlanSummary[]): PlanSummary | null {
  const computed = plans.filter((plan) => plan.kind === "computed" && plan.status !== "archived");
  const inForce = computed.filter(isInForce);
  return (
    [...inForce].sort(byImportance)[0] ??
    [...computed].sort(byImportance)[0] ??
    plans.find((plan) => plan.status !== "archived") ??
    plans[0] ??
    null
  );
}

export { rootOf };
