/**
 * Puce de filtre à compteur : bouton à bascule (`aria-pressed`) pour filtrer une liste par catégorie.
 *   <FilterChipGroup label="Filtrer par type">
 *     <FilterChip label="Tous" count={events.length} pressed={type === null} onClick={() => setType(null)} />
 *     <FilterChip label="Pannes" count={3} pressed={type === "truck_breakdown"} onClick={…} />
 *   </FilterChipGroup>
 * Sans `count`, la puce n'affiche que son libellé. Un compteur à zéro est estompé (mais reste cliquable).
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface FilterChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  label: ReactNode;
  count?: number | null;
  pressed: boolean;
}

export const FilterChip = forwardRef<HTMLButtonElement, FilterChipProps>(function FilterChip(
  { label, count, pressed, className, ...props },
  ref,
) {
  const hasCount = count !== null && count !== undefined;
  return (
    <button
      ref={ref}
      type="button"
      aria-pressed={pressed}
      {...props}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors focus-ring disabled:opacity-50",
        pressed
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input bg-card text-foreground/80 hover:bg-muted",
        hasCount && count === 0 && !pressed && "text-muted-foreground/70",
        className,
      )}
    >
      {label}
      {hasCount && (
        <span className={cn("num tabular-nums", pressed ? "opacity-80" : "text-muted-foreground")}>
          {formatNumber(count)}
        </span>
      )}
    </button>
  );
});

/** Rangée de puces, annoncée comme un groupe. */
export function FilterChipGroup({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("flex flex-wrap items-center gap-1", className)}>
      {children}
    </div>
  );
}
