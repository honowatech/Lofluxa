import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import { z } from "zod";

import {
  CoordinatesField,
  FieldRow,
  FormSection,
  NumberField,
  OpeningHoursField,
  SelectField,
  summarizeOpeningHours,
  SwitchField,
  TextAreaField,
  TextField,
  zLat,
  zLon,
  zOpeningHours,
  zOptionalNumber,
  zOptionalText,
  zCode,
  zText,
} from "@/components/forms";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { fr } from "@/i18n/fr";
import { EMPTY } from "@/lib/format";
import { DEPOT_OPERATORS, type Depot } from "@/lib/types";

import { CrudTab } from "./CrudTab";
import { depots } from "./resources";
import { Mono, Muted, options, TableWithMap } from "./shared";

const t = fr.referentials.depots;
const s = fr.referentials.stations.sections;

const schema = z.object({
  code: zCode(32),
  name: zText(160),
  operator: z.enum(DEPOT_OPERATORS),
  lat: zLat,
  lon: zLon,
  address: zOptionalText(500),
  opening_hours: zOpeningHours,
  avg_wait_min: zOptionalNumber({ min: 0, max: 1440, integer: true }),
  max_loadings_per_truck_day: zOptionalNumber({ min: 1, max: 50, integer: true }),
  active: z.boolean(),
});

const columns: ColumnDef<Depot, unknown>[] = [
  {
    accessorKey: "code",
    header: t.code,
    meta: { className: "w-28" },
    cell: ({ row }) => <Mono>{row.original.code}</Mono>,
  },
  { accessorKey: "name", header: t.name },
  {
    accessorKey: "operator",
    header: t.operator,
    meta: { className: "w-24" },
    cell: ({ row }) => <Badge>{fr.status.operator[row.original.operator]}</Badge>,
  },
  {
    accessorKey: "opening_hours",
    header: t.hours,
    enableSorting: false,
    meta: { className: "max-w-52" },
    cell: ({ row }) => (
      <span className="text-xs" title={summarizeOpeningHours(row.original.opening_hours)}>
        {summarizeOpeningHours(row.original.opening_hours)}
      </span>
    ),
  },
  {
    accessorKey: "avg_wait_min",
    header: `${t.avgWait} (${t.avgWaitUnit})`,
    meta: { align: "right", className: "w-36" },
    cell: ({ row }) =>
      row.original.avg_wait_min === null ? (
        <Muted>{fr.common.default}</Muted>
      ) : (
        <Mono>{row.original.avg_wait_min}</Mono>
      ),
  },
  {
    accessorKey: "max_loadings_per_truck_day",
    header: t.maxLoadingsShort,
    meta: { align: "right", className: "w-24", label: t.maxLoadings },
    cell: ({ row }) =>
      row.original.max_loadings_per_truck_day === null ? (
        <Muted>{fr.common.default}</Muted>
      ) : (
        <Mono>{row.original.max_loadings_per_truck_day}</Mono>
      ),
  },
  {
    accessorKey: "active",
    header: t.active,
    meta: { className: "w-20" },
    cell: ({ row }) => <StatusBadge kind="active" value={row.original.active} />,
  },
];

export function DepotsTab({ canWrite }: { canWrite: boolean }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <CrudTab
      resource={depots}
      caption={fr.referentials.tabs.depots}
      texts={t}
      columns={columns}
      rowLabel={(row) => row.name}
      canWrite={canWrite}
      schema={schema}
      importKind="depots"
      filters={[
        { id: "operator", label: t.operator, options: options.operator },
        { id: "active", label: fr.administration.users.status, options: options.active },
      ]}
      initialState={{ sorting: [{ id: "code", desc: false }] }}
      highlightedRowId={selectedId}
      onRowFocus={(row) => setSelectedId(row?.id ?? null)}
      toForm={(row) => ({
        code: row?.code ?? "",
        name: row?.name ?? "",
        operator: row?.operator ?? "scdp",
        lat: row?.lat ?? null,
        lon: row?.lon ?? null,
        address: row?.address ?? "",
        opening_hours: row?.opening_hours ?? {},
        avg_wait_min: row?.avg_wait_min ?? null,
        max_loadings_per_truck_day: row?.max_loadings_per_truck_day ?? null,
        active: row?.active ?? true,
      })}
      layout={(table, rows) => (
        <TableWithMap
          table={table}
          label={fr.referentials.tabs.depots}
          selectedId={selectedId}
          onSelect={setSelectedId}
          points={rows.map((row) => ({
            id: row.id,
            kind: "depot",
            lat: row.lat,
            lon: row.lon,
            label: row.name,
            inactive: !row.active,
            detail: [row.code, fr.status.operator[row.operator], row.address ?? EMPTY],
          }))}
        />
      )}
      renderForm={(form) => (
        <>
          <FormSection title={s.identity}>
            <FieldRow cols={3}>
              <TextField name="code" label={t.code} required mono uppercase autoFocus />
              <TextField name="name" label={t.name} required className="sm:col-span-2" />
            </FieldRow>
            <FieldRow>
              <SelectField name="operator" label={t.operator} options={options.operator} required />
              <SwitchField name="active" label={t.active} className="self-end pb-1.5" />
            </FieldRow>
          </FormSection>
          <FormSection title={s.location}>
            <CoordinatesField latName="lat" lonName="lon" kind="depot" pointLabel={form.watch("name")} />
            <TextAreaField name="address" label={t.address} required={false} rows={2} />
          </FormSection>
          <FormSection title={fr.referentials.tabs.depots + " — " + t.hours.toLowerCase()}>
            <OpeningHoursField name="opening_hours" label={t.hours} />
            <FieldRow>
              <NumberField
                name="avg_wait_min"
                label={t.avgWait}
                unit={t.avgWaitUnit}
                required={false}
                hint={fr.fields.defaultHintGeneric}
              />
              <NumberField
                name="max_loadings_per_truck_day"
                label={t.maxLoadings}
                required={false}
                hint={fr.fields.defaultHintGeneric}
              />
            </FieldRow>
          </FormSection>
        </>
      )}
    />
  );
}
