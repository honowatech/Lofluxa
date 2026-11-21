/** Imports (F1.6) : prévisualiser → rapport ligne par ligne → appliquer. Routes du lot L3. */
import type { ImportBatch, ImportIssue, ImportItem, ImportKind } from "@/lib/types";

import { api } from "./client";
import { apiUpload, downloadFile } from "./files";

/** `POST /imports/{kind}/preview` (multipart, champ `file`). Rien n'est écrit dans les référentiels. */
export function previewImport(
  kind: ImportKind,
  file: File,
  fields?: Record<string, string>,
): Promise<ImportBatch> {
  return apiUpload<ImportBatch>(`/imports/${kind}/preview`, file, { fields });
}

/** `POST /imports/{batch_id}/apply` — 409 `import_has_errors`, `already_applied` ou `stale_preview`. */
export function applyImport(batchId: string): Promise<ImportBatch> {
  return api<ImportBatch>(`/imports/${batchId}/apply`, { method: "POST" });
}

/** `GET /imports/templates/{kind}` → fichier modèle (.xlsx). */
export function downloadImportTemplate(kind: ImportKind): Promise<string> {
  return downloadFile(`/imports/templates/${kind}`, { fallbackName: `${kind}.xlsx` });
}

/** Une ligne du rapport affiché : l'effet annoncé et / ou les anomalies d'une ligne du fichier. */
export interface ImportReportRow {
  /** `null` : anomalie portant sur le fichier entier. */
  row: number | null;
  status: "ok" | "warning" | "error";
  item: ImportItem | null;
  issues: ImportIssue[];
}

/** Regroupe `items` et `issues` par ligne du fichier, dans l'ordre du fichier (anomalies globales en tête). */
export function importReportRows(batch: ImportBatch): ImportReportRow[] {
  const rows = new Map<number | null, ImportReportRow>();
  const at = (row: number | null) => {
    let entry = rows.get(row);
    if (!entry) rows.set(row, (entry = { row, status: "ok", item: null, issues: [] }));
    return entry;
  };
  for (const item of batch.report.items) at(item.row).item = item;
  for (const issue of batch.report.issues) {
    const entry = at(issue.row);
    entry.issues.push(issue);
    if (issue.severity === "error") entry.status = "error";
    else if (entry.status === "ok") entry.status = "warning";
  }
  return [...rows.values()].sort((a, b) => (a.row ?? -1) - (b.row ?? -1));
}
