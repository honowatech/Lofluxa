import type { ColumnDef } from "@tanstack/react-table";
import { z } from "zod";

import { SelectField, TextAreaField, TextField, zOptionalText, zText } from "@/components/forms";
import { Badge } from "@/components/ui/badge";
import { fr } from "@/i18n/fr";
import { EMPTY } from "@/lib/format";
import { CARRIER_TYPES, type Carrier } from "@/lib/types";

import { CrudTab } from "./CrudTab";
import { carriers } from "./resources";
import { options } from "./shared";

const t = fr.referentials.carriers;

const schema = z.object({ name: zText(160), type: z.enum(CARRIER_TYPES), contact: zOptionalText(500) });

const columns: ColumnDef<Carrier, unknown>[] = [
  { accessorKey: "name", header: t.name },
  {
    accessorKey: "type",
    header: t.type,
    meta: { className: "w-32" },
    cell: ({ row }) => (
      <Badge tone={row.original.type === "own" ? "primary" : "neutral"}>
        {fr.status.carrierType[row.original.type]}
      </Badge>
    ),
  },
  {
    accessorKey: "contact",
    header: t.contact,
    enableSorting: false,
    cell: ({ row }) => row.original.contact ?? EMPTY,
  },
];

export function CarriersTab({ canWrite }: { canWrite: boolean }) {
  return (
    <CrudTab
      resource={carriers}
      caption={fr.referentials.tabs.carriers}
      texts={t}
      columns={columns}
      rowLabel={(row) => row.name}
      canWrite={canWrite}
      schema={schema}
      formPlacement="center"
      filters={[{ id: "type", label: t.type, options: options.carrierType }]}
      initialState={{ sorting: [{ id: "name", desc: false }] }}
      toForm={(row) => ({
        name: row?.name ?? "",
        type: row?.type ?? "third_party",
        contact: row?.contact ?? "",
      })}
      renderForm={() => (
        <>
          <TextField name="name" label={t.name} required autoFocus />
          <SelectField name="type" label={t.type} options={options.carrierType} required />
          <TextAreaField name="contact" label={t.contact} required={false} rows={2} />
        </>
      )}
    />
  );
}
