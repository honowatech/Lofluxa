import type { ColumnDef } from "@tanstack/react-table";
import { ArrowRight, X } from "lucide-react";
import { useMemo, useState } from "react";

import { DataTable, useDataTableState } from "@/components/DataTable";
import { Notice } from "@/components/PageHeader";
import { EmptyState } from "@/components/states";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fr } from "@/i18n/fr";
import { toListQuery } from "@/lib/api/pagination";
import { formatDateTime } from "@/lib/format";
import type { AuditEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

import { changedFields, diffRecords, formatAuditValue } from "./diff";
import { audit, AUDITED_TABLES, users } from "./resources";

/** Liste vide stable (évite de recréer les colonnes tant que les données chargent). */
const NONE: never[] = [];

const t = fr.administration.audit;
const EMPTY_FILTERS = { table: "", row_id: "", actor_id: "", action: "", from: "", to: "" };
const ACTIONS = ["insert", "update", "delete"] as const;

export function AuditDiff({ entry }: { entry: AuditEntry }) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const rows = useMemo(() => diffRecords(entry.before, entry.after), [entry]);
  const changed = changedFields(rows);
  const visible = showUnchanged ? rows : changed;
  return (
    <section
      aria-label={t.diffTitle}
      className="flex min-h-0 flex-col rounded-md border bg-card"
      data-testid="audit-diff"
    >
      <header className="border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground/70">{t.diffTitle}</h3>
          <StatusBadge kind="audit" value={entry.action} />
        </div>
        <p className="num mt-1 truncate text-xs text-muted-foreground" title={entry.row_id}>
          {entry.table_name} · {entry.row_id}
        </p>
        <p className="text-xs text-muted-foreground">
          {formatDateTime(entry.at)} · {entry.actor_name ?? entry.actor_id ?? t.system}
          {entry.actor_email && ` (${entry.actor_email})`}
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {visible.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">{t.noDiff}</p>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-xs">
            <thead className="sticky top-0 bg-muted text-left text-foreground/70">
              <tr>
                <th scope="col" className="border-b px-3 py-1 font-semibold">
                  {t.field}
                </th>
                <th scope="col" className="border-b px-2 py-1 font-semibold">
                  {t.before}
                </th>
                <th scope="col" className="w-4 border-b" />
                <th scope="col" className="border-b px-2 py-1 font-semibold">
                  {t.after}
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr
                  key={row.field}
                  data-kind={row.kind}
                  className={cn(row.kind === "unchanged" && "text-muted-foreground")}
                >
                  <th scope="row" className="num border-b px-3 py-1 text-left align-top font-medium">
                    {row.field}
                  </th>
                  <td
                    className={cn(
                      "num break-all border-b px-2 py-1 align-top",
                      row.kind !== "unchanged" && row.kind !== "added" && "bg-blocking-soft text-blocking",
                    )}
                  >
                    {formatAuditValue(row.before)}
                  </td>
                  <td className="border-b align-top">
                    <ArrowRight className="mt-1.5 size-3 text-muted-foreground" aria-hidden />
                  </td>
                  <td
                    className={cn(
                      "num break-all border-b px-2 py-1 align-top",
                      row.kind !== "unchanged" && row.kind !== "removed" && "bg-success-soft text-success",
                    )}
                  >
                    {formatAuditValue(row.after)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {rows.length > changed.length && (
        <label className="flex items-center gap-1.5 border-t px-3 py-1.5 text-xs">
          <input
            type="checkbox"
            checked={showUnchanged}
            onChange={(event) => setShowUnchanged(event.target.checked)}
          />
          {t.showUnchanged}
        </label>
      )}
    </section>
  );
}

export function AuditTab() {
  const [state, setState] = useDataTableState();
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const actors = users.useAll().data ?? NONE;
  const periodInvalid = !!filters.from && !!filters.to && filters.to < filters.from;

  // Jours locaux (Douala), bornes incluses : le serveur fait la conversion vers l'UTC. `row_id` : valeur exacte.
  const query = {
    ...toListQuery({ pageIndex: state.pageIndex, pageSize: state.pageSize }),
    table: filters.table,
    row_id: filters.row_id.trim(),
    actor_id: filters.actor_id,
    action: filters.action,
    date_from: filters.from,
    date_to: filters.to,
  };
  const list = audit.useList(query, { enabled: !periodInvalid });
  const hasFilters = Object.values(filters).some((value) => value !== "");

  const patch = (changes: Partial<typeof EMPTY_FILTERS>) => {
    setFilters((current) => ({ ...current, ...changes }));
    setState({ ...state, pageIndex: 0 });
    setSelected(null);
  };

  // Colonnes mémorisées : une nouvelle définition à chaque rendu remonterait toutes les cellules (menus, édition).
  const columns = useMemo<ColumnDef<AuditEntry, unknown>[]>(
    () => [
      {
        accessorKey: "at",
        header: t.at,
        enableSorting: false,
        meta: { className: "w-36" },
        cell: ({ row }) => <span className="num">{formatDateTime(row.original.at)}</span>,
      },
      {
        accessorKey: "actor_name",
        header: t.actor,
        enableSorting: false,
        cell: ({ row }) =>
          row.original.actor_name ??
          (row.original.actor_id ? (
            <span className="num">{row.original.actor_id}</span>
          ) : (
            <span className="text-muted-foreground">{t.system}</span>
          )),
      },
      {
        accessorKey: "action",
        header: t.action,
        enableSorting: false,
        meta: { className: "w-28" },
        cell: ({ row }) => <StatusBadge kind="audit" value={row.original.action} />,
      },
      {
        accessorKey: "table_name",
        header: t.table,
        enableSorting: false,
        meta: { className: "w-24" },
        cell: ({ row }) => <span className="num">{row.original.table_name}</span>,
      },
      {
        accessorKey: "row_id",
        header: t.rowId,
        enableSorting: false,
        meta: { className: "w-40" },
        cell: ({ row }) => (
          <span className="num text-xs" title={row.original.row_id}>
            {row.original.row_id.length > 18 ? `…${row.original.row_id.slice(-12)}` : row.original.row_id}
          </span>
        ),
      },
      {
        id: "changes",
        header: t.changes,
        enableSorting: false,
        cell: ({ row }) => {
          const fields = changedFields(diffRecords(row.original.before, row.original.after)).map(
            (d) => d.field,
          );
          return (
            <span className="text-xs" title={fields.join(", ")}>
              <span className="text-muted-foreground">{t.changesCount(fields.length)} : </span>
              <span className="num">
                {fields.slice(0, 4).join(", ")}
                {fields.length > 4 ? "…" : ""}
              </span>
            </span>
          );
        },
      },
    ],
    [],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <form
        className="flex flex-wrap items-end gap-2"
        role="search"
        aria-label={fr.table.filters}
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="flex flex-col gap-0.5">
          <Label htmlFor="audit-table">{t.table}</Label>
          <NativeSelect
            id="audit-table"
            value={filters.table}
            onChange={(event) => patch({ table: event.target.value })}
            className="h-7 w-36 text-xs"
          >
            <option value="">{t.allTables}</option>
            {AUDITED_TABLES.map((table) => (
              <option key={table} value={table}>
                {table}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-0.5">
          <Label htmlFor="audit-row">{t.rowId}</Label>
          <Input
            id="audit-row"
            value={filters.row_id}
            onChange={(event) => patch({ row_id: event.target.value })}
            placeholder={t.rowIdPlaceholder}
            className="num h-7 w-56 text-xs"
          />
        </div>
        <div className="flex flex-col gap-0.5">
          <Label htmlFor="audit-actor">{t.actor}</Label>
          <NativeSelect
            id="audit-actor"
            value={filters.actor_id}
            onChange={(event) => patch({ actor_id: event.target.value })}
            className="h-7 w-48 text-xs"
          >
            <option value="">{t.allActors}</option>
            {actors.map((user) => (
              <option key={user.id} value={user.id}>
                {user.full_name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-0.5">
          <Label htmlFor="audit-action">{t.action}</Label>
          <NativeSelect
            id="audit-action"
            value={filters.action}
            onChange={(event) => patch({ action: event.target.value })}
            className="h-7 w-32 text-xs"
          >
            <option value="">{t.allActions}</option>
            {ACTIONS.map((action) => (
              <option key={action} value={action}>
                {fr.status.audit[action]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-0.5">
          <Label htmlFor="audit-from">{t.from}</Label>
          <Input
            id="audit-from"
            type="date"
            value={filters.from}
            onChange={(event) => patch({ from: event.target.value })}
            className="num h-7 w-36 text-xs"
          />
        </div>
        <div className="flex flex-col gap-0.5">
          <Label htmlFor="audit-to">{t.to}</Label>
          <Input
            id="audit-to"
            type="date"
            value={filters.to}
            aria-invalid={periodInvalid}
            onChange={(event) => patch({ to: event.target.value })}
            className="num h-7 w-36 text-xs"
          />
        </div>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={() => patch(EMPTY_FILTERS)}>
            <X />
            {fr.table.clearFilters}
          </Button>
        )}
        <p className="ml-auto max-w-sm text-right text-xs text-muted-foreground">{t.intro}</p>
      </form>
      {periodInvalid && <Notice tone="blocking">{t.periodInvalid}</Notice>}

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,34%)]">
        <DataTable<AuditEntry>
          caption={fr.administration.tabs.audit}
          columns={columns}
          data={periodInvalid ? [] : (list.data?.items ?? [])}
          total={periodInvalid ? 0 : (list.data?.total ?? 0)}
          state={state}
          onStateChange={setState}
          loading={list.isLoading}
          fetching={list.isFetching}
          error={list.error}
          onRetry={() => void list.refetch()}
          getRowId={(row) => row.id}
          onRowActivate={setSelected}
          onRowFocus={(row) => row && setSelected(row)}
          highlightedRowId={selected?.id}
          empty={t.empty}
          className="min-h-0"
        />
        {selected ? (
          <AuditDiff entry={selected} />
        ) : (
          <div className="rounded-md border border-dashed bg-card">
            <EmptyState title={t.diffTitle} description={t.selectHint} />
          </div>
        )}
      </div>
    </div>
  );
}
