/**
 * Onglet CRUD générique de l'écran Référentiels : tableau (toutes les lignes chargées, tri / recherche /
 * filtres locaux — l'API n'offre pas de tri), formulaire de création / modification, suppression confirmée
 * (ligne ou sélection), import facultatif.
 */
import type { ColumnDef } from "@tanstack/react-table";
import { Eye, FileUp, Pencil, Plus, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import type { DefaultValues, UseFormReturn } from "react-hook-form";
import type { z } from "zod";

import { useConfirm } from "@/components/ConfirmDialog";
import {
  DataTable,
  RowActions,
  useDataTableState,
  type BulkAction,
  type DataTableFilter,
  type DataTableState,
} from "@/components/DataTable";
import { EntityFormDialog } from "@/components/forms";
import { ImportDialog } from "@/components/ImportDialog";
import { notify } from "@/components/notify";
import { Button } from "@/components/ui/button";
import { fr } from "@/i18n/fr";
import type { Resource } from "@/lib/api/resource";
import type { ImportKind, UUID } from "@/lib/types";

const t = fr.referentials;
const NONE: never[] = [];

export interface CrudTabProps<T extends { id: UUID }, TInput, S extends z.ZodTypeAny> {
  resource: Resource<T, TInput>;
  caption: string;
  texts: { new: string; edit: string; empty: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: ColumnDef<T, any>[];
  rowLabel: (row: T) => string;
  canWrite: boolean;
  schema: S;
  /** Valeurs du formulaire pour une ligne existante, ou pour une création (`null`). */
  toForm: (row: T | null) => DefaultValues<z.input<S>>;
  /** Enregistrement ; par défaut `POST` / `PUT` de la ressource avec les valeurs validées. */
  save?: (values: z.output<S>, row: T | null) => Promise<unknown>;
  renderForm: (form: UseFormReturn<z.input<S>, unknown, z.output<S>>, row: T | null) => ReactNode;
  formPlacement?: "side" | "center";
  filters?: DataTableFilter[];
  initialState?: Partial<DataTableState>;
  importKind?: ImportKind;
  extraBulkActions?: BulkAction<T>[];
  highlightedRowId?: string | null;
  onRowFocus?: (row: T | null) => void;
  /** Rendu autour du tableau (carte à droite, bandeau au-dessus) : reçoit les lignes retenues par la recherche et les filtres. */
  layout?: (table: ReactNode, rows: T[]) => ReactNode;
}

export function CrudTab<T extends { id: UUID }, TInput, S extends z.ZodTypeAny>({
  resource,
  caption,
  texts,
  columns,
  rowLabel,
  canWrite,
  schema,
  toForm,
  save,
  renderForm,
  formPlacement,
  filters,
  initialState,
  importKind,
  extraBulkActions = [],
  highlightedRowId,
  onRowFocus,
  layout,
}: CrudTabProps<T, TInput, S>) {
  const [state, setState] = useDataTableState(initialState);
  const list = resource.useAll({}, { staleTime: 0 });
  const queryClient = useQueryClient();
  const [visibleRows, setVisibleRows] = useState<T[]>(NONE);
  const create = resource.useCreate();
  const update = resource.useUpdate();
  const remove = resource.useRemove();
  const removeMany = resource.useRemoveMany();
  const confirm = useConfirm();

  const [editing, setEditing] = useState<{ row: T | null } | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const deleteOne = async (row: T) => {
    const label = rowLabel(row);
    if (
      !(await confirm({
        title: fr.confirm.deleteTitle,
        description: fr.confirm.deleteOne(label),
        destructive: true,
      }))
    )
      return;
    try {
      await remove.mutateAsync(row.id);
      notify.success(t.deleted(label));
    } catch (error) {
      notify.apiError(error, fr.errors.deleteFailed);
    }
  };

  const deleteMany = async (rows: T[]) => {
    if (
      !(await confirm({
        title: fr.confirm.deleteTitle,
        description: fr.confirm.deleteMany(rows.length),
        destructive: true,
      }))
    ) {
      throw new Error("annulé");
    }
    try {
      await removeMany.mutateAsync(rows.map((row) => row.id));
      notify.success(t.deletedMany(rows.length));
    } catch (error) {
      notify.apiError(error, fr.errors.deleteFailed);
      throw error;
    }
  };

  const allColumns = useMemo<ColumnDef<T, unknown>[]>(
    () => [
      ...columns,
      {
        id: "__actions",
        enableSorting: false,
        header: () => <span className="sr-only">{fr.common.actions}</span>,
        meta: { className: "w-9", label: fr.common.actions, align: "right" },
        cell: ({ row }) => (
          <RowActions
            label={`${fr.common.actions} — ${rowLabel(row.original)}`}
            items={
              canWrite
                ? [
                    {
                      label: fr.common.edit,
                      icon: <Pencil />,
                      onSelect: () => setEditing({ row: row.original }),
                    },
                    "separator",
                    {
                      label: fr.common.delete,
                      icon: <Trash2 />,
                      destructive: true,
                      onSelect: () => void deleteOne(row.original),
                    },
                  ]
                : [
                    {
                      label: fr.common.details,
                      icon: <Eye />,
                      onSelect: () => setEditing({ row: row.original }),
                    },
                  ]
            }
          />
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columns, canWrite],
  );

  const onSubmit = async (values: z.output<S>) => {
    const row = editing?.row ?? null;
    if (save) await save(values, row);
    else if (row) await update.mutateAsync({ id: row.id, input: values as Partial<TInput> });
    else await create.mutateAsync(values as TInput);
    const label = rowLabel({ ...(row ?? {}), ...(values as object) } as T);
    notify.success(row ? t.updated(label) : t.created(label));
  };

  const table = (
    <DataTable<T>
      caption={caption}
      columns={allColumns}
      data={list.data ?? NONE}
      onRowsChange={setVisibleRows}
      state={state}
      onStateChange={setState}
      loading={list.isLoading}
      fetching={list.isFetching}
      error={list.error}
      onRetry={() => void list.refetch()}
      getRowId={(row) => row.id}
      searchable
      filters={filters}
      selectable={canWrite}
      bulkActions={
        canWrite
          ? [
              ...extraBulkActions,
              { label: fr.common.delete, icon: <Trash2 />, destructive: true, onClick: deleteMany },
            ]
          : []
      }
      onRowActivate={(row) => setEditing({ row })}
      highlightedRowId={highlightedRowId}
      onRowFocus={onRowFocus}
      empty={texts.empty}
      className="h-full"
      toolbar={
        canWrite && (
          <>
            {importKind && (
              <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
                <FileUp />
                {fr.common.import}
              </Button>
            )}
            <Button size="sm" onClick={() => setEditing({ row: null })}>
              <Plus />
              {texts.new}
            </Button>
          </>
        )
      }
    />
  );

  return (
    <>
      {layout ? layout(table, visibleRows) : table}
      <EntityFormDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing?.row ? texts.edit : texts.new}
        description={editing?.row ? rowLabel(editing.row) : undefined}
        schema={schema}
        defaultValues={toForm(editing?.row ?? null)}
        onSubmit={onSubmit}
        readOnly={!canWrite}
        placement={formPlacement}
      >
        {(form) => renderForm(form, editing?.row ?? null)}
      </EntityFormDialog>
      {importKind && (
        <ImportDialog
          kind={importKind}
          open={importOpen}
          onOpenChange={setImportOpen}
          onApplied={() => void queryClient.invalidateQueries({ queryKey: resource.keys.all })}
        />
      )}
    </>
  );
}
