/** Petites briques communes aux volets de l'écran : repère A / B, titre de section. */
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { SIDE_LABEL, type Side } from "./api";

/** Couleur d'identité des deux plans (jamais un jugement : A ardoise, B pétrole). */
export const SIDE_BG: Record<Side, string> = { a: "bg-[hsl(203_12%_42%)]", b: "bg-primary" };

export function SideChip({ side, className }: { side: Side; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-grid size-5 shrink-0 place-items-center rounded-sm text-xs font-semibold leading-none text-white",
        SIDE_BG[side],
        className,
      )}
    >
      {SIDE_LABEL[side]}
    </span>
  );
}

export function Section({
  id,
  title,
  hint,
  actions,
  children,
  className,
}: {
  id: string;
  title: string;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={id} className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h2 id={id} className="text-sm font-semibold tracking-tight">
          {title}
        </h2>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
