/**
 * Frise d'étapes : où en est un objet dans un enchaînement de statuts (tournée, import, assistant…).
 *   <Steps
 *     label="Avancement de la tournée"
 *     steps={TRIP_STATUSES.map((status) => ({ id: status, label: fr.status.trip[status] }))}
 *     current={trip.status}
 *   />
 * Les étapes passées sont cochées, l'étape courante est mise en avant (`aria-current="step"`).
 * `current` absent de la liste (ou `null`) : aucune étape n'est commencée.
 */
import { Check } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface Step<Id extends string = string> {
  id: Id;
  label: ReactNode;
}

export function Steps<Id extends string>({
  steps,
  current,
  label,
  size = "sm",
  className,
}: {
  steps: readonly Step<Id>[];
  current: Id | null | undefined;
  /** Nom accessible de la frise. */
  label: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const index = steps.findIndex((step) => step.id === current);
  return (
    <ol
      aria-label={label}
      className={cn("flex flex-wrap items-center gap-1", size === "md" ? "text-sm" : "text-xs", className)}
    >
      {steps.map((step, position) => (
        <li
          key={step.id}
          aria-current={position === index ? "step" : undefined}
          data-state={position < index ? "done" : position === index ? "current" : "todo"}
          className={cn(
            "flex items-center gap-1 rounded-sm border",
            size === "md" ? "px-2.5 py-1.5" : "px-2 py-1",
            position < index && "border-success/25 bg-success-soft text-success",
            position === index && "border-primary bg-primary font-semibold text-primary-foreground",
            position > index && "border-border bg-card text-muted-foreground",
          )}
        >
          {position < index ? (
            <Check className="size-3" aria-hidden />
          ) : (
            <span className="num">{position + 1}</span>
          )}
          {step.label}
        </li>
      ))}
    </ol>
  );
}
