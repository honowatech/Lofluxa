/** Onglet « Stocks dépôt » (F2.1) : grille dépôt × produit à saisie rapide, auteur et heure, historique. */
import { CircleCheck, History, RotateCcw, Save, TriangleAlert } from "lucide-react";
import { useMemo, useState, type FormEvent, type KeyboardEvent } from "react";

import { useConfirm } from "@/components/ConfirmDialog";
import { NumberInput } from "@/components/forms";
import { notify } from "@/components/notify";
import { Notice } from "@/components/PageHeader";
import { EmptyState, ErrorState, LoadingState, Spinner } from "@/components/states";
import { Badge } from "@/components/ui/badge";
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
import { formatDateTime, formatLiters, formatLocalTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import { useDepotStocks, useSaveStocks, useStockHistory, type DepotStock } from "./api";

const t = fr.screens.availability.stocks;

const cellKey = (depotId: string, productId: string) => `${depotId}:${productId}`;

type HistoryTarget = { depotId?: string; productId?: string; title: string };

function HistoryDialog({
  day,
  target,
  onClose,
}: {
  day: string;
  target: HistoryTarget | null;
  onClose: () => void;
}) {
  const history = useStockHistory(day, target);
  const columns = t.historyColumns;
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl" data-testid="stock-history">
        <DialogHeader>
          <DialogTitle>{target?.title}</DialogTitle>
          <DialogDescription className="sr-only">{t.dayHistoryTitle}</DialogDescription>
        </DialogHeader>
        <DialogBody className="p-0">
          {history.isLoading ? (
            <LoadingState compact />
          ) : history.error ? (
            <ErrorState compact error={history.error} onRetry={() => void history.refetch()} />
          ) : (history.data ?? []).length === 0 ? (
            <EmptyState compact title={t.historyEmpty} />
          ) : (
            <table className="w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr>
                  {[columns.at, columns.depot, columns.product, columns.volume, columns.author].map(
                    (header, index) => (
                      <th
                        key={header}
                        scope="col"
                        className={cn(
                          "sticky top-0 border-b bg-muted px-3 py-1.5 text-left text-xs font-semibold text-foreground/70",
                          index === 3 && "text-right",
                        )}
                      >
                        {header}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {(history.data ?? []).map((entry) => (
                  <tr key={entry.id} className={entry.is_current ? "bg-accent/50" : undefined}>
                    <td className="num whitespace-nowrap border-b px-3 py-1.5">
                      {formatDateTime(entry.entered_at)}
                    </td>
                    <td className="border-b px-3 py-1.5">
                      <span className="num text-xs text-muted-foreground">{entry.depot_code}</span>{" "}
                      {entry.depot_name}
                    </td>
                    <td className="border-b px-3 py-1.5">{entry.product_label}</td>
                    <td className="num whitespace-nowrap border-b px-3 py-1.5 text-right">
                      {entry.available_l === null ? (
                        <span className="font-sans text-xs text-warning">{t.erasedEntry}</span>
                      ) : (
                        formatLiters(entry.available_l)
                      )}
                    </td>
                    <td className="border-b px-3 py-1.5">
                      <span className="flex items-center gap-2">
                        {entry.entered_by_name ?? t.unknownAuthor}
                        {entry.is_current && <Badge tone="primary">{t.current}</Badge>}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>{t.close}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function StocksTab({ day, canWrite }: { day: string; canWrite: boolean }) {
  const stocks = useDepotStocks(day);
  const save = useSaveStocks(day);
  const confirm = useConfirm();
  /** Cellules modifiées et pas encore enregistrées (`null` = cellule vidée). */
  const [draft, setDraft] = useState<Record<string, number | null>>({});
  const [history, setHistory] = useState<HistoryTarget | null>(null);

  const { depots, products, byKey } = useMemo(() => {
    const rows = stocks.data ?? [];
    const depotMap = new Map<string, { id: string; code: string; name: string }>();
    const productMap = new Map<string, { id: string; code: string; label: string }>();
    const index = new Map<string, DepotStock>();
    for (const row of rows) {
      depotMap.set(row.depot_id, { id: row.depot_id, code: row.depot_code, name: row.depot_name });
      productMap.set(row.product_id, {
        id: row.product_id,
        code: row.product_code,
        label: row.product_label,
      });
      index.set(cellKey(row.depot_id, row.product_id), row);
    }
    return {
      depots: [...depotMap.values()].sort((a, b) => a.code.localeCompare(b.code, "fr")),
      products: [...productMap.values()].sort((a, b) => a.code.localeCompare(b.code, "fr")),
      byKey: index,
    };
  }, [stocks.data]);

  const valueOf = (key: string): number | null =>
    key in draft ? draft[key] : (byKey.get(key)?.available_l ?? null);

  const errorOf = (key: string): string | undefined => {
    if (!(key in draft)) return undefined;
    const value = draft[key];
    // Cellule vidée : effacement de la saisie, confirmé à l'enregistrement.
    if (value === null) return undefined;
    if (Number.isNaN(value)) return t.invalid;
    if (value < 0) return t.negative;
    return undefined;
  };

  const dirtyKeys = Object.keys(draft);
  const hasError = dirtyKeys.some((key) => errorOf(key));
  const entered = [...byKey.values()].filter((row) => row.available_l !== null).length;
  const missing = byKey.size - entered;

  const change = (key: string, value: number | null) => {
    const saved = byKey.get(key)?.available_l ?? null;
    setDraft((current) => {
      const next = { ...current };
      // Retour à la valeur enregistrée (ou cellule jamais renseignée laissée vide) : plus rien à enregistrer.
      if (Object.is(value, saved)) delete next[key];
      else next[key] = value;
      return next;
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canWrite || dirtyKeys.length === 0 || hasError || save.isPending) return;
    const items = dirtyKeys.map((key) => {
      const [depot_id, product_id] = key.split(":");
      return { depot_id, product_id, available_l: draft[key] };
    });
    // Effacer une saisie est destructif (le stock redevient « non renseigné ») : jamais sans confirmation.
    const erased = dirtyKeys.filter((key) => draft[key] === null).map((key) => byKey.get(key));
    if (
      erased.length > 0 &&
      !(await confirm({
        title: t.eraseTitle,
        description: t.eraseBody(
          erased.map((row) => (row ? t.cellLabel(row.depot_code, row.product_label) : "")).join(", "),
        ),
        confirmLabel: t.eraseAction,
        destructive: true,
      }))
    )
      return;
    try {
      await save.mutateAsync(items);
      setDraft({});
      notify.success(
        erased.length === items.length ? t.erased(erased.length) : t.saved(items.length - erased.length),
      );
    } catch (error) {
      notify.apiError(error, t.saveFailed);
    }
  };

  /** Flèches haut / bas : même produit, dépôt précédent / suivant. */
  const onArrow = (event: KeyboardEvent<HTMLInputElement>, row: number, col: number) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const target = document.querySelector<HTMLInputElement>(
      `[data-stock-cell="${row + (event.key === "ArrowDown" ? 1 : -1)}:${col}"]`,
    );
    if (target) {
      event.preventDefault();
      target.focus();
    }
  };

  if (stocks.isLoading) return <LoadingState />;
  if (stocks.error && !stocks.data)
    return <ErrorState error={stocks.error} onRetry={() => void stocks.refetch()} />;
  if (depots.length === 0) return <EmptyState title={t.empty} description={t.emptyHint} />;

  return (
    <form
      onSubmit={(event) => void submit(event)}
      noValidate
      className="flex h-full min-h-0 flex-col gap-2"
      data-testid="stocks-tab"
    >
      <div className="flex flex-wrap items-center gap-2">
        {missing === 0 ? (
          <Badge tone="success">
            <CircleCheck className="size-3" aria-hidden />
            {t.complete}
          </Badge>
        ) : (
          <Badge tone="warning">
            <TriangleAlert className="size-3" aria-hidden />
            {t.missingCount(missing)}
          </Badge>
        )}
        <span className="num text-xs text-muted-foreground">{t.status(entered, byKey.size)}</span>
        <div className="ml-auto flex items-center gap-2">
          {dirtyKeys.length > 0 && (
            <span className="text-xs font-medium text-warning" aria-live="polite">
              {t.dirty(dirtyKeys.length)}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setHistory({ title: t.dayHistoryTitle })}
            data-testid="day-history"
          >
            <History />
            {t.dayHistory}
          </Button>
          {canWrite && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDraft({})}
                disabled={dirtyKeys.length === 0 || save.isPending}
              >
                <RotateCcw />
                {t.discard}
              </Button>
              <Button type="submit" size="sm" disabled={dirtyKeys.length === 0 || hasError || save.isPending}>
                {save.isPending ? <Spinner className="text-primary-foreground" /> : <Save />}
                {t.save(dirtyKeys.length)}
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="min-h-0 overflow-auto rounded-md border bg-card">
        <table
          aria-label={t.caption}
          className="w-full border-separate border-spacing-0 text-sm"
          data-testid="stocks-grid"
        >
          <thead className="sticky top-0 z-10">
            <tr>
              <th
                scope="col"
                className="h-8 border-b bg-muted px-3 text-left text-xs font-semibold text-foreground/70"
              >
                {t.depot}
              </th>
              {products.map((product) => (
                <th
                  key={product.id}
                  scope="col"
                  className="h-8 w-56 border-b bg-muted px-3 text-left text-xs font-semibold text-foreground/70"
                >
                  {product.label}{" "}
                  <span className="num font-normal text-muted-foreground">{product.code}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {depots.map((depot, rowIndex) => (
              <tr key={depot.id} className="align-top">
                <th scope="row" className="border-b px-3 py-2 text-left font-normal">
                  <span className="block font-medium">{depot.name}</span>
                  <span className="num text-xs text-muted-foreground">{depot.code}</span>
                </th>
                {products.map((product, colIndex) => {
                  const key = cellKey(depot.id, product.id);
                  const row = byKey.get(key);
                  if (!row) return <td key={product.id} className="border-b px-3 py-2" />;
                  const error = errorOf(key);
                  const dirty = key in draft;
                  const label = t.cellLabel(depot.code, product.label);
                  return (
                    <td key={product.id} className="border-b px-3 py-2" data-testid={`stock-${key}`}>
                      {canWrite ? (
                        <NumberInput
                          aria-label={label}
                          aria-invalid={!!error}
                          title={error}
                          data-stock-cell={`${rowIndex}:${colIndex}`}
                          value={valueOf(key)}
                          onChange={(value) => change(key, value)}
                          onKeyDown={(event) => onArrow(event, rowIndex, colIndex)}
                          unit={fr.fields.litersUnit}
                          grouped
                          className={cn(
                            "h-7",
                            dirty && !error && "border-signal bg-signal/10",
                            error && "border-destructive",
                          )}
                        />
                      ) : (
                        <span className="num block text-right text-sm font-medium" aria-label={label}>
                          {row.available_l === null ? "" : formatLiters(row.available_l)}
                        </span>
                      )}
                      <div className="mt-1 flex min-h-5 items-center gap-1 text-xs">
                        {error ? (
                          <span role="alert" className="text-destructive">
                            {error}
                          </span>
                        ) : dirty && draft[key] === null ? (
                          <span className="font-medium text-warning">{t.willErase}</span>
                        ) : row.available_l === null ? (
                          <span className="flex min-w-0 items-center gap-1 text-warning">
                            <TriangleAlert className="size-3 shrink-0" aria-hidden />
                            <span className="truncate">
                              {row.entered_at
                                ? t.erasedBy(formatLocalTime(row.entered_at), row.entered_by_name)
                                : t.missing}
                            </span>
                          </span>
                        ) : (
                          <span className="truncate text-muted-foreground">
                            {t.enteredBy(formatLocalTime(row.entered_at), row.entered_by_name)}
                          </span>
                        )}
                        {row.history_count > 0 && (
                          <button
                            type="button"
                            tabIndex={-1}
                            onClick={() =>
                              setHistory({
                                depotId: depot.id,
                                productId: product.id,
                                title: t.historyOf(depot.code, product.label),
                              })
                            }
                            aria-label={`${t.history} — ${label}`}
                            title={`${t.history} : ${t.historyCount(row.history_count)}`}
                            className="num ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-sm px-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-ring"
                          >
                            <History className="size-3" aria-hidden />
                            {row.history_count}
                          </button>
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th
                scope="row"
                className="bg-muted/40 px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-foreground/60"
              >
                {t.total}
              </th>
              {products.map((product) => {
                const values = depots.map((depot) => valueOf(cellKey(depot.id, product.id)));
                const known = values.filter(
                  (value): value is number => value !== null && !Number.isNaN(value),
                );
                return (
                  <td
                    key={product.id}
                    className="num bg-muted/40 px-3 py-1.5 text-right font-semibold"
                    data-testid={`stock-total-${product.code}`}
                  >
                    {known.length === 0 ? "" : formatLiters(known.reduce((sum, value) => sum + value, 0))}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>

      {canWrite && <p className="text-xs text-muted-foreground">{t.hint}</p>}
      {stocks.error && <Notice tone="warning">{stocks.error.message}</Notice>}
      <HistoryDialog day={day} target={history} onClose={() => setHistory(null)} />
    </form>
  );
}
