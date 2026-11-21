import type { ColumnDef } from "@tanstack/react-table";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { useWatch, type Control } from "react-hook-form";
import { useMemo } from "react";
import { z } from "zod";

import {
  DateField,
  FieldRow,
  FormSection,
  SelectField,
  SwitchField,
  TextField,
  zOptionalDay,
  zOptionalText,
  zText,
} from "@/components/forms";
import { Notice } from "@/components/PageHeader";
import { ExpiryBadge, StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { fr } from "@/i18n/fr";
import { EXPIRY_WARNING_DAYS } from "@/lib/config";
import { EMPTY } from "@/lib/format";
import { DRIVER_STATUSES, type Driver, type DriverStatus } from "@/lib/types";

import { CrudTab } from "./CrudTab";
import { useDriverDocumentIssues } from "./driverAlerts";
import { carriers, drivers, trucks } from "./resources";
import { Mono, options } from "./shared";

/** Liste vide stable (évite de recréer les colonnes tant que les données chargent). */
const NONE: never[] = [];

const t = fr.referentials.drivers;

const schema = z
  .object({
    full_name: zText(160),
    phone: zOptionalText(40),
    license_no: zOptionalText(64),
    license_expiry: zOptionalDay,
    hazmat_cert: z.boolean(),
    hazmat_expiry: zOptionalDay,
    carrier_id: z.string().nullable(),
    status: z.enum(DRIVER_STATUSES),
    default_truck_id: z.string().nullable(),
  })
  // Sans habilitation, pas de date d'expiration à conserver.
  .transform((values) => (values.hazmat_cert ? values : { ...values, hazmat_expiry: null }));

function HazmatExpiry({ control }: { control: Control<z.input<typeof schema>> }) {
  const certified = useWatch({ control, name: "hazmat_cert" });
  return <DateField name="hazmat_expiry" label={t.hazmatExpiry} disabled={!certified} required={false} />;
}

export function DriversTab({ canWrite }: { canWrite: boolean }) {
  const carrierList = carriers.useAll().data ?? NONE;
  const truckList = trucks.useAll().data ?? NONE;
  const update = drivers.useUpdate();
  const { issues } = useDriverDocumentIssues();
  const carrierOptions = carrierList.map((carrier) => ({ value: carrier.id, label: carrier.name }));

  // Colonnes mémorisées : une nouvelle définition à chaque rendu remonterait toutes les cellules (menus, édition).
  const columns = useMemo<ColumnDef<Driver, unknown>[]>(
    () => [
      { accessorKey: "full_name", header: t.fullName },
      {
        accessorKey: "phone",
        header: t.phone,
        enableSorting: false,
        meta: { className: "w-40" },
        cell: ({ row }) => <Mono>{row.original.phone ?? EMPTY}</Mono>,
      },
      {
        accessorKey: "license_no",
        header: t.licenseNo,
        meta: { className: "w-28" },
        cell: ({ row }) => <Mono>{row.original.license_no ?? EMPTY}</Mono>,
      },
      {
        accessorKey: "license_expiry",
        header: t.licenseShort,
        meta: { label: t.licenseExpiry },
        cell: ({ row }) => <ExpiryBadge date={row.original.license_expiry} />,
      },
      {
        accessorKey: "hazmat_expiry",
        header: t.hazmatShort,
        meta: { label: t.hazmatExpiry },
        cell: ({ row }) =>
          row.original.hazmat_cert ? (
            <ExpiryBadge date={row.original.hazmat_expiry} />
          ) : (
            <Badge tone="blocking" data-expiry="none">
              <CircleAlert className="size-3" aria-hidden />
              {t.hazmatNone}
            </Badge>
          ),
      },
      {
        accessorKey: "carrier_name",
        header: t.carrier,
        cell: ({ row }) => row.original.carrier_name ?? EMPTY,
      },
      {
        accessorKey: "default_truck_plate",
        header: t.defaultTruck,
        enableSorting: false,
        meta: { className: "w-32" },
        cell: ({ row }) => <Mono>{row.original.default_truck_plate ?? EMPTY}</Mono>,
      },
      {
        accessorKey: "status",
        header: t.status,
        meta: {
          className: "w-28",
          edit: canWrite
            ? {
                type: "select",
                options: options.driverStatus,
                onCommit: (row, value) =>
                  update.mutateAsync({
                    id: row.id,
                    input: { status: value as DriverStatus },
                  }),
              }
            : undefined,
        },
        cell: ({ row }) => <StatusBadge kind="driver" value={row.original.status} />,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canWrite],
  );

  return (
    <CrudTab
      resource={drivers}
      caption={fr.referentials.tabs.drivers}
      texts={t}
      columns={columns}
      rowLabel={(row) => row.full_name}
      canWrite={canWrite}
      schema={schema}
      importKind="drivers"
      filters={[
        { id: "status", label: t.status, options: options.driverStatus },
        { id: "carrier_id", label: t.carrier, options: carrierOptions },
      ]}
      initialState={{ sorting: [{ id: "license_expiry", desc: false }] }}
      toForm={(row) => ({
        full_name: row?.full_name ?? "",
        phone: row?.phone ?? "",
        license_no: row?.license_no ?? "",
        license_expiry: row?.license_expiry ?? null,
        hazmat_cert: row?.hazmat_cert ?? true,
        hazmat_expiry: row?.hazmat_expiry ?? null,
        carrier_id: row?.carrier_id ?? null,
        status: row?.status ?? "available",
        default_truck_id: row?.default_truck_id ?? null,
      })}
      layout={(table) => (
        <div className="flex h-full min-h-0 flex-col gap-2">
          {issues.expired.length > 0 && (
            <Notice tone="blocking" icon={<CircleAlert className="size-3.5 shrink-0" />}>
              <strong className="font-semibold">{t.alertExpired(issues.expired.length)}</strong>
              {" — "}
              {issues.expired.map((driver) => driver.full_name).join(", ")}. {t.alertHint}
            </Notice>
          )}
          {issues.soon.length > 0 && (
            <Notice tone="warning" icon={<TriangleAlert className="size-3.5 shrink-0" />}>
              <strong className="font-semibold">
                {t.alertSoon(issues.soon.length, EXPIRY_WARNING_DAYS)}
              </strong>
              {" — "}
              {issues.soon.map((driver) => driver.full_name).join(", ")}
            </Notice>
          )}
          <div className="min-h-0 flex-1">{table}</div>
        </div>
      )}
      renderForm={(form) => {
        const carrierId = form.watch("carrier_id");
        const truckOptions = truckList
          .filter(
            (truck) =>
              !carrierId || truck.carrier_id === carrierId || truck.id === form.getValues("default_truck_id"),
          )
          .map((truck) => ({ value: truck.id, label: `${truck.plate} — ${fr.status.size[truck.size]}` }));
        return (
          <>
            <FormSection title={t.sections.identity}>
              <FieldRow>
                <TextField name="full_name" label={t.fullName} required autoFocus />
                <TextField name="phone" label={t.phone} required={false} type="tel" mono />
              </FieldRow>
            </FormSection>
            <FormSection title={t.sections.documents}>
              <FieldRow>
                <TextField name="license_no" label={t.licenseNo} required={false} mono uppercase />
                <DateField name="license_expiry" label={t.licenseExpiry} required={false} />
              </FieldRow>
              <FieldRow>
                <SwitchField name="hazmat_cert" label={t.hazmat} className="self-end pb-1.5" />
                <HazmatExpiry control={form.control} />
              </FieldRow>
            </FormSection>
            <FormSection title={t.sections.assignment}>
              <FieldRow cols={3}>
                <SelectField name="status" label={t.status} options={options.driverStatus} required />
                <SelectField
                  name="carrier_id"
                  label={t.carrier}
                  options={carrierOptions}
                  emptyLabel={fr.referentials.trucks.noCarrier}
                />
                <SelectField
                  name="default_truck_id"
                  label={t.defaultTruck}
                  options={truckOptions}
                  emptyLabel={t.noTruck}
                />
              </FieldRow>
            </FormSection>
          </>
        );
      }}
    />
  );
}
