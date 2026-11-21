/**
 * Import d'un fichier Excel / CSV en deux temps (F1.6) :
 * choisir le fichier → prévisualiser (rapport d'erreurs ligne par ligne) → appliquer.
 * Rien n'est écrit avant « Appliquer » ; un fichier contenant des erreurs ne peut pas être appliqué
 * (`can_apply` du serveur fait foi).
 *
 *   <ImportDialog kind="stations" open={open} onOpenChange={setOpen} onApplied={() => stations.invalidate()} />
 */
import { CircleAlert, CircleCheck, Download, FileSpreadsheet, TriangleAlert, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";

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
import { applyImport, downloadImportTemplate, importReportRows, previewImport } from "@/lib/api/imports";
import { EMPTY } from "@/lib/format";
import type { ImportBatch, ImportItem, ImportKind } from "@/lib/types";
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
  /** Options de l'import, transmises en paramètres de requête de la prévisualisation (ex. `{ day }` pour les commandes). */
  fields?: Record<string, string>;
}

const shown = (value: unknown): string =>
  value === null || value === undefined || value === ""
    ? EMPTY
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);

/** Effet annoncé d'une ligne : champs modifiés « avant → après » pour une mise à jour. */
function ItemEffect({ item }: { item: ImportItem }) {
  const changes = item.changes ?? [];
  return (
    <div>
      <span className="font-medium">{item.label || item.key}</span>
      {item.action === "update" && changes.length > 0 && (
        <ul className="mt-0.5 flex flex-col gap-0.5 text-muted-foreground">
          {changes.map((change) => (
            <li key={change.field}>
              {change.label} : <span className="num line-through">{shown(change.before)}</span>
              {" → "}
              <span className="num text-foreground">{shown(change.after)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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
  const rows = useMemo(() => (batch ? importReportRows(batch) : []), [batch]);
  const summary = batch?.report.summary;
  const toWrite = summary ? summary.created + summary.updated : 0;
  const canApply = !!batch && batch.can_apply && toWrite > 0;
  const visibleRows = onlyErrors ? rows.filter((row) => row.status !== "ok") : rows;

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
      notify.success(t.applied(result.report.summary.created + result.report.summary.updated));
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

          {batch && summary && (
            <section aria-label={t.steps.preview} className="flex min-h-0 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <p className="text-sm font-medium" data-testid="import-summary">
                  {t.summary(batch.row_count, batch.error_count)}
                </p>
                <p className="num text-xs text-muted-foreground" data-testid="import-effects">
                  {t.effects(summary.created, summary.updated, summary.unchanged)}
                  {summary.warnings > 0 && ` · ${t.warnings(summary.warnings)}`}
                </p>
                {rows.length > 0 && (
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
              {batch.error_count > 0 || batch.status === "rejected" ? (
                <Notice tone="blocking" icon={<CircleAlert className="size-3.5" />}>
                  {t.hasErrors}
                </Notice>
              ) : batch.row_count === 0 ? (
                <Notice tone="warning">{t.noRows}</Notice>
              ) : toWrite === 0 ? (
                <Notice tone="neutral">{t.nothingToApply}</Notice>
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
                        <th scope="col" className="w-28 border-b px-2 py-1 font-semibold">
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
                          key={row.row ?? "fichier"}
                          data-status={row.status}
                          className={cn(
                            row.status === "error" && "bg-blocking-soft/60",
                            row.status === "warning" && "bg-warning-soft/60",
                          )}
                        >
                          <td className="num border-b px-2 py-1 text-right align-top">
                            {row.row ?? t.wholeFile}
                          </td>
                          <td className="border-b px-2 py-1 align-top">
                            {row.status === "error" ? (
                              <span className="flex items-center gap-1 font-medium text-blocking">
                                <CircleAlert className="size-3" aria-hidden />
                                {t.rowError}
                              </span>
                            ) : (
                              <span
                                className={cn(
                                  "flex items-center gap-1",
                                  row.status === "warning"
                                    ? "font-medium text-warning"
                                    : row.item?.action === "unchanged"
                                      ? "text-muted-foreground"
                                      : "text-success",
                                )}
                              >
                                {row.status === "warning" && <TriangleAlert className="size-3" aria-hidden />}
                                {row.item ? t.actions[row.item.action] : t.rowWarning}
                              </span>
                            )}
                          </td>
                          <td className="border-b px-2 py-1 align-top">
                            {row.item && <ItemEffect item={row.item} />}
                            {row.issues.length > 0 && (
                              <ul className="flex flex-col gap-0.5">
                                {row.issues.map((issue, index) => (
                                  <li
                                    key={index}
                                    className={issue.severity === "warning" ? "text-warning" : undefined}
                                  >
                                    {issue.column && (
                                      <span className="num mr-1 rounded-sm bg-card px-1 text-foreground/70">
                                        {issue.column}
                                      </span>
                                    )}
                                    {issue.message}
                                    {issue.value !== null && issue.value !== "" && (
                                      <span className="num ml-1 text-muted-foreground">({issue.value})</span>
                                    )}
                                  </li>
                                ))}
                              </ul>
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
              {phase === "applying"
                ? t.applying
                : canApply
                  ? t.applyCount(toWrite)
                  : batch.error_count > 0
                    ? t.blockedByErrors(batch.error_count)
                    : t.nothingToApplyShort}
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
