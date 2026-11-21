/** Résumé du jour : commandes, camions, chauffeurs, stocks dépôt — avec les raccourcis vers les écrans à compléter. */
import { ArrowRight, CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { ErrorState, Skeleton } from "@/components/states";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { fr } from "@/i18n/fr";
import { formatLocalTime } from "@/lib/format";
import { ORDER_STATUSES } from "@/lib/types";
import { withDay } from "@/lib/useDay";
import { cn } from "@/lib/utils";

import type { DaySummary } from "./api";

const t = fr.screens.day.summary;
/** Manques listés dans la carte ; le reste est résumé (« + n autres »). */
const MAX_MISSING_SHOWN = 6;

export function Card({
  title,
  aside,
  children,
  className,
  testId,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section
      aria-label={title}
      data-testid={testId}
      className={cn("flex min-w-0 flex-col rounded-md border bg-card", className)}
    >
      <header className="flex min-h-8 items-center gap-2 border-b bg-muted/40 px-3 py-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-foreground/70">{title}</h2>
        {aside && <div className="ml-auto flex items-center gap-2">{aside}</div>}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">{children}</div>
    </section>
  );
}

function Shortcut({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="mt-auto inline-flex items-center gap-1 self-start rounded-sm text-xs font-medium text-primary underline-offset-2 hover:underline focus-ring"
    >
      {children}
      <ArrowRight className="size-3" aria-hidden />
    </Link>
  );
}

function Figure({ value, tone }: { value: string; tone?: "ok" | "warning" | "blocking" }) {
  return (
    <p
      className={cn(
        "text-xl font-semibold leading-tight tabular-nums",
        tone === "warning" && "text-warning",
        tone === "blocking" && "text-blocking",
      )}
    >
      {value}
    </p>
  );
}

function Line({ tone, children }: { tone: "ok" | "warning" | "blocking" | "muted"; children: ReactNode }) {
  const Icon = tone === "blocking" ? CircleAlert : tone === "warning" ? TriangleAlert : CircleCheck;
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 text-xs",
        tone === "ok" && "text-success",
        tone === "warning" && "text-warning",
        tone === "blocking" && "text-blocking",
        tone === "muted" && "text-muted-foreground",
      )}
    >
      {tone !== "muted" && <Icon className="mt-px size-3.5 shrink-0" aria-hidden />}
      <span>{children}</span>
    </p>
  );
}

export function SummaryCards({
  day,
  summary,
  loading,
  error,
  onRetry,
  canWriteOrders,
  canWriteStocks,
}: {
  day: string;
  summary: DaySummary | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  canWriteOrders: boolean;
  canWriteStocks: boolean;
}) {
  if (!summary) {
    return (
      <div className="rounded-md border bg-card" data-testid="day-summary">
        {error && !loading ? (
          <ErrorState error={error} onRetry={onRetry} compact />
        ) : (
          <div className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-4" aria-busy>
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="flex flex-col gap-2">
                <Skeleton className="w-1/3" />
                <Skeleton className="h-6 w-1/2" />
                <Skeleton className="w-3/4" />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const { orders, trucks, drivers, depot_stocks: stocks } = summary;
  const drafts = orders.by_status.draft ?? 0;

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="day-summary">
      <Card title={t.orders.title} testId="summary-orders">
        <Figure value={t.orders.total(orders.total)} />
        {orders.total === 0 ? (
          <Line tone="muted">{t.orders.none}</Line>
        ) : (
          <ul className="flex flex-wrap gap-x-3 gap-y-1">
            {ORDER_STATUSES.filter((status) => (orders.by_status[status] ?? 0) > 0).map((status) => (
              <li key={status} className="flex items-center gap-1" data-status={status}>
                <StatusBadge kind="order" value={status} />
                <span className="num text-sm font-medium">{orders.by_status[status]}</span>
              </li>
            ))}
          </ul>
        )}
        {orders.urgent_pending > 0 ? (
          <Line tone="blocking">{t.orders.urgentPending(orders.urgent_pending)}</Line>
        ) : (
          orders.total > 0 && <Line tone="ok">{t.orders.noUrgent}</Line>
        )}
        {drafts > 0 ? (
          <>
            <Line tone="warning">{t.orders.drafts(drafts)}</Line>
            <Shortcut to={withDay("/commandes?status=draft", day)}>
              {canWriteOrders ? t.orders.confirmDrafts : t.orders.open}
            </Shortcut>
          </>
        ) : (
          <Shortcut to={withDay("/commandes", day)}>{t.orders.open}</Shortcut>
        )}
      </Card>

      <Card title={t.trucks.title} testId="summary-trucks">
        <Figure
          value={t.trucks.assignable(trucks.assignable, trucks.total)}
          tone={trucks.total > 0 && trucks.assignable === 0 ? "blocking" : undefined}
        />
        {trucks.blocked > 0 ? (
          <Line tone="warning">{t.trucks.blocked(trucks.blocked)}</Line>
        ) : (
          <Line tone="ok">{t.trucks.noneBlocked}</Line>
        )}
        <Shortcut to={withDay("/disponibilite?tab=trucks", day)}>{t.trucks.open}</Shortcut>
      </Card>

      <Card title={t.drivers.title} testId="summary-drivers">
        <Figure
          value={t.drivers.assignable(drivers.assignable, drivers.total)}
          tone={drivers.total > 0 && drivers.assignable === 0 ? "blocking" : undefined}
        />
        {drivers.blocked > 0 ? (
          <Line tone={drivers.blocked_rm03 > 0 ? "blocking" : "warning"}>
            {t.drivers.blocked(drivers.blocked)}
            {drivers.blocked_rm03 > 0 && ` — ${t.drivers.blockedRm03(drivers.blocked_rm03)}`}
          </Line>
        ) : (
          <Line tone="ok">{t.drivers.noneBlocked}</Line>
        )}
        {drivers.assignable_without_truck > 0 && (
          <Line tone="warning">{t.drivers.withoutTruck(drivers.assignable_without_truck)}</Line>
        )}
        <Shortcut to={withDay("/disponibilite?tab=drivers", day)}>{t.drivers.open}</Shortcut>
      </Card>

      <Card
        title={t.stocks.title}
        testId="summary-stocks"
        aside={
          stocks.expected > 0 &&
          (stocks.complete ? (
            <Badge tone="success">{t.stocks.complete}</Badge>
          ) : (
            <Badge tone="warning">{t.stocks.missing(stocks.missing)}</Badge>
          ))
        }
      >
        <Figure
          value={t.stocks.entered(stocks.entered, stocks.expected)}
          tone={stocks.missing > 0 ? "warning" : undefined}
        />
        {stocks.expected === 0 ? (
          <Line tone="muted">{t.stocks.noDepot}</Line>
        ) : (
          <Line tone="muted">
            {stocks.last_entered_at
              ? t.stocks.lastEntered(formatLocalTime(stocks.last_entered_at))
              : t.stocks.neverEntered}
          </Line>
        )}
        {stocks.missing_items.length > 0 && (
          <div>
            <p className="text-xs font-medium text-foreground/70">{t.stocks.missingList}</p>
            <ul className="mt-1 flex flex-wrap gap-1" aria-label={t.stocks.missingList}>
              {stocks.missing_items.slice(0, MAX_MISSING_SHOWN).map((item) => (
                <li key={`${item.depot_id}-${item.product_id}`}>
                  <Badge tone="warning" className="num">
                    {item.depot_code} · {item.product_code}
                  </Badge>
                </li>
              ))}
              {stocks.missing_items.length > MAX_MISSING_SHOWN && (
                <li className="text-xs text-warning">
                  {t.stocks.more(stocks.missing_items.length - MAX_MISSING_SHOWN)}
                </li>
              )}
            </ul>
          </div>
        )}
        <Shortcut to={withDay("/disponibilite?tab=stocks", day)}>
          {stocks.missing > 0 && canWriteStocks ? t.stocks.open : t.stocks.view}
        </Shortcut>
      </Card>
    </div>
  );
}
