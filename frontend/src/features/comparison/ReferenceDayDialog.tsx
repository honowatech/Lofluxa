/**
 * Import de la journée de référence (F8.1) par `POST /reference-days/import` :
 * fichier + date, temps de préparation, libellé → contrôle seul (`dry_run`) → rapport ligne par ligne →
 * import. Une journée déjà importée pour la date (409 `reference_day_exists`) n'est remplacée qu'après
 * confirmation.
 *
 * `ImportDialog` (partagé) ne couvre pas ce cas : pas de champs propres à la journée, pas de
 * remplacement confirmé, et un rapport par feuille / ligne / colonne plutôt que par ligne.
 */
import { CircleAlert, CircleCheck, Download, FileSpreadsheet, TriangleAlert, Upload } from "lucide-react";
import { useEffect, useId, useRef, useState, type DragEvent } from "react";

import { Notice, notify, Spinner, useConfirm } from "@/components";
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
import { DateInput } from "@/components/forms";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fr } from "@/i18n/fr";
import { downloadFile, errorMessage, isApiError, type ApiError } from "@/lib/api";
import { EMPTY, formatDate, formatLiters, parseDecimal } from "@/lib/format";
import { cn } from "@/lib/utils";

import { importReferenceDay, type ImportIssue, type ReferenceDayImport } from "./api";

const t = fr.screens.comparison.importDialog;

interface Report {
  day: string | null;
  errors: ImportIssue[];
  warnings: ImportIssue[];
  summary: Record<string, unknown>;
  /** Message du serveur quand le fichier est rejeté. */
  rejected: string | null;
}

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw => (value && typeof value === "object" ? (value as Raw) : {});

const asIssues = (entries: unknown): ImportIssue[] =>
  (Array.isArray(entries) ? entries : [])
    .map(asRecord)
    .filter((entry) => typeof entry.message === "string")
    .map((entry) => ({
      sheet: typeof entry.sheet === "string" ? entry.sheet : "",
      row: typeof entry.row === "number" ? entry.row : null,
      column: typeof entry.column === "string" ? entry.column : null,
      message: entry.message as string,
    }));

/**
 * Rapport d'un fichier rejeté (422 `import_rejected`). Le corps de la réponse porte `errors`, `warnings`,
 * `summary` et `day` en plus de l'enveloppe ; à défaut, `details[]` mêle erreurs et avertissements,
 * distingués par `severity`.
 */
function rejectedReport(error: ApiError): Report {
  const body = asRecord(error.body);
  const bySeverity = (warning: boolean) =>
    error.details.filter((detail) => ((detail.severity as string) === "warning") === warning);
  return {
    day: typeof body.day === "string" ? body.day : null,
    errors: asIssues(Array.isArray(body.errors) ? body.errors : bySeverity(false)),
    warnings: asIssues(Array.isArray(body.warnings) ? body.warnings : bySeverity(true)),
    summary: asRecord(body.summary),
    rejected: error.message,
  };
}

const count = (summary: Record<string, unknown>, key: string): number | null =>
  typeof summary[key] === "number" ? (summary[key] as number) : null;

function SummaryLine({ summary }: { summary: Record<string, unknown> }) {
  const orders = count(summary, "orders");
  const trips = count(summary, "trips");
  const stops = count(summary, "stops");
  const volume = count(summary, "volume_delivered_l");
  const km = count(summary, "trips_with_actual_km");
  const parts = [
    orders !== null && t.summary.orders(orders),
    trips !== null && t.summary.trips(trips),
    stops !== null && t.summary.stops(stops),
    volume !== null && t.summary.volume(formatLiters(volume)),
    km !== null && trips !== null && t.summary.km(km, trips),
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <p className="num text-xs text-muted-foreground" data-testid="reference-summary">
      {parts.join(" · ")}
    </p>
  );
}

function IssuesTable({ errors, warnings }: { errors: ImportIssue[]; warnings: ImportIssue[] }) {
  const rows = [
    ...errors.map((issue) => ({ issue, level: "error" as const })),
    ...warnings.map((issue) => ({ issue, level: "warning" as const })),
  ];
  if (rows.length === 0) return null;
  const th = "border-b px-2 py-1 text-left font-semibold";
  return (
    <div className="max-h-[36vh] overflow-auto rounded-md border">
      <table className="w-full border-separate border-spacing-0 text-xs">
        <caption className="sr-only">{t.issuesCaption}</caption>
        <thead className="sticky top-0 bg-muted text-foreground/70">
          <tr>
            <th scope="col" className={cn(th, "w-28")}>
              {t.columns.level}
            </th>
            <th scope="col" className={th}>
              {t.columns.sheet}
            </th>
            <th scope="col" className={cn(th, "w-12 text-right")}>
              {t.columns.row}
            </th>
            <th scope="col" className={th}>
              {t.columns.column}
            </th>
            <th scope="col" className={th}>
              {t.columns.message}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ issue, level }, index) => (
            <tr
              key={index}
              data-level={level}
              className={level === "error" ? "bg-blocking-soft/60" : "bg-warning-soft/60"}
            >
              <td className="border-b px-2 py-1 align-top">
                {level === "error" ? (
                  <span className="flex items-center gap-1 font-medium text-blocking">
                    <CircleAlert className="size-3" aria-hidden />
                    {t.error}
                  </span>
                ) : (
                  <span className="flex items-center gap-1 font-medium text-warning">
                    <TriangleAlert className="size-3" aria-hidden />
                    {t.warning}
                  </span>
                )}
              </td>
              <td className="border-b px-2 py-1 align-top">{issue.sheet || EMPTY}</td>
              <td className="num border-b px-2 py-1 text-right align-top">{issue.row ?? EMPTY}</td>
              <td className="border-b px-2 py-1 align-top">{issue.column ?? EMPTY}</td>
              <td className="border-b px-2 py-1 align-top">{issue.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface ReferenceDayDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (result: ReferenceDayImport) => void;
}

export function ReferenceDayDialog({ open, onOpenChange, onImported }: ReferenceDayDialogProps) {
  const confirm = useConfirm();
  const ids = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [day, setDay] = useState("");
  const [prep, setPrep] = useState("");
  const [label, setLabel] = useState("");
  const [phase, setPhase] = useState<"idle" | "checking" | "applying">("idle");
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setDay("");
    setPrep("");
    setLabel("");
    setPhase("idle");
    setReport(null);
    setError(null);
  }, [open]);

  const busy = phase !== "idle";
  const prepValue = prep.trim() === "" ? null : parseDecimal(prep);
  const prepInvalid = prep.trim() !== "" && (prepValue === null || prepValue < 0);
  const canCheck = !!file && !prepInvalid && !busy;
  const canApply = !!report && report.errors.length === 0 && !busy;
  const step = report ? "report" : "file";

  /** Toute modification du fichier ou des champs invalide le contrôle déjà fait. */
  const edit = <T,>(setter: (value: T) => void) => {
    return (value: T) => {
      setter(value);
      setReport(null);
      setError(null);
    };
  };

  const pick = (next: File | null | undefined) => {
    if (!next) return;
    if (!next.name.toLowerCase().endsWith(".xlsx")) {
      setError(t.badType);
      return;
    }
    edit(setFile)(next);
  };

  const fields = () => ({ day: day || null, prep_time_min: prepValue, label: label.trim() || null });

  const check = async () => {
    if (!file) return;
    setPhase("checking");
    setError(null);
    try {
      const result = await importReferenceDay(file, { ...fields(), dry_run: true });
      setReport({
        day: result.day,
        errors: result.errors,
        warnings: result.warnings,
        summary: result.summary,
        rejected: null,
      });
    } catch (caught) {
      if (isApiError(caught) && caught.code === "import_rejected") {
        setReport(rejectedReport(caught));
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      setPhase("idle");
    }
  };

  const apply = async (replace = false) => {
    if (!file) return;
    setPhase("applying");
    setError(null);
    try {
      const result = await importReferenceDay(file, { ...fields(), replace });
      notify.success(t.done(formatDate(result.day)), t.doneHint);
      onImported(result);
      onOpenChange(false);
    } catch (caught) {
      setPhase("idle");
      if (isApiError(caught) && caught.code === "reference_day_exists" && !replace) {
        const accepted = await confirm({
          title: t.existsTitle,
          description: t.existsBody(caught.message),
          confirmLabel: t.existsConfirm,
          destructive: true,
        });
        if (accepted) await apply(true);
        return;
      }
      if (isApiError(caught) && caught.code === "import_rejected") {
        setReport(rejectedReport(caught));
        return;
      }
      setError(errorMessage(caught));
      return;
    }
    setPhase("idle");
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
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>{t.intro}</DialogDescription>
          <ol className="mt-1 flex gap-4 text-xs">
            {(["file", "report"] as const).map((key) => (
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
              accept=".xlsx"
              className="sr-only"
              aria-label={t.file}
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
                downloadFile("/imports/templates/reference_day", {
                  fallbackName: "reference_day.xlsx",
                }).catch((caught) => notify.apiError(caught, t.templateFailed))
              }
            >
              <Download />
              {t.template}
            </Button>
          </div>

          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-[11rem_13rem_minmax(0,1fr)]">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${ids}-day`}>{t.day}</Label>
              <DateInput
                id={`${ids}-day`}
                value={day || null}
                disabled={busy}
                onChange={(next) => edit(setDay)(next ?? "")}
                aria-describedby={`${ids}-day-hint`}
              />
              <p id={`${ids}-day-hint`} className="text-2xs text-muted-foreground">
                {t.dayHint}
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${ids}-prep`}>{t.prep}</Label>
              <div className="flex items-center gap-1.5">
                <Input
                  id={`${ids}-prep`}
                  inputMode="decimal"
                  value={prep}
                  disabled={busy}
                  aria-invalid={prepInvalid}
                  aria-describedby={`${ids}-prep-hint`}
                  onChange={(event) => edit(setPrep)(event.target.value)}
                  className="num w-24 text-right"
                />
                <span className="text-xs text-muted-foreground">{t.prepUnit}</span>
              </div>
              <p
                id={`${ids}-prep-hint`}
                className={cn("text-2xs", prepInvalid ? "text-blocking" : "text-muted-foreground")}
              >
                {prepInvalid ? t.prepInvalid : t.prepHint}
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${ids}-label`}>{t.label}</Label>
              <Input
                id={`${ids}-label`}
                value={label}
                maxLength={160}
                disabled={busy}
                placeholder={t.labelPlaceholder}
                onChange={(event) => edit(setLabel)(event.target.value)}
              />
            </div>
          </div>

          {phase === "checking" && (
            <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner /> {t.checking}
            </p>
          )}

          {report && (
            <section
              aria-label={t.reportTitle}
              className="flex min-h-0 flex-col gap-2"
              data-testid="reference-report"
            >
              {report.errors.length > 0 ? (
                <Notice tone="blocking" icon={<CircleAlert className="size-3.5" />}>
                  {report.rejected ?? t.reportErrors(report.errors.length)}
                </Notice>
              ) : (
                <Notice tone="info" icon={<CircleCheck className="size-3.5" />}>
                  {report.day ? t.reportOk(formatDate(report.day)) : t.reportOkNoDay}
                </Notice>
              )}
              <SummaryLine summary={report.summary} />
              <IssuesTable errors={report.errors} warnings={report.warnings} />
            </section>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {fr.common.cancel}
          </Button>
          {report && report.errors.length === 0 ? (
            <Button disabled={!canApply} onClick={() => void apply()}>
              {phase === "applying" && <Spinner className="text-current" />}
              {phase === "applying" ? t.applying : t.apply}
            </Button>
          ) : (
            <Button disabled={!canCheck} onClick={() => void check()}>
              {phase === "checking" && <Spinner className="text-current" />}
              {t.check}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
