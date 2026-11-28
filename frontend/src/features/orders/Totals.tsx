/** Pied de tableau (`DataTable footer`) : totaux par produit et par statut des commandes affichées. */
import { StatusBadge } from "@/components/StatusBadge";
import { fr } from "@/i18n/fr";
import { formatLiters } from "@/lib/format";
import { ORDER_STATUSES } from "@/lib/types";

import type { Order, Product } from "./api";

const t = fr.screens.orders.totals;

interface Bucket {
  count: number;
  volume: number;
}

function group<K extends string>(orders: Order[], key: (order: Order) => K): Map<K, Bucket> {
  const buckets = new Map<K, Bucket>();
  for (const order of orders) {
    const bucket = buckets.get(key(order)) ?? { count: 0, volume: 0 };
    bucket.count += 1;
    bucket.volume += order.requested_l;
    buckets.set(key(order), bucket);
  }
  return buckets;
}

function Cell({ label, bucket, testId }: { label: React.ReactNode; bucket: Bucket; testId: string }) {
  return (
    <li className="flex items-baseline gap-1.5 whitespace-nowrap" data-testid={testId}>
      {label}
      <span className="num text-sm font-semibold">{formatLiters(bucket.volume)}</span>
      <span className="num text-xs text-muted-foreground">({bucket.count})</span>
    </li>
  );
}

export function Totals({ orders, products }: { orders: Order[]; products: Product[] }) {
  const byProduct = group(orders, (order) => order.product_id);
  const byStatus = group(orders, (order) => order.status);
  const total: Bucket = {
    count: orders.length,
    volume: orders.reduce((sum, order) => sum + order.requested_l, 0),
  };
  const productRows = [...byProduct.entries()]
    .map(([id, bucket]) => {
      const sample = orders.find((order) => order.product_id === id);
      return {
        id,
        bucket,
        code: sample?.product_code ?? "",
        label: sample?.product_label ?? "",
        color: products.find((product) => product.id === id)?.color,
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code, "fr"));

  return (
    <div
      role="group"
      aria-label={t.title}
      data-testid="orders-totals"
      className="flex flex-wrap items-center gap-x-6 gap-y-1.5 px-1 py-0.5"
    >
      {orders.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t.none}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-foreground/60">
              {t.byProduct}
            </h2>
            <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {productRows.map((row) => (
                <Cell
                  key={row.id}
                  testId={`total-product-${row.code}`}
                  bucket={row.bucket}
                  label={
                    <span className="flex items-center gap-1 text-xs">
                      <span
                        className="inline-block size-2 rounded-full"
                        style={{ backgroundColor: row.color ?? "currentColor" }}
                        aria-hidden
                      />
                      {row.label}
                    </span>
                  }
                />
              ))}
            </ul>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-foreground/60">{t.byStatus}</h2>
            <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {ORDER_STATUSES.filter((status) => byStatus.has(status)).map((status) => (
                <Cell
                  key={status}
                  testId={`total-status-${status}`}
                  bucket={byStatus.get(status) as Bucket}
                  label={<StatusBadge kind="order" value={status} />}
                />
              ))}
            </ul>
          </div>
          <p className="ml-auto flex items-baseline gap-1.5 whitespace-nowrap" data-testid="total-all">
            <span className="text-xs font-semibold uppercase tracking-wide text-foreground/60">
              {t.total}
            </span>
            <span className="num text-sm font-semibold">{formatLiters(total.volume)}</span>
            <span className="num text-xs text-muted-foreground">({t.count(total.count)})</span>
          </p>
        </>
      )}
    </div>
  );
}
