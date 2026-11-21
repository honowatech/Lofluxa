import { useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Plus, TriangleAlert, X } from "lucide-react";
import { Controller, useFieldArray, useFormContext, useWatch } from "react-hook-form";
import { useMemo } from "react";
import { z } from "zod";

import {
  ChipsInput,
  FieldRow,
  FormSection,
  LitersField,
  NumberField,
  NumberInput,
  SelectField,
  TextAreaField,
  TextField,
  useFieldError,
  zLiters,
  zOptionalNumber,
  zOptionalText,
  zText,
} from "@/components/forms";
import { Notice } from "@/components/PageHeader";
import { SortableList } from "@/components/SortableList";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fr } from "@/i18n/fr";
import { EMPTY, formatLiters, formatNumber } from "@/lib/format";
import {
  TRUCK_SIZES,
  TRUCK_STATUSES,
  type Product,
  type Truck,
  type TruckCompartment,
  type TruckStatus,
} from "@/lib/types";

import { CrudTab } from "./CrudTab";
import { carriers, products, truckCompartments, trucks } from "./resources";
import { Mono, Muted, options } from "./shared";

/** Liste vide stable (évite de recréer les colonnes tant que les données chargent). */
const NONE: never[] = [];

const t = fr.referentials.trucks;

const schema = z.object({
  plate: zText(32),
  carrier_id: z.string().nullable(),
  size: z.enum(TRUCK_SIZES),
  total_capacity_l: zLiters(),
  avg_speed_kmh: zOptionalNumber({ min: 5, max: 120 }),
  status: z.enum(TRUCK_STATUSES),
  cost_per_km: zOptionalNumber({ min: 0, integer: true }),
  notes: zOptionalText(1000),
  compartments: z.array(
    z.object({
      server_id: z.string().nullable(),
      capacity_l: zLiters(),
      allowed_product_ids: z.array(z.string()).nullable(),
    }),
  ),
});
type FormValues = z.input<typeof schema>;

function CompartmentsEditor({ productList }: { productList: Product[] }) {
  const { control, setValue } = useFormContext<FormValues>();
  const { fields, append, remove, move } = useFieldArray({
    control,
    name: "compartments",
    keyName: "fieldKey",
  });
  const values = useWatch({ control, name: "compartments" }) ?? [];
  const total = useWatch({ control, name: "total_capacity_l" });
  const sum = values.reduce((acc, compartment) => acc + (Number(compartment?.capacity_l) || 0), 0);
  const mismatch = fields.length > 0 && typeof total === "number" && Math.abs(sum - total) > 0.5;

  return (
    <div className="flex flex-col gap-2">
      {fields.length === 0 ? (
        <Notice tone="warning" icon={<TriangleAlert className="size-3.5" />}>
          {t.noCompartments}
        </Notice>
      ) : (
        <>
          <div
            className="grid grid-cols-[1.25rem_2rem_8.5rem_1fr_1.75rem] gap-2 text-xs font-medium text-foreground/70"
            aria-hidden
          >
            <span />
            <span>{t.compartmentPosition}</span>
            <span>{t.compartmentCapacity}</span>
            <span>{t.compartmentProducts}</span>
          </div>
          <SortableList
            items={fields}
            getId={(field) => field.fieldKey}
            handleLabel={(_, index) => `${t.compartments} ${index + 1}`}
            onReorder={(_, { from, to }) => move(from, to)}
            className="gap-1.5"
            renderItem={(field, handle, index) => (
              <CompartmentRow
                key={field.fieldKey}
                index={index}
                handle={handle}
                productList={productList}
                onRemove={() => remove(index)}
              />
            )}
          />
        </>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => append({ server_id: null, capacity_l: null, allowed_product_ids: null })}
        >
          <Plus />
          {t.addCompartment}
        </Button>
        {fields.length > 0 && (
          <span className="num text-xs text-muted-foreground" data-testid="compartments-sum">
            {t.compartmentsSum(formatLiters(sum), formatLiters(typeof total === "number" ? total : null))}
          </span>
        )}
      </div>
      {mismatch && (
        <Notice
          tone="warning"
          icon={<TriangleAlert className="size-3.5" />}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => setValue("total_capacity_l", sum, { shouldDirty: true, shouldValidate: true })}
            >
              {t.useSum}
            </Button>
          }
        >
          {t.compartmentsMismatch}
        </Notice>
      )}
    </div>
  );
}

function CompartmentRow({
  index,
  handle,
  productList,
  onRemove,
}: {
  index: number;
  handle: React.ReactNode;
  productList: Product[];
  onRemove: () => void;
}) {
  const { control } = useFormContext<FormValues>();
  const error = useFieldError(`compartments.${index}.capacity_l`);
  return (
    <div
      role="group"
      aria-label={`${t.compartments} ${index + 1}`}
      className="grid grid-cols-[1.25rem_2rem_8.5rem_1fr_1.75rem] items-start gap-2"
    >
      {handle}
      <span className="num pt-1.5 text-center text-sm font-medium">{index + 1}</span>
      <div>
        <Controller
          control={control}
          name={`compartments.${index}.capacity_l`}
          render={({ field }) => (
            <NumberInput
              ref={field.ref}
              aria-label={`${t.compartmentCapacity} ${index + 1}`}
              aria-invalid={!!error}
              unit={fr.fields.litersUnit}
              grouped
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
            />
          )}
        />
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <div className="pt-1">
        <Controller
          control={control}
          name={`compartments.${index}.allowed_product_ids`}
          render={({ field }) => (
            <ChipsInput
              label={`${t.compartmentProducts} ${index + 1}`}
              value={field.value}
              onChange={field.onChange}
              allLabel={t.allProducts}
              options={productList.map((product) => ({
                value: product.id,
                label: product.code,
                color: product.color,
              }))}
            />
          )}
        />
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        className="mt-0.5"
        aria-label={`${t.removeCompartment} ${index + 1}`}
        title={t.removeCompartment}
        onClick={onRemove}
      >
        <X />
      </Button>
    </div>
  );
}

const sameProducts = (a: string[] | null, b: string[] | null) =>
  a === null || b === null ? a === b : a.length === b.length && [...a].sort().join() === [...b].sort().join();

/**
 * Rapproche les compartiments. Les positions sont uniques par camion : celles qui changent passent
 * d'abord par une position provisoire (≥ 1000) pour qu'un échange 1 ↔ 2 ne heurte pas la contrainte.
 */
async function syncCompartments(
  truckId: string,
  before: TruckCompartment[],
  after: z.output<typeof schema>["compartments"],
) {
  const kept = new Set(after.map((c) => c.server_id).filter(Boolean));
  for (const existing of before)
    if (!kept.has(existing.id)) await truckCompartments.remove(truckId, existing.id);

  const target = after.map((compartment, index) => ({ ...compartment, position: index + 1 }));
  const moved = target.filter(
    (c) => c.server_id && before.find((b) => b.id === c.server_id)?.position !== c.position,
  );
  for (const c of moved) {
    await truckCompartments.update(truckId, c.server_id as string, {
      position: 1000 + c.position,
      capacity_l: c.capacity_l,
      allowed_product_ids: c.allowed_product_ids,
    });
  }
  for (const c of target) {
    const input = {
      position: c.position,
      capacity_l: c.capacity_l,
      allowed_product_ids: c.allowed_product_ids,
    };
    const existing = c.server_id ? before.find((b) => b.id === c.server_id) : undefined;
    if (!existing) await truckCompartments.create(truckId, input);
    else if (
      moved.includes(c) ||
      existing.capacity_l !== c.capacity_l ||
      !sameProducts(existing.allowed_product_ids, c.allowed_product_ids)
    ) {
      await truckCompartments.update(truckId, existing.id, input);
    }
  }
}

export function TrucksTab({ canWrite }: { canWrite: boolean }) {
  const productList = products.useAll().data ?? NONE;
  const carrierList = carriers.useAll().data ?? NONE;
  const create = trucks.useCreate();
  const update = trucks.useUpdate();
  const queryClient = useQueryClient();
  const carrierOptions = carrierList.map((carrier) => ({ value: carrier.id, label: carrier.name }));
  const setStatus = (rows: Truck[], status: TruckStatus) =>
    Promise.all(rows.map((row) => update.mutateAsync({ id: row.id, input: { ...toInput(row), status } })));

  // Colonnes mémorisées : une nouvelle définition à chaque rendu remonterait toutes les cellules (menus, édition).
  const columns = useMemo<ColumnDef<Truck, unknown>[]>(
    () => [
      {
        accessorKey: "plate",
        header: t.plate,
        meta: { className: "w-28" },
        cell: ({ row }) => <Mono>{row.original.plate}</Mono>,
      },
      {
        accessorKey: "carrier_name",
        header: t.carrier,
        cell: ({ row }) =>
          row.original.carrier_name ??
          carrierList.find((c) => c.id === row.original.carrier_id)?.name ??
          EMPTY,
      },
      {
        accessorKey: "size",
        header: t.size,
        meta: { className: "w-20" },
        cell: ({ row }) => <Badge>{fr.status.size[row.original.size]}</Badge>,
      },
      {
        accessorKey: "total_capacity_l",
        header: t.totalCapacity,
        meta: { align: "right", className: "w-28" },
        cell: ({ row }) => <Mono>{formatLiters(row.original.total_capacity_l)}</Mono>,
      },
      {
        id: "compartments",
        header: t.compartments,
        enableSorting: false,
        cell: ({ row }) =>
          row.original.compartments.length === 0 ? (
            <Badge tone="warning">{t.compartmentsCount(0)}</Badge>
          ) : (
            <span
              className="flex gap-0.5"
              title={row.original.compartments.map((c) => formatLiters(c.capacity_l)).join(" · ")}
            >
              {row.original.compartments.map((compartment) => (
                <span
                  key={compartment.id}
                  className="num rounded-sm border bg-muted px-1 text-xs data-[restricted]:border-info/40 data-[restricted]:bg-info-soft"
                  data-restricted={compartment.allowed_product_ids ? "" : undefined}
                >
                  {formatNumber(compartment.capacity_l / 1000, compartment.capacity_l % 1000 === 0 ? 0 : 1)}
                </span>
              ))}
              <span className="pl-1 text-xs text-muted-foreground">m³</span>
            </span>
          ),
      },
      {
        accessorKey: "avg_speed_kmh",
        header: `${t.avgSpeed} (${t.avgSpeedUnit})`,
        meta: { align: "right", className: "w-36" },
        cell: ({ row }) =>
          row.original.avg_speed_kmh === null ? (
            <Muted>{fr.common.default}</Muted>
          ) : (
            <Mono>{formatNumber(row.original.avg_speed_kmh)}</Mono>
          ),
      },
      {
        accessorKey: "status",
        header: t.status,
        meta: {
          className: "w-32",
          edit: canWrite
            ? {
                type: "select",
                options: options.truckStatus,
                onCommit: (row, value) => setStatus([row], value as TruckStatus),
              }
            : undefined,
        },
        cell: ({ row }) => <StatusBadge kind="truck" value={row.original.status} />,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [carrierList, canWrite],
  );

  const save = async (values: z.output<typeof schema>, row: Truck | null) => {
    const { compartments, ...input } = values;
    const saved = row ? await update.mutateAsync({ id: row.id, input }) : await create.mutateAsync(input);
    await syncCompartments(saved.id, row?.compartments ?? [], compartments);
    await queryClient.invalidateQueries({ queryKey: trucks.keys.all });
  };

  return (
    <CrudTab
      resource={trucks}
      caption={fr.referentials.tabs.trucks}
      texts={t}
      columns={columns}
      rowLabel={(row) => row.plate}
      canWrite={canWrite}
      schema={schema}
      save={save}
      importKind="trucks"
      filters={[
        { id: "status", label: t.status, options: options.truckStatus },
        { id: "size", label: t.size, options: options.truckSize },
        { id: "carrier_id", label: t.carrier, options: carrierOptions },
      ]}
      initialState={{ sorting: [{ id: "plate", desc: false }] }}
      extraBulkActions={options.truckStatus
        .filter((option) => option.value === "available" || option.value === "maintenance")
        .map((option) => ({
          label: `${fr.referentials.setStatus} : ${option.label}`,
          onClick: async (rows: Truck[]) => {
            await setStatus(rows, option.value);
          },
        }))}
      toForm={(row) => ({
        plate: row?.plate ?? "",
        carrier_id: row?.carrier_id ?? null,
        size: row?.size ?? "large",
        total_capacity_l: row?.total_capacity_l ?? null,
        avg_speed_kmh: row?.avg_speed_kmh ?? null,
        status: row?.status ?? "available",
        cost_per_km: row?.cost_per_km ?? null,
        notes: row?.notes ?? "",
        compartments: [...(row?.compartments ?? [])]
          .sort((a, b) => a.position - b.position)
          .map((c) => ({
            server_id: c.id,
            capacity_l: c.capacity_l,
            allowed_product_ids: c.allowed_product_ids,
          })),
      })}
      renderForm={() => (
        <>
          <FormSection title={t.sections.identity}>
            <FieldRow cols={3}>
              <TextField name="plate" label={t.plate} required mono uppercase autoFocus />
              <SelectField
                name="carrier_id"
                label={t.carrier}
                options={carrierOptions}
                emptyLabel={t.noCarrier}
                className="sm:col-span-2"
              />
            </FieldRow>
            <FieldRow cols={3}>
              <SelectField name="size" label={t.size} options={options.truckSize} required />
              <SelectField name="status" label={t.status} options={options.truckStatus} required />
              <LitersField name="total_capacity_l" label={t.totalCapacity} required />
            </FieldRow>
          </FormSection>
          <FormSection title={t.sections.compartments} hint={t.compartmentsHint}>
            <CompartmentsEditor productList={productList} />
          </FormSection>
          <FormSection title={t.sections.characteristics}>
            <FieldRow>
              <NumberField
                name="avg_speed_kmh"
                label={t.avgSpeed}
                unit={t.avgSpeedUnit}
                required={false}
                hint={fr.fields.defaultHintGeneric}
              />
              <NumberField
                name="cost_per_km"
                label={t.costPerKm}
                unit={t.costPerKmUnit}
                required={false}
                grouped
              />
            </FieldRow>
            <TextAreaField name="notes" label={t.notes} required={false} rows={2} />
          </FormSection>
        </>
      )}
    />
  );
}

function toInput(row: Truck) {
  const {
    id: _id,
    compartments: _compartments,
    carrier_name: _carrier,
    created_at: _created,
    updated_at: _updated,
    ...input
  } = row;
  return input;
}
