/** Différence avant → après d'une écriture du journal d'audit. */
import { fr } from "@/i18n/fr";

export interface DiffRow {
  field: string;
  before: unknown;
  after: unknown;
  /** `added` : champ absent avant ; `removed` : absent après. */
  kind: "changed" | "added" | "removed" | "unchanged";
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function diffRecords(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): DiffRow[] {
  const fields = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  return fields
    .map((field): DiffRow => {
      const inBefore = !!before && field in before;
      const inAfter = !!after && field in after;
      const kind = !inBefore
        ? "added"
        : !inAfter
          ? "removed"
          : same(before[field], after[field])
            ? "unchanged"
            : "changed";
      return { field, before: before?.[field], after: after?.[field], kind };
    })
    .sort(
      (a, b) =>
        Number(a.kind === "unchanged") - Number(b.kind === "unchanged") || a.field.localeCompare(b.field),
    );
}

export const changedFields = (rows: DiffRow[]): DiffRow[] => rows.filter((row) => row.kind !== "unchanged");

export function formatAuditValue(value: unknown): string {
  if (value === undefined) return fr.administration.audit.absent;
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? fr.common.yes : fr.common.no;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
