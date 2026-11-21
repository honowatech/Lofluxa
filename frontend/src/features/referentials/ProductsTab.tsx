import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { z } from "zod";

import { ColorField, FieldRow, NumberField, TextField, zColor, zNumber, zText } from "@/components/forms";
import { fr } from "@/i18n/fr";
import { formatNumber } from "@/lib/format";
import type { Product } from "@/lib/types";

import { CrudTab } from "./CrudTab";
import { products } from "./resources";
import { Mono } from "./shared";

const t = fr.referentials.products;

const schema = z.object({
  code: zText(32),
  label: zText(120),
  ref_density_15: zNumber({ min: 0.5, max: 1.2 }),
  thermal_coeff: zNumber({ min: 0, max: 0.01 }),
  color: zColor,
});

export function ProductsTab({ canWrite }: { canWrite: boolean }) {
  const update = products.useUpdate();
  // Colonnes mémorisées : une nouvelle définition à chaque rendu remonterait toutes les cellules (menus, édition).
  const columns = useMemo<ColumnDef<Product, unknown>[]>(
    () => [
      {
        accessorKey: "color",
        header: t.color,
        enableSorting: false,
        meta: { className: "w-16" },
        cell: ({ row }) => (
          <span
            className="inline-block size-3.5 rounded-sm border align-middle"
            style={{ background: row.original.color }}
            title={row.original.color}
          />
        ),
      },
      {
        accessorKey: "code",
        header: t.code,
        meta: { className: "w-32" },
        cell: ({ row }) => <Mono>{row.original.code}</Mono>,
      },
      {
        accessorKey: "label",
        header: t.label,
        meta: canWrite
          ? {
              edit: {
                type: "text",
                validate: (value) => (value ? undefined : fr.common.required),
                onCommit: (row, value) =>
                  update.mutateAsync({ id: row.id, input: { ...row, label: String(value) } }),
              },
            }
          : undefined,
      },
      {
        accessorKey: "ref_density_15",
        header: `${t.density} (${t.densityUnit})`,
        meta: { align: "right", className: "w-40" },
        cell: ({ row }) => <Mono>{formatNumber(row.original.ref_density_15, 4)}</Mono>,
      },
      {
        accessorKey: "thermal_coeff",
        header: `${t.thermal} (${t.thermalUnit})`,
        meta: { align: "right", className: "w-44" },
        cell: ({ row }) => <Mono>{formatNumber(row.original.thermal_coeff, 5)}</Mono>,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canWrite],
  );

  return (
    <CrudTab
      resource={products}
      caption={fr.referentials.tabs.products}
      texts={t}
      columns={columns}
      rowLabel={(row) => row.label || row.code}
      canWrite={canWrite}
      schema={schema}
      formPlacement="center"
      initialState={{ sorting: [{ id: "code", desc: false }] }}
      toForm={(row) => ({
        code: row?.code ?? "",
        label: row?.label ?? "",
        ref_density_15: row?.ref_density_15 ?? null,
        thermal_coeff: row?.thermal_coeff ?? null,
        color: row?.color ?? "#1d6fb8",
      })}
      renderForm={() => (
        <>
          <FieldRow>
            <TextField name="code" label={t.code} required mono uppercase autoFocus />
            <ColorField name="color" label={t.color} />
          </FieldRow>
          <TextField name="label" label={t.label} required />
          <FieldRow>
            <NumberField name="ref_density_15" label={t.density} unit={t.densityUnit} required />
            <NumberField
              name="thermal_coeff"
              label={t.thermal}
              unit={t.thermalUnit}
              required
              hint={t.thermalHint}
            />
          </FieldRow>
        </>
      )}
    />
  );
}
