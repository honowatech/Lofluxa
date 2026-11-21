/** État d'une version du plan après un événement (`PlanResultOut`) : publiée, ou en brouillon avec ses violations. */
import { CheckCircle2, TriangleAlert } from "lucide-react";
import { Link } from "react-router-dom";

import { Notice } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { ViolationsPanel } from "@/components/ViolationsPanel";
import { fr } from "@/i18n/fr";
import type { IsoDate } from "@/lib/types";

import type { PlanResultOut } from "./api";
import { planLink } from "./summary";

const t = fr.screens.events.planResult;

export function planResultSentence(result: PlanResultOut): string {
  if (result.published) return t.published(result.plan_version);
  if (result.blocking_count > 0) return t.draftBlocked(result.plan_version, result.blocking_count);
  return t.draft(result.plan_version);
}

export function PlanResult({
  result,
  day,
  onNavigate,
}: {
  result: PlanResultOut;
  day: IsoDate;
  onNavigate?: () => void;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid="plan-result">
      <Notice
        tone={result.published ? "info" : "warning"}
        icon={
          result.published ? (
            <CheckCircle2 className="size-4" aria-hidden />
          ) : (
            <TriangleAlert className="size-4" aria-hidden />
          )
        }
        action={
          <Button asChild variant="outline" size="sm" className="text-foreground">
            <Link to={planLink(result.plan_id, day)} onClick={onNavigate}>
              {t.openPlan(result.plan_version)}
            </Link>
          </Button>
        }
      >
        {planResultSentence(result)}
      </Notice>
      {result.violations.length > 0 && (
        <ViolationsPanel violations={result.violations} title={t.violationsTitle} />
      )}
    </div>
  );
}
