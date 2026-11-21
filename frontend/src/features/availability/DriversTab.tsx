/**
 * Onglet « Chauffeurs » (F2.3, F2.4) : blocage RM-03 mis en évidence, marquage du jour,
 * affectation chauffeur ↔ camion du jour modifiable (conflit 409 résolu par une réaffectation confirmée).
 */
import type { ColumnDef } from "@tanstack/react-table";
import { CalendarCheck, CalendarX, Pencil, CircleAlert, Unlink } from "lucide-react";
import { useMemo, useState } from "react";

import { useConfirm } from "@/components/ConfirmDialog";
import { DataTable, RowActions, useDataTableState } from "@/components/DataTable";
import { notify } from "@/components/notify";
import { Notice } from "@/components/PageHeader";
import { ExpiryBadge, StatusBadge } from "@/components/StatusBadge";
import { fr } from "@/i18n/fr";
import { isApiError } from "@/lib/api/errors";
import { EMPTY } from "@/lib/format";
import { DRIVER_STATUSES } from "@/lib/types";

import { useDriverDays, useSaveDrivers, useTruckDays, type DriverDay } from "./api";
import { assignableOptions, AssignabilityCell, DayBadge, dayOptions, MarkUnavailableDialog } from "./shared";

const t = fr.screens.availability.drivers;
const r = fr.screens.availability.resource;
const NONE: never[] = [];

export function DriversTab({ day, canWrite }: { day: string; canWrite: boolean }) {
  const list = useDriverDays(day);
  const trucks = useTruckDays(day).data ?? NONE;
  const save = useSaveDrivers(day);
  const confirm = useConfirm();
  const [state, setState] = useDataTableState({ pageSize: 100, sorting: [{ id: "full_name", desc: false }] });
  const [marking, setMarking] = useState<DriverDay[] | null>(null);
  const rows = list.data ?? NONE;

  const setAvailability = async (drivers: DriverDay[], available: boolean, reason: string | null = null) => {
    try {
      await save.mutateAsync(drivers.map((driver) => ({ driver_id: driver.driver_id, available, reason })));
      notify.success(available ? t.unmarked(drivers.length) : t.marked(drivers.length));
    } catch (error) {
      notify.apiError(error, r.saveFailed);
      throw error;
    }
  };

  /**
   * Affectation du jour (`truckId` nul = retour au camion habituel). Si le camion est déjà affecté à un autre
   * chauffeur (409 `truck_already_assigned`), on propose de le lui retirer dans la même saisie.
   */
  const assignTruck = async (driver: DriverDay, truckId: string | null) => {
    const plate = trucks.find((truck) => truck.truck_id === truckId)?.plate ?? "";
    try {
      await save.mutateAsync([{ driver_id: driver.driver_id, truck_id: truckId }]);
      notify.success(truckId ? t.assigned(driver.full_name, plate) : t.unassigned(driver.full_name));
    } catch (error) {
      if (!isApiError(error) || error.code !== "truck_already_assigned" || !truckId) throw error;
      const otherId = error.details.find((detail) => typeof detail.driver_id === "string")?.driver_id as
        string | undefined;
      const other = rows.find((candidate) => candidate.driver_id === otherId);
      if (!otherId || !other) throw error;
      const ok = await confirm({
        title: t.conflictTitle,
        description: `${error.message} ${t.conflictBody(plate, other.full_name, driver.full_name)}`,
        confirmLabel: t.conflictAction,
        cancelLabel: t.conflictKeep,
      });
      if (!ok) return;
      await save.mutateAsync([
        { driver_id: otherId, truck_id: null },
        { driver_id: driver.driver_id, truck_id: truckId },
      ]);
      notify.success(t.reassigned(plate, driver.full_name, other.full_name));
    }
  };

  const truckOptions = useMemo(
    () => [
      { value: "", label: t.usualTruck },
      ...[...trucks]
        .sort((a, b) => a.plate.localeCompare(b.plate, "fr"))
        .map((truck) => ({
          value: truck.truck_id,
          label:
            t.truckOption(truck.plate, fr.status.size[truck.size]) +
            (truck.assignable ? "" : ` (${t.truckNotAssignable})`),
        })),
    ],
    [trucks],
  );

  const columns = useMemo<ColumnDef<DriverDay, unknown>[]>(
    () => [
      {
        accessorKey: "full_name",
        header: t.name,
        cell: ({ row }) => <span className="font-medium">{row.original.full_name}</span>,
      },
      {
        id: "assignable",
        header: r.assignability,
        accessorFn: (driver) => String(driver.assignable),
        cell: ({ row }) => (
          <AssignabilityCell
            assignable={row.original.assignable}
            reason={row.original.block_reason}
            ruleCode={row.original.rule_code}
            blocking={row.original.rule_code === "RM-03"}
          />
        ),
      },
      {
        accessorKey: "truck_id",
        header: t.truck,
        sortingFn: (a, b) => (a.original.truck_plate ?? "").localeCompare(b.original.truck_plate ?? "", "fr"),
        meta: {
          className: "w-44",
          edit: canWrite
            ? {
                type: "select",
                options: truckOptions,
                // Seule une affectation du jour est une valeur saisie ; le camion habituel est la valeur par défaut.
                getValue: (driver) => (driver.assignment_source === "daily" ? driver.truck_id : null),
                onCommit: (driver, value) => assignTruck(driver, value === null ? null : String(value)),
              }
            : undefined,
        },
        cell: ({ row }) =>
          row.original.truck_plate ? (
            <span className="flex items-baseline gap-1.5">
              <span className="num font-medium">{row.original.truck_plate}</span>
              <span className="text-xs text-muted-foreground">
                {row.original.assignment_source === "daily" ? r.daily : r.usual}
              </span>
            </span>
          ) : (
            <span
              className={row.original.assignable ? "text-xs text-warning" : "text-xs text-muted-foreground"}
            >
              {t.noTruck}
            </span>
          ),
      },
      {
        id: "available_today",
        header: r.dayColumn,
        accessorFn: (driver) => String(driver.available_today),
        meta: {
          edit: canWrite
            ? {
                type: "select",
                options: dayOptions,
                onCommit: (driver, value) => setAvailability([driver], value === "true", driver.day_reason),
              }
            : undefined,
        },
        cell: ({ row }) => (
          <DayBadge available={row.original.available_today} reason={row.original.day_reason} />
        ),
      },
      {
        accessorKey: "status",
        header: t.status,
        meta: { className: "w-24" },
        cell: ({ row }) => <StatusBadge kind="driver" value={row.original.status} />,
      },
      {
        accessorKey: "license_expiry",
        header: t.license,
        cell: ({ row }) => <ExpiryBadge date={row.original.license_expiry} today={day} />,
      },
      {
        accessorKey: "hazmat_expiry",
        header: t.hazmat,
        cell: ({ row }) =>
          row.original.hazmat_cert ? (
            <ExpiryBadge date={row.original.hazmat_expiry} today={day} />
          ) : (
            <span className="text-xs text-muted-foreground">{t.noHazmat}</span>
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
                  label={r.rowLabel(row.original.full_name)}
                  items={[
                    row.original.available_today
                      ? { label: r.mark, icon: <CalendarX />, onSelect: () => setMarking([row.original]) }
                      : { label: r.editReason, icon: <Pencil />, onSelect: () => setMarking([row.original]) },
                    ...(row.original.available_today
                      ? []
                      : [
                          {
                            label: r.unmark,
                            icon: <CalendarCheck />,
                            onSelect: () => void setAvailability([row.original], true).catch(() => undefined),
                          },
                        ]),
                    ...(row.original.assignment_source === "daily"
                      ? [
                          {
                            label: t.removeAssignment,
                            icon: <Unlink />,
                            onSelect: () =>
                              void assignTruck(row.original, null).catch((error: unknown) =>
                                notify.apiError(error, r.saveFailed),
                              ),
                          },
                        ]
                      : []),
                  ]}
                />
              ),
            } satisfies ColumnDef<DriverDay, unknown>,
          ]
        : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canWrite, day, truckOptions, rows],
  );

  const assignable = rows.filter((driver) => driver.assignable).length;
  const rm03 = rows.filter((driver) => driver.rule_code === "RM-03");

  return (
    <div className="flex h-full min-h-0 flex-col gap-2" data-testid="drivers-tab">
      {rm03.length > 0 && (
        <Notice tone="blocking" icon={<CircleAlert className="size-3.5 shrink-0" />}>
          <strong className="font-semibold">{t.rm03Notice(rm03.length)}</strong>
          {" — "}
          {rm03.map((driver) => driver.full_name).join(", ")}. {t.rm03Hint}
        </Notice>
      )}
      <DataTable<DriverDay>
        caption={t.caption}
        columns={columns}
        data={rows}
        state={state}
        onStateChange={setState}
        getRowId={(driver) => driver.driver_id}
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
            options: DRIVER_STATUSES.map((value) => ({ value, label: fr.status.driver[value] })),
          },
        ]}
        selectable={canWrite}
        bulkActions={
          canWrite
            ? [
                {
                  label: r.markSelection,
                  icon: <CalendarX />,
                  onClick: (selection) => {
                    setMarking(selection);
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
        rowClassName={(driver) => (driver.rule_code === "RM-03" ? "bg-blocking-soft/60" : undefined)}
        empty={t.empty}
        className="min-h-0 flex-1"
        toolbar={
          rows.length > 0 && (
            <span className="num text-xs text-muted-foreground" data-testid="drivers-summary">
              {t.summary(assignable, rows.length)}
            </span>
          )
        }
      />
      <MarkUnavailableDialog
        target={
          marking
            ? {
                labels: marking.map((driver) => driver.full_name),
                reason: marking.length === 1 ? marking[0].day_reason : null,
              }
            : null
        }
        onClose={() => setMarking(null)}
        onSubmit={(reason) => setAvailability(marking ?? [], false, reason)}
      />
    </div>
  );
}
