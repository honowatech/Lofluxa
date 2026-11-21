import type { ColumnDef } from "@tanstack/react-table";
import { Plus, X } from "lucide-react";
import { useState, useMemo } from "react";
import { useFieldArray, useFormContext, useWatch } from "react-hook-form";
import { z } from "zod";

import {
  CoordinatesField,
  FieldRow,
  FormSection,
  LitersField,
  NumberField,
  OpeningHoursField,
  SelectField,
  summarizeOpeningHours,
  SwitchField,
  TextField,
  useFieldError,
  zLat,
  zLiters,
  zLon,
  zNumber,
  zOpeningHours,
  zOptionalEmail,
  zOptionalNumber,
  zOptionalText,
  zCode,
  zText,
} from "@/components/forms";
import type { MapPoint } from "@/components/map";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fr } from "@/i18n/fr";
import { EMPTY, formatLiters } from "@/lib/format";
import { TRUCK_SIZES, type Product, type Station } from "@/lib/types";

import { CrudTab } from "./CrudTab";
import { products, stations } from "./resources";
import { Mono, Muted, options, TableWithMap } from "./shared";

/** Liste vide stable (évite de recréer les colonnes tant que les données chargent). */
const NONE: never[] = [];

const t = fr.referentials.stations;

const tankSchema = z
  .object({
    uid: z.string().nullable(),
    product_id: z.string({ invalid_type_error: fr.common.required }).min(1, fr.common.required),
    capacity_l: zLiters(),
    safety_stock_l: zNumber({ min: 0 }),
  })
  .refine((tank) => tank.safety_stock_l <= tank.capacity_l, {
    path: ["safety_stock_l"],
    message: t.tankSafetyTooHigh,
  });

const schema = z.object({
  code: zCode(32),
  name: zText(160),
  region: zOptionalText(80),
  city: zOptionalText(80),
  lat: zLat,
  lon: zLon,
  opening_hours: zOpeningHours,
  max_truck_size: z.enum(TRUCK_SIZES),
  unload_time_min: zOptionalNumber({ min: 0, max: 1440, integer: true }),
  contact_name: zOptionalText(160),
  contact_phone: zOptionalText(40),
  contact_email: zOptionalEmail,
  active: z.boolean(),
  tanks: z.array(tankSchema).superRefine((tanks, context) => {
    tanks.forEach((tank, index) => {
      if (tank.product_id && tanks.findIndex((other) => other.product_id === tank.product_id) !== index) {
        context.addIssue({ code: "custom", path: [index, "product_id"], message: t.tankDuplicate });
      }
    });
  }),
});

function TanksEditor({ productList }: { productList: Product[] }) {
  const { control } = useFormContext<z.input<typeof schema>>();
  const { fields, append, remove } = useFieldArray({ control, name: "tanks" });
  const values = useWatch({ control, name: "tanks" }) ?? [];
  const rootError = useFieldError("tanks");
  const used = new Set(values.map((tank) => tank?.product_id).filter(Boolean));
  const nextProduct = productList.find((product) => !used.has(product.id));

  return (
    <div className="flex flex-col gap-2">
      {fields.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t.noTanks}</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div
            className="grid grid-cols-[1fr_9rem_9rem_1.75rem] gap-2 text-xs font-medium text-foreground/70"
            aria-hidden
          >
            <span>{t.tankProduct}</span>
            <span>{t.tankCapacity}</span>
            <span>{t.tankSafety}</span>
          </div>
          {fields.map((field, index) => (
            <div
              key={field.id}
              role="group"
              aria-label={`${t.tanks} ${index + 1}`}
              className="grid grid-cols-[1fr_9rem_9rem_1.75rem] items-start gap-2"
            >
              <SelectField
                name={`tanks.${index}.product_id`}
                label={t.tankProduct}
                hideLabel
                options={productList.map((product) => ({
                  value: product.id,
                  label: `${product.code} — ${product.label}`,
                  disabled: used.has(product.id) && values[index]?.product_id !== product.id,
                }))}
              />
              <LitersField name={`tanks.${index}.capacity_l`} label={t.tankCapacity} hideLabel />
              <LitersField name={`tanks.${index}.safety_stock_l`} label={t.tankSafety} hideLabel />
              <Button
                variant="ghost"
                size="icon-sm"
                className="mt-0.5"
                aria-label={`${t.removeTank} ${index + 1}`}
                title={t.removeTank}
                onClick={() => remove(index)}
              >
                <X />
              </Button>
            </div>
          ))}
        </div>
      )}
      {rootError && (
        <p role="alert" className="text-xs text-destructive">
          {rootError}
        </p>
      )}
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={productList.length > 0 && !nextProduct}
          onClick={() =>
            append({ uid: null, product_id: nextProduct?.id ?? "", capacity_l: null, safety_stock_l: 0 })
          }
        >
          <Plus />
          {t.addTank}
        </Button>
      </div>
    </div>
  );
}

export function StationsTab({ canWrite }: { canWrite: boolean }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const productList = products.useAll().data ?? NONE;
  const create = stations.useCreate();
  const update = stations.useUpdate();
  const colorOf = (id: string) => productList.find((product) => product.id === id)?.color;

  // Colonnes mémorisées : une nouvelle définition à chaque rendu remonterait toutes les cellules (menus, édition).
  const columns = useMemo<ColumnDef<Station, unknown>[]>(
    () => [
      {
        accessorKey: "code",
        header: t.code,
        meta: { className: "w-24" },
        cell: ({ row }) => <Mono>{row.original.code}</Mono>,
      },
      { accessorKey: "name", header: t.name },
      {
        accessorKey: "city",
        header: t.city,
        meta: { className: "w-28" },
        cell: ({ row }) => row.original.city ?? EMPTY,
      },
      {
        accessorKey: "max_truck_size",
        header: t.maxTruckSizeShort,
        meta: { className: "w-24", label: t.maxTruckSize },
        cell: ({ row }) => (
          <Badge tone={row.original.max_truck_size === "large" ? "neutral" : "info"}>
            {fr.status.size[row.original.max_truck_size]}
          </Badge>
        ),
      },
      {
        accessorKey: "opening_hours",
        header: t.hours,
        enableSorting: false,
        meta: { className: "max-w-52" },
        cell: ({ row }) => {
          const summary = summarizeOpeningHours(row.original.opening_hours);
          return (
            <span className="text-xs" title={summary}>
              {summary}
            </span>
          );
        },
      },
      {
        id: "tanks",
        header: t.tanks,
        enableSorting: false,
        cell: ({ row }) =>
          row.original.tanks.length === 0 ? (
            <Muted>{EMPTY}</Muted>
          ) : (
            <span className="flex gap-1">
              {row.original.tanks.map((tank) => (
                <span
                  key={tank.id}
                  className="num inline-flex items-center gap-1 rounded-sm border px-1 text-xs"
                  title={`${fr.referentials.stations.tankSafety} : ${formatLiters(tank.safety_stock_l)}`}
                >
                  <span
                    className="size-2 rounded-full"
                    style={{ background: colorOf(tank.product_id) ?? "#888" }}
                  />
                  {tank.product_code ?? productList.find((p) => p.id === tank.product_id)?.code}{" "}
                  {formatLiters(tank.capacity_l)}
                </span>
              ))}
            </span>
          ),
      },
      {
        accessorKey: "unload_time_min",
        header: `${t.unloadTime} (${t.unloadTimeUnit})`,
        meta: { align: "right", className: "w-36" },
        cell: ({ row }) =>
          row.original.unload_time_min === null ? (
            <Muted>{fr.common.default}</Muted>
          ) : (
            <Mono>{row.original.unload_time_min}</Mono>
          ),
      },
      {
        accessorKey: "active",
        header: t.active,
        meta: { className: "w-20" },
        cell: ({ row }) => <StatusBadge kind="active" value={row.original.active} />,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [productList],
  );

  // Les cuves partent avec la station : le serveur les rapproche par produit (création, mise à jour, retrait).
  const save = async (values: z.output<typeof schema>, row: Station | null) => {
    const input = { ...values, tanks: values.tanks.map(({ uid: _uid, ...tank }) => tank) };
    if (row) await update.mutateAsync({ id: row.id, input });
    else await create.mutateAsync(input);
  };

  const toPoint = (row: Station): MapPoint => ({
    id: row.id,
    kind: "station",
    lat: row.lat,
    lon: row.lon,
    label: row.name,
    inactive: !row.active,
    detail: [
      row.code,
      [row.city, row.region].filter(Boolean).join(", ") || EMPTY,
      summarizeOpeningHours(row.opening_hours),
      t.tanksCount(row.tanks.length),
    ],
  });

  return (
    <CrudTab
      resource={stations}
      caption={fr.referentials.tabs.stations}
      texts={t}
      columns={columns}
      rowLabel={(row) => row.name}
      canWrite={canWrite}
      schema={schema}
      save={save}
      importKind="stations"
      filters={[
        { id: "max_truck_size", label: t.maxTruckSizeShort, options: options.truckSize },
        { id: "active", label: fr.administration.users.status, options: options.active },
      ]}
      initialState={{ sorting: [{ id: "code", desc: false }] }}
      highlightedRowId={selectedId}
      onRowFocus={(row) => setSelectedId(row?.id ?? null)}
      toForm={(row) => ({
        code: row?.code ?? "",
        name: row?.name ?? "",
        region: row?.region ?? "",
        city: row?.city ?? "",
        lat: row?.lat ?? null,
        lon: row?.lon ?? null,
        opening_hours: row?.opening_hours ?? {},
        max_truck_size: row?.max_truck_size ?? "large",
        unload_time_min: row?.unload_time_min ?? null,
        contact_name: row?.contact_name ?? "",
        contact_phone: row?.contact_phone ?? "",
        contact_email: row?.contact_email ?? "",
        active: row?.active ?? true,
        tanks: (row?.tanks ?? []).map((tank) => ({
          uid: tank.id,
          product_id: tank.product_id,
          capacity_l: tank.capacity_l,
          safety_stock_l: tank.safety_stock_l,
        })),
      })}
      layout={(table, rows) => (
        <TableWithMap
          table={table}
          label={fr.referentials.tabs.stations}
          selectedId={selectedId}
          onSelect={setSelectedId}
          points={rows.map(toPoint)}
        />
      )}
      renderForm={(form) => (
        <>
          <FormSection title={t.sections.identity}>
            <FieldRow cols={3}>
              <TextField name="code" label={t.code} required mono uppercase autoFocus />
              <TextField name="name" label={t.name} required className="sm:col-span-2" />
            </FieldRow>
            <FieldRow cols={3}>
              <TextField name="region" label={t.region} required={false} />
              <TextField name="city" label={t.city} required={false} />
              <SwitchField name="active" label={t.active} className="self-end pb-1.5" />
            </FieldRow>
          </FormSection>
          <FormSection title={t.sections.location}>
            <CoordinatesField latName="lat" lonName="lon" kind="station" pointLabel={form.watch("name")} />
          </FormSection>
          <FormSection title={t.sections.reception}>
            <FieldRow>
              <SelectField
                name="max_truck_size"
                label={t.maxTruckSize}
                options={options.truckSize}
                required
              />
              <NumberField
                name="unload_time_min"
                label={t.unloadTime}
                unit={t.unloadTimeUnit}
                required={false}
                hint={fr.fields.defaultHintGeneric}
              />
            </FieldRow>
            <OpeningHoursField name="opening_hours" label={t.hours} />
          </FormSection>
          <FormSection title={t.sections.tanks} hint={t.tanksHint}>
            <TanksEditor productList={productList} />
          </FormSection>
          <FormSection title={t.contact}>
            <FieldRow cols={3}>
              <TextField name="contact_name" label={t.contactName} required={false} />
              <TextField name="contact_phone" label={t.contactPhone} required={false} type="tel" />
              <TextField name="contact_email" label={t.contactEmail} required={false} type="email" />
            </FieldRow>
          </FormSection>
        </>
      )}
    />
  );
}
