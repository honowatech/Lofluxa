/** Écran 3 — Commandes du jour : tableau éditable, import, confirmation en masse, filtres, totaux. */
import type { ColumnDef } from "@tanstack/react-table";
import {
  Ban,
  CalendarClock,
  Check,
  CheckCheck,
  CircleAlert,
  Eye,
  FileUp,
  Lock,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { useConfirm } from "@/components/ConfirmDialog";
import { DataTable, RowActions, useDataTableState, type CellValue } from "@/components/DataTable";
import { normalizeTime, TIME_RE } from "@/components/forms";
import { ImportDialog } from "@/components/ImportDialog";
import { notify } from "@/components/notify";
import { Notice, PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { fr } from "@/i18n/fr";
import { isApiError, type ApiError } from "@/lib/api/errors";
import { useCan } from "@/lib/auth/session";
import { EMPTY, formatDateLong, formatLiters } from "@/lib/format";
import { ORDER_PRIORITIES, ORDER_STATUSES } from "@/lib/types";
import { useDay } from "@/lib/useDay";

import {
  capacityMax,
  isEditable,
  products,
  stations,
  useOrderMutations,
  useOrders,
  type Order,
  type OrderFilters,
  type OrderInput,
  type OrderPatch,
  type OrderWarning,
} from "./api";
import { BulkConfirmDialog, type BulkReport } from "./BulkConfirmDialog";
import { OrderFormDialog, priorityOptions } from "./OrderFormDialog";
import { Totals } from "./Totals";

const t = fr.screens.orders;
const NONE: never[] = [];

const orderLabel = (order: Order) =>
  t.label(order.station_name, order.product_label, formatLiters(order.requested_l));

const statusOptions = ORDER_STATUSES.map((value) => ({ value, label: fr.status.order[value] }));

interface Refusal {
  order: Order;
  error: ApiError;
  kind: "confirm" | "update";
}

const validateTime = (value: CellValue) =>
  value === null || TIME_RE.test(normalizeTime(String(value))) ? undefined : fr.fields.timeInvalid;

export default function OrdersPage() {
  const { day } = useDay();
  const canWrite = useCan("orders.write");
  const confirm = useConfirm();
  const [params] = useSearchParams();

  // Filtre initial transmis par l'écran Journée (`?status=draft`).
  const initialStatus = params.get("status");
  const [state, setState] = useDataTableState({
    pageSize: 100,
    sorting: [{ id: "station", desc: false }],
    filters: ORDER_STATUSES.some((status) => status === initialStatus)
      ? { status: initialStatus as string }
      : {},
  });
  const filters: OrderFilters = {
    station_id: state.filters.station_id || undefined,
    product_id: state.filters.product_id || undefined,
    status: state.filters.status || undefined,
    priority: state.filters.priority || undefined,
  };

  const list = useOrders(day, filters);
  const stationList = stations.useAll().data ?? NONE;
  const productList = products.useAll().data ?? NONE;
  const mutations = useOrderMutations();

  const [editing, setEditing] = useState<{ order: Order | null } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [report, setReport] = useState<BulkReport | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // `GET /orders` ne renvoie pas les avertissements F3.4 : on garde ceux reçus pendant la session.
  const [sessionWarnings, setSessionWarnings] = useState<Record<string, OrderWarning[]>>({});

  const rows = useMemo(
    () =>
      (list.data ?? NONE).map((order) =>
        order.warnings.length === 0 && sessionWarnings[order.id]
          ? { ...order, warnings: sessionWarnings[order.id] }
          : order,
      ),
    [list.data, sessionWarnings],
  );
  const drafts = rows.filter((order) => order.status === "draft");
  const warned = rows.filter((order) => order.warnings.length > 0).length;

  const remember = (order: Order) => {
    setSessionWarnings((current) => ({ ...current, [order.id]: order.warnings }));
    if (order.warnings.length > 0) {
      notify.warning(t.notify.warning, order.warnings.map((warning) => warning.message).join(" "));
    }
  };

  /** Refus F3.4 : expliqué dans un bandeau persistant (volume recevable, comment corriger). */
  const explain = (error: unknown, order: Order, kind: Refusal["kind"]): boolean => {
    if (isApiError(error) && error.code === "order_exceeds_tank_capacity") {
      setRefusal({ order, error, kind });
      return true;
    }
    return false;
  };

  const patch = async (order: Order, changes: OrderPatch) => {
    try {
      const updated = await mutations.patch.mutateAsync({ id: order.id, changes });
      setRefusal((current) => (current?.order.id === order.id ? null : current));
      remember(updated);
    } catch (error) {
      explain(error, order, "update");
      throw error;
    }
  };

  const save = async (input: OrderInput, order: Order | null) => {
    try {
      if (order) {
        remember(await mutations.replace.mutateAsync({ id: order.id, input }));
        setRefusal((current) => (current?.order.id === order.id ? null : current));
        notify.success(t.notify.updated);
      } else {
        await mutations.create.mutateAsync(input);
        notify.success(t.notify.created);
      }
    } catch (error) {
      if (order) explain(error, order, "update");
      throw error;
    }
  };

  const confirmOne = async (order: Order) => {
    try {
      const confirmed = await mutations.confirm.mutateAsync(order.id);
      setRefusal((current) => (current?.order.id === order.id ? null : current));
      setSessionWarnings((current) => ({ ...current, [confirmed.id]: confirmed.warnings }));
      if (confirmed.warnings.length > 0) {
        notify.warning(
          t.notify.confirmedWithWarnings,
          confirmed.warnings.map((warning) => warning.message).join(" "),
        );
      } else notify.success(t.notify.confirmed);
    } catch (error) {
      if (!explain(error, order, "confirm")) notify.apiError(error, t.notify.confirmFailed);
    }
  };

  const transition = async (order: Order, action: "cancel" | "postpone") => {
    const label = orderLabel(order);
    const ok = await confirm(
      action === "cancel"
        ? {
            title: t.confirm.cancelTitle,
            description: t.confirm.cancelBody(label),
            confirmLabel: t.confirm.cancelAction,
            cancelLabel: t.confirm.keep,
            destructive: true,
          }
        : {
            title: t.confirm.postponeTitle,
            description: t.confirm.postponeBody(label),
            confirmLabel: t.confirm.postponeAction,
            cancelLabel: t.confirm.keep,
            destructive: true,
          },
    );
    if (!ok) return;
    try {
      await mutations[action].mutateAsync(order.id);
      notify.success(action === "cancel" ? t.notify.cancelled : t.notify.postponed);
    } catch (error) {
      notify.apiError(error, action === "cancel" ? t.notify.cancelFailed : t.notify.postponeFailed);
    }
  };

  const deleteOne = async (order: Order) => {
    if (
      !(await confirm({
        title: fr.confirm.deleteTitle,
        description: t.confirm.deleteBody(orderLabel(order)),
        destructive: true,
      }))
    )
      return;
    try {
      await mutations.remove.mutateAsync(order.id);
      notify.success(t.notify.deleted);
    } catch (error) {
      notify.apiError(error, fr.errors.deleteFailed);
    }
  };

  /** Confirmation en masse : seuls les brouillons sont envoyés ; le serveur répond commande par commande. */
  const confirmMany = async (selection: Order[]) => {
    const targets = selection.filter((order) => order.status === "draft");
    if (targets.length === 0) {
      notify.info(t.notify.noDraftSelected, t.notify.noDraftSelectedHint);
      throw new Error("aucun brouillon");
    }
    try {
      const result = await mutations.confirmMany.mutateAsync(targets.map((order) => order.id));
      setSessionWarnings((current) => {
        const next = { ...current };
        for (const item of result.results) if (item.ok) next[item.order_id] = item.warnings;
        return next;
      });
      const hasIssue = result.failed > 0 || result.results.some((item) => item.warnings.length > 0);
      if (hasIssue || selection.length !== targets.length) {
        setReport({
          result,
          labels: Object.fromEntries(targets.map((order) => [order.id, orderLabel(order)])),
          ignored: selection.length - targets.length,
        });
      } else notify.success(t.bulk.done(result.confirmed));
    } catch (error) {
      notify.apiError(error, t.bulk.failed);
      throw error;
    }
  };

  const confirmAllDrafts = async () => {
    if (
      !(await confirm({
        title: t.confirm.confirmAllTitle,
        description: t.confirm.confirmAllBody(drafts.length),
        confirmLabel: t.confirm.confirmAllAction,
      }))
    )
      return;
    await confirmMany(drafts).catch(() => undefined);
  };

  const deleteDrafts = async (selection: Order[]) => {
    const targets = selection.filter((order) => order.status === "draft");
    if (targets.length === 0) {
      notify.info(t.notify.noDraftSelected, t.notify.noDraftSelectedHint);
      throw new Error("aucun brouillon");
    }
    if (
      !(await confirm({
        title: t.confirm.deleteDraftsTitle,
        description: t.confirm.deleteDraftsBody(targets.length, selection.length - targets.length),
        confirmLabel: fr.common.delete,
        destructive: true,
      }))
    )
      throw new Error("annulé");
    try {
      await mutations.removeMany.mutateAsync(targets.map((order) => order.id));
      notify.success(t.notify.deletedMany(targets.length));
    } catch (error) {
      notify.apiError(error, fr.errors.deleteFailed);
      throw error;
    }
  };

  const editable = canWrite ? isEditable : () => false;

  // Colonnes mémorisées : une nouvelle définition à chaque rendu remonterait toutes les cellules (menus, édition).
  const columns = useMemo<ColumnDef<Order, unknown>[]>(
    () => [
      {
        id: "station",
        header: t.columns.station,
        accessorFn: (order) => `${order.station_code} ${order.station_name}`,
        cell: ({ row }) => (
          <span className="flex items-baseline gap-2">
            <span className="num text-xs text-muted-foreground">{row.original.station_code}</span>
            <span className="truncate">{row.original.station_name}</span>
          </span>
        ),
      },
      {
        id: "product",
        header: t.columns.product,
        accessorFn: (order) => order.product_label,
        meta: { className: "w-36" },
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block size-2 shrink-0 rounded-full"
              style={{
                backgroundColor:
                  productList.find((product) => product.id === row.original.product_id)?.color ??
                  "currentColor",
              }}
              aria-hidden
            />
            {row.original.product_label}
          </span>
        ),
      },
      {
        accessorKey: "requested_l",
        header: t.columns.volume,
        meta: {
          align: "right",
          className: "w-36",
          edit: {
            type: "number",
            enabled: editable,
            validate: (value) => (typeof value === "number" && value > 0 ? undefined : t.volumePositive),
            onCommit: (order, value) => patch(order, { requested_l: value as number }),
          },
        },
        cell: ({ row }) => <span className="num">{formatLiters(row.original.requested_l)}</span>,
      },
      {
        accessorKey: "priority",
        header: t.columns.priority,
        meta: {
          className: "w-24",
          edit: {
            type: "select",
            options: priorityOptions,
            enabled: editable,
            onCommit: (order, value) => patch(order, { priority: value as Order["priority"] }),
          },
        },
        cell: ({ row }) => <StatusBadge kind="priority" value={row.original.priority} />,
      },
      {
        accessorKey: "window_start",
        header: t.columns.windowStart,
        meta: {
          className: "w-28",
          align: "center",
          edit: {
            type: "text",
            enabled: editable,
            validate: validateTime,
            onCommit: (order, value) =>
              patch(order, { window_start: value === null ? null : normalizeTime(String(value)) }),
          },
        },
        cell: ({ row }) => <span className="num">{row.original.window_start ?? EMPTY}</span>,
      },
      {
        accessorKey: "window_end",
        header: t.columns.windowEnd,
        meta: {
          className: "w-28",
          align: "center",
          edit: {
            type: "text",
            enabled: editable,
            validate: validateTime,
            onCommit: (order, value) =>
              patch(order, { window_end: value === null ? null : normalizeTime(String(value)) }),
          },
        },
        cell: ({ row }) => <span className="num">{row.original.window_end ?? EMPTY}</span>,
      },
      {
        accessorKey: "comment",
        header: t.columns.comment,
        enableSorting: false,
        meta: {
          edit: {
            type: "text",
            enabled: editable,
            onCommit: (order, value) => patch(order, { comment: value === null ? null : String(value) }),
          },
        },
        cell: ({ row }) =>
          row.original.comment ? (
            <span title={row.original.comment}>{row.original.comment}</span>
          ) : (
            <span className="text-muted-foreground">{EMPTY}</span>
          ),
      },
      {
        accessorKey: "status",
        header: t.columns.status,
        meta: { className: "w-36" },
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            <StatusBadge kind="order" value={row.original.status} />
            {row.original.warnings.length > 0 && (
              <Tip label={row.original.warnings.map((warning) => warning.message).join(" ")}>
                <span
                  tabIndex={-1}
                  data-testid="order-warning"
                  aria-label={`${t.warnings.one} : ${row.original.warnings
                    .map((warning) => warning.message)
                    .join(" ")}`}
                  className="inline-flex text-warning"
                >
                  <TriangleAlert className="size-3.5" aria-hidden />
                </span>
              </Tip>
            )}
          </span>
        ),
      },
      {
        id: "__actions",
        enableSorting: false,
        header: () => <span className="sr-only">{fr.common.actions}</span>,
        meta: { className: "w-9", label: fr.common.actions, align: "right" },
        cell: ({ row }) => {
          const order = row.original;
          const open = { onSelect: () => setEditing({ order }) };
          return (
            <RowActions
              label={t.actions.rowLabel(orderLabel(order))}
              items={
                !canWrite || !isEditable(order)
                  ? [{ label: t.actions.details, icon: <Eye />, ...open }]
                  : [
                      { label: t.actions.edit, icon: <Pencil />, ...open },
                      ...(order.status === "draft"
                        ? [
                            {
                              label: t.actions.confirm,
                              icon: <Check />,
                              onSelect: () => void confirmOne(order),
                            },
                          ]
                        : []),
                      "separator" as const,
                      {
                        label: t.actions.postpone,
                        icon: <CalendarClock />,
                        onSelect: () => void transition(order, "postpone"),
                      },
                      {
                        label: t.actions.cancel,
                        icon: <Ban />,
                        destructive: true,
                        onSelect: () => void transition(order, "cancel"),
                      },
                      ...(order.status === "draft"
                        ? [
                            {
                              label: t.actions.delete,
                              icon: <Trash2 />,
                              destructive: true,
                              onSelect: () => void deleteOne(order),
                            },
                          ]
                        : []),
                    ]
              }
            />
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canWrite, productList],
  );

  const stationOptions = stationList.map((station) => ({
    value: station.id,
    label: `${station.code} — ${station.name}`,
  }));
  const productOptions = productList.map((product) => ({ value: product.id, label: product.label }));
  const refusalMax = refusal ? capacityMax(refusal.error) : null;

  return (
    <div className="flex h-full flex-col gap-3 p-4" data-testid="screen-orders">
      <PageHeader title={fr.nav.screens.orders} subtitle={t.subtitle(formatDateLong(day))} />
      {!canWrite && (
        <Notice tone="neutral" icon={<Lock className="size-3.5" />}>
          {t.readOnly}
        </Notice>
      )}
      {refusal && (
        <Notice
          tone="blocking"
          icon={<CircleAlert className="size-3.5 shrink-0" />}
          action={
            <span className="flex items-center gap-1">
              <Button size="sm" variant="outline" onClick={() => setEditing({ order: refusal.order })}>
                <Pencil />
                {t.refusal.edit}
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t.refusal.dismiss}
                onClick={() => setRefusal(null)}
              >
                <X />
              </Button>
            </span>
          }
        >
          <strong className="font-semibold">
            {refusal.kind === "confirm" ? t.refusal.title : t.refusal.updateTitle}
            {" — "}
            {refusal.order.station_name} · {refusal.order.product_label}
          </strong>
          {" : "}
          {refusal.error.message} {refusalMax !== null && t.refusal.max(formatLiters(refusalMax))}{" "}
          {t.refusal.hint}
        </Notice>
      )}
      {warned > 0 && (
        <Notice tone="warning" icon={<TriangleAlert className="size-3.5 shrink-0" />}>
          {t.warnings.banner(warned)}
        </Notice>
      )}

      <DataTable<Order>
        caption={t.caption}
        columns={columns}
        data={rows}
        state={state}
        onStateChange={setState}
        getRowId={(order) => order.id}
        loading={list.isLoading}
        fetching={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        searchable
        searchPlaceholder={t.searchPlaceholder}
        filters={[
          { id: "station_id", label: t.filters.station, options: stationOptions },
          { id: "product_id", label: t.filters.product, options: productOptions },
          { id: "status", label: t.filters.status, options: statusOptions },
          {
            id: "priority",
            label: t.filters.priority,
            options: ORDER_PRIORITIES.map((value) => ({ value, label: fr.status.priority[value] })),
          },
        ]}
        selectable={canWrite}
        bulkActions={
          canWrite
            ? [
                { label: t.actions.confirmSelection, icon: <CheckCheck />, onClick: confirmMany },
                { label: t.actions.deleteDrafts, icon: <Trash2 />, destructive: true, onClick: deleteDrafts },
              ]
            : []
        }
        onRowActivate={(order) => setEditing({ order })}
        empty={canWrite ? `${t.empty} ${t.emptyHint}` : t.empty}
        className="min-h-0 flex-1"
        toolbar={
          canWrite && (
            <>
              {drafts.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void confirmAllDrafts()}
                  disabled={mutations.confirmMany.isPending}
                >
                  <CheckCheck />
                  {t.actions.confirmAllDrafts(drafts.length)}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
                <FileUp />
                {t.actions.import}
              </Button>
              <Button size="sm" onClick={() => setEditing({ order: null })}>
                <Plus />
                {t.actions.new}
              </Button>
            </>
          )
        }
      />

      <Totals orders={rows} products={productList} />

      <OrderFormDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        order={editing?.order ?? null}
        day={day}
        stations={stationList}
        products={productList}
        canWrite={canWrite}
        onSave={save}
      />
      <BulkConfirmDialog report={report} onClose={() => setReport(null)} />
      {canWrite && (
        <ImportDialog
          kind="orders"
          fields={{ day }}
          open={importOpen}
          onOpenChange={setImportOpen}
          onApplied={() => {
            void mutations.invalidate();
            notify.success(t.notify.imported);
          }}
        />
      )}
    </div>
  );
}
