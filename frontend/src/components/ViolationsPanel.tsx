/**
 * Panneau des violations de règles métier — toujours au même endroit et sous la même forme :
 * rouge = bloquant, orange = avertissement, code RM-xx en tête de ligne. Les bloquantes d'abord.
 *
 *   <ViolationsPanel violations={plan.violations} onSelect={(v) => focusTrip(v.trip_id)} />
 *   <ViolationsPanel violations={apiError.violations} />      // refus 409 d'une publication
 */
import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";

import { fr } from "@/i18n/fr";
import type { Violation } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface ViolationsPanelProps {
  violations: Violation[] | null | undefined;
  /** Rend chaque ligne activable (clic ou Entrée) : ex. centrer la carte sur la tournée concernée. */
  onSelect?: (violation: Violation) => void;
  title?: string;
  /** Masque le panneau quand il n'y a aucune violation (par défaut il affiche « Aucune violation »). */
  hideWhenEmpty?: boolean;
  /** Hauteur maximale de la liste avant défilement : valeur CSS (`"40vh"`), pixels, ou `"none"`. Défaut : 16 rem. */
  maxListHeight?: number | string;
  className?: string;
}

export function sortViolations(violations: Violation[]): Violation[] {
  return [...violations].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "blocking" ? -1 : 1;
    return a.rule_code.localeCompare(b.rule_code, "fr", { numeric: true });
  });
}

export function ViolationsPanel({
  violations,
  onSelect,
  title = fr.violations.title,
  hideWhenEmpty,
  maxListHeight,
  className,
}: ViolationsPanelProps) {
  const list = sortViolations(violations ?? []);
  const blocking = list.filter((v) => v.severity === "blocking").length;
  const warning = list.length - blocking;
  if (list.length === 0 && hideWhenEmpty) return null;

  return (
    <section
      aria-label={title}
      data-testid="violations-panel"
      className={cn(
        "overflow-hidden rounded-md border bg-card",
        blocking > 0 ? "border-blocking/40" : warning > 0 ? "border-warning/40" : "border-border",
        className,
      )}
    >
      <header className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground/70">{title}</h3>
        <span className="ml-auto flex items-center gap-1.5 text-xs">
          {blocking > 0 && (
            <span className="rounded-sm bg-blocking px-1.5 font-medium text-white">
              {fr.violations.blockingCount(blocking)}
            </span>
          )}
          {warning > 0 && (
            <span className="rounded-sm bg-warning px-1.5 font-medium text-white">
              {fr.violations.warningCount(warning)}
            </span>
          )}
        </span>
      </header>

      {list.length === 0 ? (
        <p className="flex items-center gap-1.5 px-3 py-2 text-xs text-success">
          <CircleCheck className="size-3.5" aria-hidden />
          {fr.violations.none}
        </p>
      ) : (
        <ul
          className={cn("divide-y overflow-y-auto", maxListHeight === undefined && "max-h-64")}
          style={maxListHeight === undefined ? undefined : { maxHeight: maxListHeight }}
        >
          {list.map((violation, index) => {
            const isBlocking = violation.severity === "blocking";
            const Icon = isBlocking ? CircleAlert : TriangleAlert;
            const content = (
              <>
                <Icon
                  className={cn("mt-0.5 size-3.5 shrink-0", isBlocking ? "text-blocking" : "text-warning")}
                  aria-hidden
                />
                <span
                  className={cn(
                    "num shrink-0 rounded-sm px-1 text-xs font-medium",
                    isBlocking ? "bg-blocking-soft text-blocking" : "bg-warning-soft text-warning",
                  )}
                >
                  {violation.rule_code}
                </span>
                <span className="min-w-0 flex-1 text-left text-xs leading-snug">{violation.message}</span>
                <span className="sr-only">{isBlocking ? fr.violations.blocking : fr.violations.warning}</span>
              </>
            );
            return (
              <li
                key={violation.id ?? `${violation.rule_code}-${index}`}
                data-severity={violation.severity}
                className={cn("border-l-[3px]", isBlocking ? "border-l-blocking" : "border-l-warning")}
              >
                {onSelect ? (
                  <button
                    type="button"
                    onClick={() => onSelect(violation)}
                    title={fr.violations.locate}
                    className="flex w-full items-start gap-2 px-2.5 py-1.5 hover:bg-muted focus-ring"
                  >
                    {content}
                  </button>
                ) : (
                  <div className="flex items-start gap-2 px-2.5 py-1.5">{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
