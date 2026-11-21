/**
 * Bandeau des commandes non servies (F4.4) : elles ne disparaissent jamais silencieusement.
 * Urgentes en tête (RM-15), raison lisible ; « Reporter » lève le blocage de publication d'une urgente.
 */
import { useQueryClient } from "@tanstack/react-query";
import { CalendarClock, ChevronDown, ChevronUp, PackageX } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge, Button, notify, useConfirm } from "@/components";
import { fr } from "@/i18n/fr";
import { formatLiters } from "@/lib/format";
import { cn } from "@/lib/utils";

import { planKeys, postponeOrder } from "../api";
import type { Plan, Unserved } from "../types";

const t = fr.screens.plan;

const isOpen = (order: Unserved) => order.order_status !== "postponed" && order.order_status !== "cancelled";
/** Urgentes à traiter d'abord, puis les autres ; les commandes déjà reportées ou annulées en dernier. */
const rank = (order: Unserved) => (isOpen(order) ? (order.priority === "urgent" ? 0 : 1) : 2);

export function sortUnserved(unserved: Unserved[]): Unserved[] {
  return [...unserved].sort(
    (a, b) => rank(a) - rank(b) || (a.station_code ?? "").localeCompare(b.station_code ?? "", "fr"),
  );
}

/** Replié, le bandeau tient sur une ligne : les premières commandes (urgentes d'abord), puis « Tout afficher ». */
const COLLAPSED = 2;

export function UnservedBanner({ plan, canPostpone }: { plan: Plan; canPostpone: boolean }) {
  const client = useQueryClient();
  const confirm = useConfirm();
  const [expanded, setExpanded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const orders = useMemo(() => sortUnserved(plan.unserved), [plan.unserved]);
  if (orders.length === 0) return null;

  const urgent = orders.filter((order) => isOpen(order) && order.priority === "urgent").length;
  const visible = expanded ? orders : orders.slice(0, COLLAPSED);

  const postpone = async (order: Unserved) => {
    const station = order.station_name ?? order.station_code ?? "";
    const accepted = await confirm({
      title: t.unserved.postponeTitle,
      description: t.unserved.postponeBody(
        station,
        order.product_label ?? order.product_code ?? "",
        formatLiters(order.requested_l),
      ),
      confirmLabel: t.unserved.postpone,
    });
    if (!accepted) return;
    setBusyId(order.order_id);
    try {
      await postponeOrder(order.order_id);
      notify.success(t.unserved.postponeDone(station));
      await client.invalidateQueries({ queryKey: planKeys.one(plan.id) });
      void client.invalidateQueries({ queryKey: planKeys.ofDay(plan.day) });
    } catch (error) {
      notify.apiError(error, t.unserved.postponeFailed);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section
      aria-label={t.unserved.title}
      data-testid="unserved-banner"
      className={cn(
        "flex items-start gap-3 rounded-md border px-3 py-1",
        urgent > 0 ? "border-blocking/40 bg-blocking-soft" : "border-warning/40 bg-warning-soft",
      )}
    >
      <div
        className={cn(
          "flex shrink-0 items-center gap-1.5 pt-0.5 text-xs",
          urgent > 0 ? "text-blocking" : "text-warning",
        )}
      >
        <PackageX className="size-4" aria-hidden />
        <div>
          <h2 className="font-semibold">{t.unserved.count(orders.length)}</h2>
          {urgent > 0 && <p>{t.unserved.urgentCount(urgent)}</p>}
        </div>
      </div>
      <ul
        className={cn(
          "flex min-w-0 flex-1 gap-1.5",
          expanded ? "max-h-32 flex-wrap overflow-y-auto" : "overflow-hidden",
        )}
      >
        {visible.map((order) => {
          const open = isOpen(order);
          const station = order.station_name ?? order.station_code ?? "";
          return (
            <li
              key={order.id}
              data-urgent={(open && order.priority === "urgent") || undefined}
              className={cn(
                "flex min-w-0 max-w-full items-center gap-1.5 rounded-sm border bg-card px-1.5 py-0.5 text-xs",
                open && order.priority === "urgent" ? "border-blocking/50" : "border-border",
                !open && "opacity-70",
              )}
            >
              {order.priority === "urgent" && open && <Badge tone="blocking">{t.unserved.urgent}</Badge>}
              {!open && (
                <Badge tone="neutral">
                  {order.order_status === "cancelled" ? t.unserved.cancelled : t.unserved.postponed}
                </Badge>
              )}
              <span className="num text-muted-foreground">{order.station_code}</span>
              <span className="truncate font-medium">{station}</span>
              <span className="num shrink-0">
                {order.product_code} {formatLiters(order.requested_l)}
              </span>
              <span className="truncate text-muted-foreground" title={order.reason_text ?? undefined}>
                {t.unserved.reasons[order.reason_code]}
              </span>
              {canPostpone && open && order.order_status === "confirmed" && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-5 shrink-0 px-1.5"
                  disabled={busyId !== null}
                  aria-label={t.unserved.postponeLabel(station)}
                  title={t.unserved.postponeLabel(station)}
                  onClick={() => void postpone(order)}
                >
                  <CalendarClock className="!size-3" aria-hidden />
                  {(order.priority === "urgent" || expanded) && t.unserved.postpone}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {orders.length > COLLAPSED && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
          {expanded ? t.unserved.collapse : `${t.unserved.expand} (${orders.length})`}
        </Button>
      )}
    </section>
  );
}
