/**
 * Barre d'avancement segmentée : un segment par élément (arrêts livrés d'une tournée, lignes saisies…).
 *   <SegmentedProgress done={3} total={5} label="3 arrêts livrés sur 5" />
 *   <SegmentedProgress segments={["success", "success", "warning", "pending"]} label="…" />
 * `segments` permet de colorer chaque segment (livré, sauté, en attente) ; sinon `done` premiers segments
 * sont pleins. Au-delà de `maxSegments` (40), la barre devient continue.
 */
import { cn } from "@/lib/utils";

export type SegmentTone = "success" | "warning" | "blocking" | "info" | "primary" | "pending";

const TONE: Record<SegmentTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  blocking: "bg-blocking",
  info: "bg-info",
  primary: "bg-primary",
  pending: "bg-border",
};

type Props = {
  /** Nom accessible (ex. « 3 arrêts livrés sur 5 »). */
  label: string;
  tone?: Exclude<SegmentTone, "pending">;
  maxSegments?: number;
  className?: string;
} & ({ done: number; total: number; segments?: undefined } | { segments: readonly SegmentTone[] });

export function SegmentedProgress(props: Props) {
  const { label, tone = "success", maxSegments = 40, className } = props;
  const segments: readonly SegmentTone[] =
    props.segments ??
    Array.from({ length: Math.max(0, props.total) }, (_, index) => (index < props.done ? tone : "pending"));
  const total = segments.length;
  const done = segments.filter((segment) => segment !== "pending").length;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      className={cn("flex h-1.5 gap-0.5", className)}
    >
      {total > maxSegments ? (
        <span className="flex-1 overflow-hidden rounded-full bg-border">
          <span className={cn("block h-full", TONE[tone])} style={{ width: `${(done / total) * 100}%` }} />
        </span>
      ) : (
        segments.map((segment, index) => (
          <span key={index} data-segment={segment} className={cn("flex-1 rounded-full", TONE[segment])} />
        ))
      )}
    </div>
  );
}
