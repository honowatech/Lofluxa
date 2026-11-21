/**
 * Import d'un fichier Excel / CSV en deux temps (F1.6) :
 * choisir le fichier → prévisualiser (rapport d'erreurs ligne par ligne) → appliquer.
 * Rien n'est écrit avant « Appliquer » ; un fichier contenant des erreurs ne peut pas être appliqué.
 *
 *   <ImportDialog kind="stations" open={open} onOpenChange={setOpen} onApplied={() => stations.invalidate()} />
 */
import { CircleAlert, CircleCheck, Download, FileSpreadsheet, TriangleAlert, Upload } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fr } from "@/i18n/fr";
import { errorMessage } from "@/lib/api/errors";
import { applyImport, downloadImportTemplate, previewImport } from "@/lib/api/imports";
import type { ImportBatch, ImportKind, ImportRowReport } from "@/lib/types";
import { cn } from "@/lib/utils";

import { notify } from "./notify";
import { Notice } from "./PageHeader";
import { Spinner } from "./states";

const t = fr.importDialog;
const ACCEPTED = [".xlsx", ".csv"];

export interface ImportDialogProps {
  kind: ImportKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Appelé après application réussie (rafraîchir les listes). */
  onApplied?: (batch: ImportBatch) => void;
  /** Champs supplémentaires envoyés avec le fichier (ex. `{ day }` pour les commandes). */
  fields?: Record<string, string>;
}

function previewText(data: ImportRowReport["data"]): string {
  if (!data) return "";
  return Object.values(data)
    .filter((value) => value !== null && value !== "" && typeof value !== "object")
    .slice(0, 4)
    .join(" · ");
}

export function ImportDialog({ kind, open, onOpenChange, onApplied, fields }: ImportDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [batch, setBatch] = useState<ImportBatch | null>(null);
  const [phase, setPhase] = useState<"idle" | "previewing" | "applying">("idle");
  const [error, setError] = useState<string | null>(null);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setBatch(null);
    setPhase("idle");
    setError(null);
    setOnlyErrors(false);
  }, [open, kind]);

  const busy = phase !== "idle";
  const step = batch ? "preview" : "file";
  const validRows = batch ? batch.rows.filter((row) => row.status !== "error").length : 0;
  const canApply = !!batch && batch.error_count === 0 && batch.row_count > 0;
  const visibleRows = batch
    ? onlyErrors
      ? batch.rows.filter((row) => row.status !== "ok")
      : batch.rows
    : [];

  const pick = (next: File | null | undefined) => {
    if (!next) return;
    if (!ACCEPTED.some((extension) => next.name.toLowerCase().endsWith(extension))) {
      setError(t.badType);
      return;
    }
    setFile(next);
    setBatch(null);
    setError(null);
  };

  const runPreview = async () => {
    if (!file) return;
    setPhase("previewing");
    setError(null);
    try {
      const result = await previewImport(kind, file, fields);
      setBatch(result);
      setOnlyErrors(result.error_count > 0);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPhase("idle");
    }
  };

  const runApply = async () => {
    if (!batch) return;
    setPhase("applying");
    setError(null);
    try {
      const result = await applyImport(batch.id);
      notify.success(t.applied(result.row_count || validRows));
      onApplied?.(result);
      onOpenChange(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPhase("idle");
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (!busy) pick(event.dataTransfer.files[0]);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t.title(t.kinds[kind])}</DialogTitle>
          <DialogDescription>{t.intro}</DialogDescription>
          <ol className="mt-1 flex gap-4 text-xs">
            {(["file", "preview"] as const).map((key) => (
              <li
                key={key}
                aria-current={step === key ? "step" : undefined}
                className={cn(
                  "border-b-2 pb-0.5",
                  step === key
                    ? "border-primary font-semibold text-foreground"
                    : "border-transparent text-muted-foreground",
                )}
              >
                {t.steps[key]}
              </li>
            ))}
          </ol>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-3">
          {error && <Notice tone="blocking">{error}</Notice>}

          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              "flex flex-wrap items-center gap-3 rounded-md border border-dashed px-3 py-2.5",
              dragging ? "border-primary bg-accent" : "border-input bg-muted/40",
            )}
          >
            <FileSpreadsheet className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1 text-xs">
              {file ? (
                <>
                  <p className="text-muted-foreground">{t.selectedFile}</p>
                  <p className="num truncate text-sm font-medium">{file.name}</p>
                </>
              ) : (
                <p className="text-muted-foreground">{t.dropHint}</p>
              )}
            </div>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPTED.join(",")}
              className="sr-only"
              aria-label={t.chooseFile}
              onChange={(event) => {
                pick(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <Button variant="outline" size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
              <Upload />
              {file ? t.changeFile : t.chooseFile}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                downloadImportTemplate(kind).catch((caught) => notify.apiError(caught, t.templateFailed))
              }
            >
              <Download />
              {t.downloadTemplate}
            </Button>
          </div>

          {phase === "previewing" && (
            <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner /> {t.previewing}
            </p>
          )}

          {batch && (
            <section aria-label={t.steps.preview} className="flex min-h-0 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm font-medium" data-testid="import-summary">
                  {t.summary(batch.row_count, batch.error_count)}
                </p>
                {batch.rows.length > 0 && (
                  <label className="ml-auto flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={onlyErrors}
                      onChange={(event) => setOnlyErrors(event.target.checked)}
                    />
                    {t.onlyErrors}
                  </label>
                )}
              </div>
              {batch.row_count === 0 ? (
                <Notice tone="warning">{t.noRows}</Notice>
              ) : batch.error_count > 0 ? (
                <Notice tone="blocking" icon={<CircleAlert className="size-3.5" />}>
                  {t.hasErrors}
                </Notice>
              ) : (
                <Notice tone="info" icon={<CircleCheck className="size-3.5" />}>
                  {t.allValid}
                </Notice>
              )}

              {visibleRows.length > 0 && (
                <div className="max-h-[42vh] overflow-auto rounded-md border">
                  <table className="w-full border-separate border-spacing-0 text-xs">
                    <thead className="sticky top-0 bg-muted text-left text-foreground/70">
                      <tr>
                        <th scope="col" className="w-14 border-b px-2 py-1 text-right font-semibold">
                          {t.row}
                        </th>
                        <th scope="col" className="w-24 border-b px-2 py-1 font-semibold">
                          {t.status}
                        </th>
                        <th scope="col" className="border-b px-2 py-1 font-semibold">
                          {t.message}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRows.map((row) => (
                        <tr
                          key={row.row}
                          data-status={row.status}
                          className={cn(
                            row.status === "error" && "bg-blocking-soft/60",
                            row.status === "warning" && "bg-warning-soft/60",
                          )}
                        >
                          <td className="num border-b px-2 py-1 text-right align-top">{row.row}</td>
                          <td className="border-b px-2 py-1 align-top">
                            {row.status === "error" ? (
                              <span className="flex items-center gap-1 font-medium text-blocking">
                                <CircleAlert className="size-3" aria-hidden />
                                {t.rowError}
                              </span>
                            ) : row.status === "warning" ? (
                              <span className="flex items-center gap-1 font-medium text-warning">
                                <TriangleAlert className="size-3" aria-hidden />
                                {t.rowWarning}
                              </span>
                            ) : (
                              <span className="text-success">
                                {(row.action && (t.actions as Record<string, string>)[row.action]) || t.rowOk}
                              </span>
                            )}
                          </td>
                          <td className="border-b px-2 py-1 align-top">
                            {row.errors.length > 0 ? (
                              <ul className="flex flex-col gap-0.5">
                                {row.errors.map((entry, index) => (
                                  <li key={index}>
                                    {entry.field && (
                                      <span className="num mr-1 rounded-sm bg-card px-1 text-foreground/70">
                                        {entry.field}
                                      </span>
                                    )}
                                    {entry.message}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <span className="text-muted-foreground">{previewText(row.data)}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {fr.common.cancel}
          </Button>
          {batch ? (
            <Button disabled={!canApply || busy} onClick={() => void runApply()}>
              {phase === "applying" && <Spinner className="text-current" />}
              {phase === "applying" ? t.applying : t.applyCount(validRows)}
            </Button>
          ) : (
            <Button disabled={!file || busy} onClick={() => void runPreview()}>
              {phase === "previewing" && <Spinner className="text-current" />}
              {t.preview}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
