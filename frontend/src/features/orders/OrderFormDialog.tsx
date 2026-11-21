/** Création / modification d'une commande (F3.1) : station, produit, volume, priorité, fenêtre, commentaire. */
import { z } from "zod";

import {
  EntityFormDialog,
  FieldRow,
  FormSection,
  LitersField,
  normalizeTime,
  SelectField,
  TextAreaField,
  TIME_RE,
  TimeField,
  zLiters,
  zOptionalText,
} from "@/components/forms";
import { Notice } from "@/components/PageHeader";
import { fr } from "@/i18n/fr";
import { formatLiters } from "@/lib/format";
import { ORDER_PRIORITIES } from "@/lib/types";

import { isEditable, type Order, type OrderInput, type Product, type Station } from "./api";

const t = fr.screens.orders;

const zChoice = z
  .string()
  .nullable()
  .refine((value): value is string => !!value, fr.common.required);

/** Heure `HH:mm` facultative : vide → `null`, saisie tolérante (`630` → `06:30`). */
const zOptionalTime = z
  .string()
  .nullable()
  .transform((value) => (value && value.trim() ? normalizeTime(value) : null))
  .refine((value) => value === null || TIME_RE.test(value), fr.fields.timeInvalid);

const schema = z.object({
  station_id: zChoice,
  product_id: zChoice,
  requested_l: zLiters(),
  priority: z.enum(ORDER_PRIORITIES),
  window_start: zOptionalTime,
  window_end: zOptionalTime,
  comment: zOptionalText(500),
});

export const priorityOptions = ORDER_PRIORITIES.map((value) => ({
  value,
  label: fr.status.priority[value],
}));

function TankHint({ station, productId }: { station: Station | undefined; productId: string | null }) {
  if (!station || !productId) return null;
  const tank = station.tanks.find((candidate) => candidate.product_id === productId);
  return (
    <p className="text-xs text-muted-foreground" data-testid="tank-hint">
      {tank
        ? t.form.tank(formatLiters(tank.capacity_l), formatLiters(tank.safety_stock_l))
        : t.form.tankUnknown}
    </p>
  );
}

export function OrderFormDialog({
  open,
  onOpenChange,
  order,
  day,
  stations,
  products,
  canWrite,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Commande à modifier ; `null` pour une création. */
  order: Order | null;
  day: string;
  stations: Station[];
  products: Product[];
  canWrite: boolean;
  onSave: (input: OrderInput, order: Order | null) => Promise<unknown>;
}) {
  const readOnly = !canWrite || (order !== null && !isEditable(order));
  // Une station désactivée depuis la saisie reste affichée pour la commande qui la porte.
  const stationOptions = stations
    .filter((station) => station.active || station.id === order?.station_id)
    .map((station) => ({ value: station.id, label: `${station.code} — ${station.name}` }));
  const productOptions = products.map((product) => ({ value: product.id, label: product.label }));

  return (
    <EntityFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={order ? (readOnly ? t.form.viewTitle : t.form.editTitle) : t.form.newTitle}
      description={order ? `${order.station_code} — ${order.station_name}` : undefined}
      schema={schema}
      readOnly={readOnly}
      defaultValues={{
        station_id: order?.station_id ?? null,
        product_id: order?.product_id ?? null,
        requested_l: order?.requested_l ?? null,
        priority: order?.priority ?? "normal",
        window_start: order?.window_start ?? "",
        window_end: order?.window_end ?? "",
        comment: order?.comment ?? "",
      }}
      onSubmit={(values) => onSave({ day: order?.day ?? day, ...values }, order)}
    >
      {(form) => {
        const stationId = form.watch("station_id");
        const productId = form.watch("product_id");
        return (
          <>
            {order && canWrite && !isEditable(order) && (
              <Notice tone="neutral">{t.form.notEditable(fr.status.order[order.status])}</Notice>
            )}
            <FormSection title={t.form.orderSection}>
              <SelectField name="station_id" label={t.form.station} options={stationOptions} required />
              <FieldRow cols={3}>
                <SelectField name="product_id" label={t.form.product} options={productOptions} required />
                <LitersField name="requested_l" label={t.form.volume} required />
                <SelectField name="priority" label={t.form.priority} options={priorityOptions} required />
              </FieldRow>
              <TankHint
                station={stations.find((station) => station.id === stationId)}
                productId={productId}
              />
            </FormSection>
            <FormSection title={t.form.windowSection}>
              <FieldRow cols={3}>
                <TimeField name="window_start" label={t.form.windowStart} required={false} />
                <TimeField name="window_end" label={t.form.windowEnd} required={false} />
              </FieldRow>
              <p className="text-xs text-muted-foreground">{t.form.windowHint}</p>
            </FormSection>
            <TextAreaField name="comment" label={t.form.comment} required={false} rows={3} />
          </>
        );
      }}
    </EntityFormDialog>
  );
}
