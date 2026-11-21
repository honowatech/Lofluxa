/**
 * Tableau de données dense, entièrement utilisable au clavier (TanStack Table).
 *
 *   const [state, setState] = useDataTableState({ sorting: [{ id: "code", desc: false }] });
 *   const { data, isLoading, isFetching, error, refetch } = stations.useList(toListQuery(state));
 *
 *   <DataTable
 *     caption="Stations"
 *     columns={columns}                      // ColumnDef<Station>[] ; `meta.edit` rend une colonne éditable
 *     data={data?.items ?? []}
 *     total={data?.total}                    // présent = tri / filtres / pagination côté serveur
 *     state={state} onStateChange={setState}
 *     loading={isLoading} fetching={isFetching} error={error} onRetry={refetch}
 *     getRowId={(row) => row.id}
 *     searchable filters={[{ id: "active", label: "État", options: [...] }]}
 *     selectable bulkActions={[{ label: "Supprimer", destructive: true, onClick: removeRows }]}
 *     onRowActivate={openEditForm}           // Entrée ou double-clic
 *   />
 *
 * Sans `total`, le tableau trie, filtre et pagine lui-même les lignes reçues (petites listes).
 *
 * Clavier : flèches (cellule), Début / Fin (ligne), Ctrl+Début / Ctrl+Fin (tableau), Page préc. / suiv.
 * (page), Entrée ou F2 (modifier la cellule, sinon ouvrir la ligne), saisie directe (remplace la valeur),
 * Entrée / Tab (valider), Échap (annuler), Espace (sélectionner), Ctrl+A (tout sélectionner).
 */
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type RowData,
  type RowSelectionState,
  type SortingState,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Keyboard,
  MoreHorizontal,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input, NativeSelect } from "@/components/ui/input";
import { Tip } from "@/components/ui/tooltip";
import { fr } from "@/i18n/fr";
import { pageBounds, pageCount } from "@/lib/api/pagination";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS } from "@/lib/config";
import { parseDecimal } from "@/lib/format";
import { cn } from "@/lib/utils";

import { notify } from "./notify";
import { EmptyState, ErrorState, Skeleton, Spinner } from "./states";

/* ------------------------------------------------------------------ types */

export type CellValue = string | number | null;

export interface CellEdit<T> {
  type: "text" | "number" | "select";
  /** Valeur brute à modifier (défaut : valeur de la colonne). */
  getValue?: (row: T) => CellValue;
  /** Choix d'une colonne `select`. */
  options?: { value: string; label: string }[];
  /** Renvoie un message d'erreur, ou `undefined` si la valeur est acceptée. */
  validate?: (value: CellValue, row: T) => string | undefined;
  /** Enregistre la valeur ; une exception laisse la cellule en édition et notifie l'erreur. */
  onCommit: (row: T, value: CellValue) => void | Promise<unknown>;
  /** Désactive l'édition pour certaines lignes. */
  enabled?: (row: T) => boolean;
}

declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Libellé lisible (lecteurs d'écran, tri) quand `header` n'est pas une chaîne. */
    label?: string;
    align?: "left" | "right" | "center";
    /** Classes de largeur de la colonne, ex. `w-24`. */
    className?: string;
    edit?: CellEdit<TData>;
  }
}

export interface DataTableState {
  pageIndex: number;
  pageSize: number;
  sorting: SortingState;
  search: string;
  filters: Record<string, string>;
}

export function useDataTableState(initial: Partial<DataTableState> = {}) {
  return useState<DataTableState>({
    pageIndex: 0,
    pageSize: DEFAULT_PAGE_SIZE,
    sorting: [],
    search: "",
    filters: {},
    ...initial,
  });
}

export interface DataTableFilter {
  /** Nom du paramètre de requête (mode serveur) ou identifiant de colonne (mode local). */
  id: string;
  label: string;
  options: { value: string; label: string }[];
}

export interface BulkAction<T> {
  label: string;
  icon?: ReactNode;
  destructive?: boolean;
  /** La sélection est vidée quand la promesse se termine sans erreur. */
  onClick: (rows: T[]) => void | Promise<unknown>;
}

export interface DataTableProps<T> {
  /** Nom accessible du tableau. */
  caption: string;
  // Le type de valeur d'une colonne varie d'une colonne à l'autre : `any` est le type attendu par TanStack Table.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: ColumnDef<T, any>[];
  data: T[];
  getRowId: (row: T) => string;
  state: DataTableState;
  onStateChange: (state: DataTableState) => void;
  /** Nombre total de lignes côté serveur. Absent = tri / filtres / pagination locaux. */
  total?: number;
  loading?: boolean;
  fetching?: boolean;
  error?: unknown;
  onRetry?: () => void;
  searchable?: boolean;
  searchPlaceholder?: string;
  filters?: DataTableFilter[];
  /** Actions à droite de la barre d'outils (bouton « Nouveau », import…). */
  toolbar?: ReactNode;
  selectable?: boolean;
  bulkActions?: BulkAction<T>[];
  /** Entrée ou double-clic sur une ligne (hors cellule éditable). */
  onRowActivate?: (row: T) => void;
  /** Ligne mise en évidence depuis l'extérieur (ex. point sélectionné sur la carte). */
  highlightedRowId?: string | null;
  /** Appelé quand le curseur clavier ou la souris change de ligne (ex. surligner le point sur la carte). */
  onRowFocus?: (row: T | null) => void;
  rowClassName?: (row: T) => string | undefined;
  /** Contenu de l'état vide (sans filtre actif). */
  empty?: ReactNode;
  hidePagination?: boolean;
  className?: string;
}

/* ------------------------------------------------------------ sous-parties */

const SELECT_COLUMN = "__select";

/** Menu d'actions d'une ligne. Atteignable au clavier : Entrée sur la cellule ouvre le menu. */
export function RowActions({
  label = fr.common.actions,
  items,
}: {
  label?: string;
  items: (
    | { label: string; icon?: ReactNode; onSelect: () => void; destructive?: boolean; disabled?: boolean }
    | "separator"
  )[];
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} tabIndex={-1} data-cell-action>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {items.map((item, index) =>
          item === "separator" ? (
            <DropdownMenuSeparator key={index} />
          ) : (
            <DropdownMenuItem
              key={item.label}
              destructive={item.destructive}
              disabled={item.disabled}
              onSelect={item.onSelect}
            >
              {item.icon}
              {item.label}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const [text, setText] = useState(value);
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => setText(value), [value]);
  // Recherche différée : pas de requête à chaque frappe.
  useEffect(() => {
    if (text === value) return;
    const timer = window.setTimeout(() => latest.current(text), 250);
    return () => window.clearTimeout(timer);
  }, [text, value]);
  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        type="search"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={placeholder}
        aria-label={fr.common.search}
        className="h-7 w-52 pl-7 text-xs"
      />
    </div>
  );
}

function CellEditor<T>({
  edit,
  row,
  initial,
  seed,
  onDone,
}: {
  edit: CellEdit<T>;
  row: T;
  initial: CellValue;
  /** Premier caractère tapé pour entrer en édition (remplace la valeur). */
  seed?: string;
  onDone: (result: "commit" | "cancel", move?: -1 | 1) => void;
}) {
  const [text, setText] = useState(
    seed ?? (initial === null ? "" : String(initial).replace(".", edit.type === "number" ? "," : ".")),
  );
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const settled = useRef(false);

  const commit = async (move?: -1 | 1) => {
    if (settled.current || busy) return;
    let value: CellValue = text.trim() === "" ? null : text.trim();
    if (edit.type === "number" && value !== null) {
      value = parseDecimal(String(value));
      if (value === null) {
        setError(fr.table.invalidValue);
        return;
      }
    }
    const message = edit.validate?.(value, row);
    if (message) {
      setError(message);
      return;
    }
    if (value === initial) {
      settled.current = true;
      onDone("cancel", move);
      return;
    }
    setBusy(true);
    try {
      await edit.onCommit(row, value);
      settled.current = true;
      onDone("commit", move);
    } catch (caught) {
      notify.apiError(caught, fr.errors.saveFailed);
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      void commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      settled.current = true;
      onDone("cancel");
    } else if (event.key === "Tab") {
      event.preventDefault();
      void commit(event.shiftKey ? -1 : 1);
    }
  };

  const common = {
    autoFocus: true,
    disabled: busy,
    "aria-invalid": !!error,
    title: error,
    onKeyDown,
    onBlur: () => void commit(),
    className: "h-6 rounded-sm px-1 text-sm",
  };

  return (
    <span className="relative -mx-1 block">
      {edit.type === "select" ? (
        <NativeSelect
          {...common}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setError(undefined);
          }}
        >
          {(edit.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
      ) : (
        <Input
          {...common}
          inputMode={edit.type === "number" ? "decimal" : undefined}
          value={text}
          onFocus={(event) => !seed && event.target.select()}
          onChange={(event) => {
            setText(event.target.value);
            setError(undefined);
          }}
          className={cn(common.className, edit.type === "number" && "num text-right")}
        />
      )}
      {error && (
        <span
          role="alert"
          className="absolute left-0 top-full z-20 mt-0.5 whitespace-nowrap rounded-sm bg-blocking px-1.5 py-0.5 text-xs text-white shadow-pop"
        >
          {error}
        </span>
      )}
    </span>
  );
}

/* --------------------------------------------------------------- tableau */

export function DataTable<T>({
  caption,
  columns,
  data,
  getRowId,
  state,
  onStateChange,
  total,
  loading,
  fetching,
  error,
  onRetry,
  searchable,
  searchPlaceholder = fr.table.search,
  filters = [],
  toolbar,
  selectable,
  bulkActions = [],
  onRowActivate,
  highlightedRowId,
  onRowFocus,
  rowClassName,
  empty,
  hidePagination,
  className,
}: DataTableProps<T>) {
  const serverMode = total !== undefined;
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [active, setActive] = useState({ row: 0, col: 0 });
  const [editing, setEditing] = useState<{ rowId: string; colId: string; seed?: string } | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const focusPending = useRef(false);

  const allColumns = useMemo<ColumnDef<T, unknown>[]>(() => {
    if (!selectable) return columns;
    const select: ColumnDef<T, unknown> = {
      id: SELECT_COLUMN,
      enableSorting: false,
      meta: { className: "w-8", label: fr.table.selectRow },
      header: ({ table }) => (
        <Checkbox
          aria-label={fr.table.selectAll}
          checked={
            table.getIsAllPageRowsSelected()
              ? true
              : table.getIsSomePageRowsSelected()
                ? "indeterminate"
                : false
          }
          onCheckedChange={(checked) => table.toggleAllPageRowsSelected(checked === true)}
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          aria-label={fr.table.selectRow}
          tabIndex={-1}
          checked={row.getIsSelected()}
          onCheckedChange={(checked) => row.toggleSelected(checked === true)}
        />
      ),
    };
    return [select, ...columns];
  }, [columns, selectable]);

  const columnIds = useMemo(
    () =>
      new Set(
        columns.map((c) => c.id ?? (c as { accessorKey?: string }).accessorKey).filter(Boolean) as string[],
      ),
    [columns],
  );

  const table = useReactTable<T>({
    data,
    columns: allColumns,
    getRowId,
    state: {
      sorting: state.sorting,
      pagination: { pageIndex: state.pageIndex, pageSize: state.pageSize },
      rowSelection,
      globalFilter: serverMode ? undefined : state.search,
      columnFilters: serverMode
        ? []
        : Object.entries(state.filters)
            .filter(([id, value]) => value !== "" && columnIds.has(id))
            .map(([id, value]) => ({ id, value })),
    },
    defaultColumn: { filterFn: (row, id, value) => String(row.getValue(id)) === String(value) },
    globalFilterFn: "includesString",
    manualPagination: serverMode,
    manualSorting: serverMode,
    manualFiltering: serverMode,
    rowCount: serverMode ? total : undefined,
    enableRowSelection: !!selectable,
    enableMultiSort: false,
    autoResetPageIndex: false,
    onRowSelectionChange: setRowSelection,
    onSortingChange: (updater) => {
      const sorting = typeof updater === "function" ? updater(state.sorting) : updater;
      onStateChange({ ...state, sorting, pageIndex: 0 });
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  const rows = table.getRowModel().rows;
  const leafColumns = table.getVisibleLeafColumns();
  const totalRows = serverMode ? (total ?? 0) : table.getFilteredRowModel().rows.length;
  const pages = pageCount(totalRows, state.pageSize);
  const bounds = pageBounds({
    total: totalRows,
    limit: state.pageSize,
    offset: state.pageIndex * state.pageSize,
  });
  const selectedRows = table.getSelectedRowModel().rows.map((row) => row.original);
  const hasActiveFilters = state.search !== "" || Object.values(state.filters).some((v) => v !== "");

  // La sélection ne survit pas à un changement de page ou de filtre : pas d'action en masse sur des lignes invisibles.
  const filterSignature = JSON.stringify(state.filters);
  useEffect(() => {
    setRowSelection({});
    setEditing(null);
  }, [state.pageIndex, state.pageSize, state.search, filterSignature]);

  // Si la dernière page se vide (suppression), revenir à la dernière page existante.
  useEffect(() => {
    if (!loading && !fetching && state.pageIndex > 0 && state.pageIndex >= pages) {
      onStateChange({ ...state, pageIndex: pages - 1 });
    }
  }, [loading, fetching, pages, state, onStateChange]);

  const clampedActive = {
    row: Math.min(active.row, Math.max(0, rows.length - 1)),
    col: Math.min(active.col, Math.max(0, leafColumns.length - 1)),
  };

  const focusCell = useCallback((row: number, col: number) => {
    bodyRef.current?.querySelector<HTMLElement>(`[data-cell="${row}:${col}"]`)?.focus();
  }, []);

  useEffect(() => {
    if (!focusPending.current || editing) return;
    focusPending.current = false;
    focusCell(clampedActive.row, clampedActive.col);
  });

  const moveTo = (row: number, col: number) => {
    const next = {
      row: Math.max(0, Math.min(rows.length - 1, row)),
      col: Math.max(0, Math.min(leafColumns.length - 1, col)),
    };
    focusPending.current = true;
    setActive(next);
    const original = rows[next.row]?.original ?? null;
    if (next.row !== clampedActive.row) onRowFocus?.(original);
  };

  const goToPage = (pageIndex: number) => {
    const next = Math.max(0, Math.min(pages - 1, pageIndex));
    if (next !== state.pageIndex) onStateChange({ ...state, pageIndex: next });
  };

  const editOf = (colIndex: number, rowIndex: number): CellEdit<T> | undefined => {
    const edit = leafColumns[colIndex]?.columnDef.meta?.edit;
    const row = rows[rowIndex];
    if (!edit || !row) return undefined;
    return edit.enabled && !edit.enabled(row.original) ? undefined : edit;
  };

  const startEditing = (rowIndex: number, colIndex: number, seed?: string) => {
    const row = rows[rowIndex];
    if (!row || !editOf(colIndex, rowIndex)) return false;
    setActive({ row: rowIndex, col: colIndex });
    setEditing({ rowId: row.id, colId: leafColumns[colIndex].id, seed });
    return true;
  };

  const onBodyKeyDown = (event: KeyboardEvent<HTMLTableSectionElement>) => {
    if (editing || rows.length === 0) return;
    // Seules les touches frappées sur une cellule pilotent la grille (pas celles d'un bouton ou d'un menu interne).
    if (!(event.target as HTMLElement).matches("[data-cell]")) return;
    const { row, col } = clampedActive;
    const ctrl = event.ctrlKey || event.metaKey;
    const handled = () => event.preventDefault();

    switch (event.key) {
      case "ArrowDown":
        handled();
        return moveTo(row + 1, col);
      case "ArrowUp":
        handled();
        return moveTo(row - 1, col);
      case "ArrowRight":
        handled();
        return moveTo(row, col + 1);
      case "ArrowLeft":
        handled();
        return moveTo(row, col - 1);
      case "Home":
        handled();
        return moveTo(ctrl ? 0 : row, 0);
      case "End":
        handled();
        return moveTo(ctrl ? rows.length - 1 : row, leafColumns.length - 1);
      case "PageDown":
        handled();
        focusPending.current = true;
        return goToPage(state.pageIndex + 1);
      case "PageUp":
        handled();
        focusPending.current = true;
        return goToPage(state.pageIndex - 1);
      case " ":
        if (selectable) {
          handled();
          rows[row]?.toggleSelected();
        }
        return;
      case "a":
      case "A":
        if (ctrl && selectable) {
          handled();
          table.toggleAllPageRowsSelected(true);
        }
        return;
      case "Escape":
        if (Object.keys(rowSelection).length > 0) {
          handled();
          setRowSelection({});
        }
        return;
      case "Enter":
      case "F2": {
        handled();
        if (startEditing(row, col)) return;
        const cell = bodyRef.current?.querySelector<HTMLElement>(`[data-cell="${row}:${col}"]`);
        const action = cell?.querySelector<HTMLElement>("[data-cell-action]");
        if (action) {
          // Radix ouvre ses menus sur `pointerdown` ; `click()` seul ne suffit pas.
          action.focus();
          action.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          return;
        }
        if (leafColumns[col]?.id === SELECT_COLUMN) return rows[row]?.toggleSelected();
        if (rows[row]) onRowActivate?.(rows[row].original);
        return;
      }
      default:
        // Saisie directe : un caractère imprimable remplace la valeur d'une cellule éditable.
        if (event.key.length === 1 && !ctrl && !event.altKey) {
          const edit = editOf(col, row);
          if (edit && edit.type !== "select") {
            handled();
            startEditing(row, col, event.key);
          }
        }
    }
  };

  const runBulk = async (action: BulkAction<T>) => {
    setBulkBusy(true);
    try {
      await action.onClick(selectedRows);
      setRowSelection({});
    } catch {
      // L'appelant notifie ; la sélection est conservée pour un nouvel essai.
    } finally {
      setBulkBusy(false);
    }
  };

  const showSkeleton = loading && data.length === 0;
  const columnCount = leafColumns.length;

  return (
    <div className={cn("flex min-h-0 flex-col rounded-md border bg-card", className)}>
      {/* Barre d'outils : recherche, filtres, actions ; remplacée par les actions en masse dès qu'il y a une sélection. */}
      {(searchable || filters.length > 0 || toolbar || selectable) && (
        <div className="flex min-h-10 flex-wrap items-center gap-2 border-b px-2 py-1.5">
          {selectedRows.length > 0 ? (
            <div
              className="flex flex-1 flex-wrap items-center gap-2"
              role="toolbar"
              aria-label={fr.table.selected(selectedRows.length)}
            >
              <span
                className="rounded-sm bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground"
                aria-live="polite"
              >
                {fr.table.selected(selectedRows.length)}
              </span>
              {bulkActions.map((action) => (
                <Button
                  key={action.label}
                  size="sm"
                  variant={action.destructive ? "destructive-outline" : "outline"}
                  disabled={bulkBusy}
                  onClick={() => void runBulk(action)}
                >
                  {action.icon}
                  {action.label}
                </Button>
              ))}
              <Button size="sm" variant="ghost" onClick={() => setRowSelection({})}>
                <X />
                {fr.table.clearSelection}
              </Button>
            </div>
          ) : (
            <>
              {searchable && (
                <SearchBox
                  value={state.search}
                  placeholder={searchPlaceholder}
                  onChange={(search) => onStateChange({ ...state, search, pageIndex: 0 })}
                />
              )}
              {filters.map((filter) => (
                <NativeSelect
                  key={filter.id}
                  aria-label={filter.label}
                  value={state.filters[filter.id] ?? ""}
                  onChange={(event) =>
                    onStateChange({
                      ...state,
                      pageIndex: 0,
                      filters: { ...state.filters, [filter.id]: event.target.value },
                    })
                  }
                  className={cn(
                    "h-7 w-auto max-w-44 text-xs",
                    state.filters[filter.id] && "border-primary bg-accent",
                  )}
                >
                  <option value="">{`${filter.label} : ${fr.common.all.toLowerCase()}`}</option>
                  {filter.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </NativeSelect>
              ))}
              {hasActiveFilters && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onStateChange({ ...state, search: "", filters: {}, pageIndex: 0 })}
                >
                  <X />
                  {fr.table.clearFilters}
                </Button>
              )}
              <div className="ml-auto flex items-center gap-2">{toolbar}</div>
            </>
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-auto">
        {fetching && !showSkeleton && (
          <div
            className="absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden bg-accent"
            role="status"
            aria-label={fr.table.loadingRows}
          >
            <div className="h-full w-1/3 animate-[pulse_1s_ease-in-out_infinite] bg-primary" />
          </div>
        )}
        <table
          role="grid"
          aria-label={caption}
          aria-rowcount={totalRows}
          aria-busy={!!fetching}
          className="w-full border-separate border-spacing-0 text-sm"
        >
          <thead className="sticky top-0 z-10">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const meta = header.column.columnDef.meta;
                  const sorted = header.column.getIsSorted();
                  const label =
                    meta?.label ??
                    (typeof header.column.columnDef.header === "string"
                      ? header.column.columnDef.header
                      : header.id);
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={
                        sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : header.column.getCanSort()
                              ? "none"
                              : undefined
                      }
                      className={cn(
                        "h-8 whitespace-nowrap border-b bg-muted px-2 text-left text-xs font-semibold text-foreground/70",
                        meta?.align === "right" && "text-right",
                        meta?.align === "center" && "text-center",
                        meta?.className,
                      )}
                    >
                      {header.isPlaceholder ? null : header.column.getCanSort() ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          title={fr.table.sortBy(label)}
                          className={cn(
                            "-mx-1 inline-flex items-center gap-1 rounded-sm px-1 py-0.5 hover:bg-border/60 focus-ring",
                            meta?.align === "right" && "flex-row-reverse",
                            sorted && "text-foreground",
                          )}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {sorted === "asc" ? (
                            <ArrowUp className="size-3" aria-label={fr.table.sortAsc} />
                          ) : sorted === "desc" ? (
                            <ArrowDown className="size-3" aria-label={fr.table.sortDesc} />
                          ) : (
                            <ChevronsUpDown className="size-3 opacity-40" aria-hidden />
                          )}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>

          <tbody ref={bodyRef} onKeyDown={onBodyKeyDown}>
            {showSkeleton &&
              Array.from({ length: 8 }, (_, r) => (
                <tr key={`skeleton-${r}`} aria-hidden>
                  {Array.from({ length: columnCount }, (_, c) => (
                    <td key={c} className="h-8 border-b px-2">
                      <Skeleton className={c === 0 && selectable ? "w-4" : "w-3/4"} />
                    </td>
                  ))}
                </tr>
              ))}

            {!showSkeleton &&
              rows.map((row, rowIndex) => {
                const selected = row.getIsSelected();
                const highlighted = highlightedRowId === row.id;
                return (
                  <tr
                    key={row.id}
                    aria-selected={selectable ? selected : undefined}
                    aria-rowindex={state.pageIndex * state.pageSize + rowIndex + 1}
                    data-row-id={row.id}
                    onMouseEnter={onRowFocus ? () => onRowFocus(row.original) : undefined}
                    onDoubleClick={(event) => {
                      if ((event.target as HTMLElement).closest("button,input,select,a,[role=checkbox]"))
                        return;
                      onRowActivate?.(row.original);
                    }}
                    className={cn(
                      "group",
                      selected ? "bg-accent/70" : highlighted ? "bg-signal/15" : "hover:bg-muted/60",
                      rowClassName?.(row.original),
                    )}
                  >
                    {row.getVisibleCells().map((cell, colIndex) => {
                      const meta = cell.column.columnDef.meta;
                      const isActive = clampedActive.row === rowIndex && clampedActive.col === colIndex;
                      const isEditing = editing?.rowId === row.id && editing.colId === cell.column.id;
                      const edit = editOf(colIndex, rowIndex);
                      return (
                        <td
                          key={cell.id}
                          role="gridcell"
                          data-cell={`${rowIndex}:${colIndex}`}
                          data-editable={edit ? "" : undefined}
                          tabIndex={isActive && !isEditing ? 0 : -1}
                          onFocus={() => {
                            if (!isActive) setActive({ row: rowIndex, col: colIndex });
                          }}
                          onDoubleClick={(event) => {
                            if (edit) {
                              event.stopPropagation();
                              startEditing(rowIndex, colIndex);
                            }
                          }}
                          className={cn(
                            "h-8 max-w-[22rem] truncate border-b px-2 outline-none",
                            "focus:bg-accent focus:shadow-[inset_0_0_0_2px_hsl(var(--ring))]",
                            meta?.align === "right" && "text-right",
                            meta?.align === "center" && "text-center",
                            edit && "cursor-cell",
                            isEditing && "overflow-visible",
                            meta?.className,
                          )}
                        >
                          {isEditing && edit ? (
                            <CellEditor
                              edit={edit}
                              row={row.original}
                              seed={editing.seed}
                              initial={
                                edit.getValue
                                  ? edit.getValue(row.original)
                                  : ((cell.getValue() as CellValue) ?? null)
                              }
                              onDone={(_, move) => {
                                setEditing(null);
                                focusPending.current = true;
                                if (move)
                                  setActive({
                                    row: rowIndex,
                                    col: Math.max(0, Math.min(leafColumns.length - 1, colIndex + move)),
                                  });
                              }}
                            />
                          ) : (
                            flexRender(cell.column.columnDef.cell, cell.getContext())
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
          </tbody>
        </table>

        {!showSkeleton && !!error && rows.length === 0 && <ErrorState error={error} onRetry={onRetry} />}
        {!showSkeleton && !error && rows.length === 0 && (
          <EmptyState
            title={hasActiveFilters ? fr.table.emptyFiltered : fr.table.empty}
            description={hasActiveFilters ? undefined : empty}
            action={
              hasActiveFilters ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onStateChange({ ...state, search: "", filters: {}, pageIndex: 0 })}
                >
                  {fr.table.clearFilters}
                </Button>
              ) : undefined
            }
          />
        )}
      </div>

      {!hidePagination && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-2 py-1 text-xs text-muted-foreground">
          <Tip label={fr.table.keyboardHelp} side="top">
            <button
              type="button"
              className="rounded-sm p-1 hover:bg-muted focus-ring"
              aria-label={fr.table.keyboardHelpLabel}
            >
              <Keyboard className="size-3.5" />
            </button>
          </Tip>
          <span className="num" aria-live="polite">
            {fr.table.range(bounds.from, bounds.to, totalRows)}
          </span>
          {fetching && <Spinner className="size-3" />}
          <label className="ml-auto flex items-center gap-1.5">
            {fr.table.rowsPerPage}
            <NativeSelect
              value={state.pageSize}
              onChange={(event) =>
                onStateChange({ ...state, pageSize: Number(event.target.value), pageIndex: 0 })
              }
              className="h-6 w-16 px-1 text-xs"
            >
              {[...new Set([...PAGE_SIZE_OPTIONS, state.pageSize])]
                .sort((a, b) => a - b)
                .map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
            </NativeSelect>
          </label>
          <span className="num">{fr.table.page(state.pageIndex + 1, pages)}</span>
          <div className="flex items-center">
            {(
              [
                [fr.table.firstPage, ChevronFirst, 0, state.pageIndex === 0],
                [fr.table.previousPage, ChevronLeft, state.pageIndex - 1, state.pageIndex === 0],
                [fr.table.nextPage, ChevronRight, state.pageIndex + 1, state.pageIndex >= pages - 1],
                [fr.table.lastPage, ChevronLast, pages - 1, state.pageIndex >= pages - 1],
              ] as const
            ).map(([label, Icon, target, disabled]) => (
              <Button
                key={label}
                variant="ghost"
                size="icon-sm"
                aria-label={label}
                title={label}
                disabled={disabled}
                onClick={() => goToPage(target)}
              >
                <Icon />
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
