/**
 * Imports (F1.6) : prévisualiser → rapport ligne par ligne → appliquer.
 * Le format exact du rapport est défini par le lot L3 ; `normalizeImportBatch` accepte les variantes
 * plausibles (question L9-Q5) pour que `ImportDialog` ne dépende que d'une forme stable.
 */
import type { ImportBatch, ImportKind, ImportRowReport, ImportStatus } from "@/lib/types";

import { api } from "./client";
import { apiUpload, downloadFile } from "./files";

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw => (value && typeof value === "object" ? (value as Raw) : {});

function normalizeErrors(raw: unknown): ImportRowReport["errors"] {
  if (!Array.isArray(raw)) return typeof raw === "string" && raw ? [{ message: raw }] : [];
  return raw
    .map((entry) => {
      if (typeof entry === "string") return { message: entry };
      const e = asRecord(entry);
      const message = String(e.message ?? e.msg ?? e.error ?? "");
      const field = (e.field ?? e.column ?? null) as string | null;
      return { field, message };
    })
    .filter((entry) => entry.message !== "");
}

export function normalizeImportBatch(raw: unknown): ImportBatch {
  const batch = asRecord(raw);
  const report = asRecord(batch.report);
  const rawRows = (report.rows ?? report.lines ?? batch.rows ?? []) as unknown[];
  const rows: ImportRowReport[] = (Array.isArray(rawRows) ? rawRows : []).map((entry, index) => {
    const row = asRecord(entry);
    const errors = normalizeErrors(row.errors ?? row.error);
    const warnings = normalizeErrors(row.warnings);
    const declared = typeof row.status === "string" ? row.status : null;
    const status: ImportRowReport["status"] =
      errors.length > 0 || declared === "error" || declared === "invalid"
        ? "error"
        : warnings.length > 0 || declared === "warning"
          ? "warning"
          : "ok";
    return {
      row: Number(row.row ?? row.line ?? row.row_number ?? index + 2),
      status,
      action: (row.action as string | undefined) ?? null,
      errors: [...errors, ...warnings],
      data: (row.data ?? row.values ?? null) as Record<string, unknown> | null,
    };
  });
  const errorCount = Number(batch.error_count ?? rows.filter((row) => row.status === "error").length);
  return {
    id: String(batch.id ?? batch.batch_id ?? ""),
    kind: batch.kind as ImportKind,
    filename: String(batch.filename ?? ""),
    status: (batch.status as ImportStatus) ?? "previewed",
    row_count: Number(batch.row_count ?? rows.length),
    error_count: errorCount,
    rows,
  };
}

/** `POST /imports/{kind}/preview` (multipart, champ `file`). Rien n'est écrit en base. */
export async function previewImport(
  kind: ImportKind,
  file: File,
  fields?: Record<string, string>,
): Promise<ImportBatch> {
  return normalizeImportBatch(await apiUpload<unknown>(`/imports/${kind}/preview`, file, { fields }));
}

/** `POST /imports/{batch_id}/apply` */
export async function applyImport(batchId: string): Promise<ImportBatch> {
  return normalizeImportBatch(await api<unknown>(`/imports/${batchId}/apply`, { method: "POST" }));
}

/** `GET /imports/templates/{kind}` → fichier modèle. */
export function downloadImportTemplate(kind: ImportKind): Promise<string> {
  return downloadFile(`/imports/templates/${kind}`, { fallbackName: `modele_${kind}.xlsx` });
}
