/** Onglet « Camions » (F2.2) : affectabilité du jour (RM-04), marquer / démarquer indisponible avec motif. */
import type { ColumnDef } from "@tanstack/react-table";
import { CalendarCheck, CalendarX, Pencil, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";

import { DataTable, RowActions, useDataTableState } from "@/components/DataTable";
import { notify } from "@/components/notify";
import { Notice } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { fr } from "@/i18n/fr";
import { EMPTY, formatLiters } from "@/lib/format";
import { TRUCK_STATUSES } from "@/lib/types";

import { useSaveTrucks, useTruckDays, type TruckDay } from "./api";
import {
  assignableOptions,
  AssignabilityCell,
  DayBadge,
  dayOptions,
  MarkUnavailableDialog,
  nameList,
} from "./shared";

const t = fr.screens.availability.trucks;
const r = fr.screens.availability.resource;
const NONE: never[] = [];

export function TrucksTab({ day, canWrite }: { day: string; canWrite: boolean }) {
  const list = useTruckDays(day);
  const save = useSaveTrucks(day);
  const [state, setState] = useDataTableState({ pageSize: 100, sorting: [{ id: "plate", desc: false }] });
  const [marking, setMarking] = useState<TruckDay[] | null>(null);
  // Sélection pilotée : une action en masse qui passe par la boîte de motif la vide une fois enregistrée.
  const [selected, setSelected] = useState<string[]>([]);
  const [fromSelection, setFromSelection] = useState(false);
  const rows = list.data ?? NONE;

  const setAvailability = async (trucks: TruckDay[], available: boolean, reason: string | null = null) => {
    try {
      await save.mutateAsync(trucks.map((truck) => ({ truck_id: truck.truck_id, available, reason })));
      notify.success(available ? t.unmarked(trucks.length) : t.marked(trucks.length));
    } catch (error) {
      notify.apiError(error, r.saveFailed);
      throw error;
    }
  };

  const columns = useMemo<ColumnDef<TruckDay, unknown>[]>(
    () => [
      {
        accessorKey: "plate",
        header: t.plate,
        meta: { className: "w-32" },
        cell: ({ row }) => <span className="num font-medium">{row.original.plate}</span>,
      },
      {
        id: "assignable",
        header: r.assignability,
        accessorFn: (truck) => String(truck.assignable),
        cell: ({ row }) => (
          <AssignabilityCell
            assignable={row.original.assignable}
            reason={row.original.block_reason}
            ruleCode={row.original.rule_code}
          />
        ),
      },
      {
        id: "available_today",
        header: r.dayColumn,
        accessorFn: (truck) => String(truck.available_today),
        meta: {
          edit: canWrite
            ? {
                type: "select",
                options: dayOptions,
                onCommit: (truck, value) => setAvailability([truck], value === "true", truck.day_reason),
              }
            : undefined,
        },
        cell: ({ row }) => (
          <DayBadge available={row.original.available_today} reason={row.original.day_reason} />
        ),
      },
      {
        accessorKey: "driver_name",
        header: t.driver,
        cell: ({ row }) =>
          row.original.driver_name ? (
            <span className="flex items-baseline gap-1.5">
              {row.original.driver_name}
              <span className="text-xs text-muted-foreground">
                {row.original.assignment_source === "daily" ? r.daily : r.usual}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">{t.noDriver}</span>
          ),
      },
      {
        accessorKey: "status",
        header: t.status,
        meta: { className: "w-28" },
        cell: ({ row }) => <StatusBadge kind="truck" value={row.original.status} />,
      },
      {
        accessorKey: "total_capacity_l",
        header: t.sizeCapacity,
        meta: { className: "w-40" },
        cell: ({ row }) => (
          <span className="flex items-baseline gap-1.5">
            {fr.status.size[row.original.size]}
            <span className="num text-xs text-muted-foreground">
              {formatLiters(row.original.total_capacity_l)}
            </span>
          </span>
        ),
      },
      {
        accessorKey: "carrier_name",
        header: t.carrier,
        cell: ({ row }) => row.original.carrier_name ?? EMPTY,
      },
      ...(canWrite
        ? [
            {
              id: "__actions",
              enableSorting: false,
              header: () => <span className="sr-only">{fr.common.actions}</span>,
              meta: { className: "w-9", label: fr.common.actions, align: "right" },
              cell: ({ row }) => (
                <RowActions
                  label={r.rowLabel(row.original.plate)}
                  items={[
                    row.original.available_today
                      ? {
                          label: r.mark,
                          icon: <CalendarX />,
                          onSelect: () => {
                            setFromSelection(false);
                            setMarking([row.original]);
                          },
                        }
                      : {
                          label: r.editReason,
                          icon: <Pencil />,
                          onSelect: () => {
                            setFromSelection(false);
                            setMarking([row.original]);
                          },
                        },
                    ...(row.original.available_today
                      ? []
                      : [
                          {
                            label: r.unmark,
                            icon: <CalendarCheck />,
                            onSelect: () => void setAvailability([row.original], true).catch(() => undefined),
                          },
                        ]),
                  ]}
                />
              ),
            } satisfies ColumnDef<TruckDay, unknown>,
          ]
        : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canWrite],
  );

  const assignable = rows.filter((truck) => truck.assignable).length;
  const blocked = rows.length - assignable;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2" data-testid="trucks-tab">
      {blocked > 0 && (
        <Notice tone="warning" icon={<TriangleAlert className="size-3.5 shrink-0" />}>
          <strong className="font-semibold">{t.blockedNotice(blocked)}</strong>
          {" — "}
          {nameList(rows.filter((truck) => !truck.assignable).map((truck) => truck.plate))}
        </Notice>
      )}
      <DataTable<TruckDay>
        caption={t.caption}
        columns={columns}
        data={rows}
        state={state}
        onStateChange={setState}
        getRowId={(truck) => truck.truck_id}
        loading={list.isLoading}
        fetching={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        searchable
        filters={[
          { id: "assignable", label: r.filterAssignable, options: assignableOptions },
          {
            id: "status",
            label: t.status,
            options: TRUCK_STATUSES.map((value) => ({ value, label: fr.status.truck[value] })),
          },
        ]}
        selectable={canWrite}
        selectedRowIds={selected}
        onSelectionChange={(ids) => setSelected(ids)}
        bulkActions={
          canWrite
            ? [
                {
                  label: r.markSelection,
                  icon: <CalendarX />,
                  onClick: (selection) => {
                    setFromSelection(true);
                    setMarking(selection);
                    // La sélection reste en place tant que le motif n'est pas enregistré (boîte annulable).
                    throw new Error("motif demandé");
                  },
                },
                {
                  label: r.unmarkSelection,
                  icon: <CalendarCheck />,
                  onClick: (selection) => setAvailability(selection, true),
                },
              ]
            : []
        }
        empty={t.empty}
        className="min-h-0 flex-1"
        toolbar={
          rows.length > 0 && (
            <span className="num text-xs text-muted-foreground" data-testid="trucks-summary">
              {t.summary(assignable, rows.length)}
            </span>
          )
        }
      />
      <MarkUnavailableDialog
        target={
          marking
            ? {
                labels: marking.map((truck) => truck.plate),
                reason: marking.length === 1 ? marking[0].day_reason : null,
              }
            : null
        }
        onClose={() => setMarking(null)}
        onSubmit={async (reason) => {
          await setAvailability(marking ?? [], false, reason);
          if (fromSelection) setSelected([]);
        }}
      />
    </div>
  );
}
