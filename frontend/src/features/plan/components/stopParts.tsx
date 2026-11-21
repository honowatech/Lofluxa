/** Briques communes aux deux présentations d'un arrêt (panneau de détail, vue tableau). */
import { ArrowDown, ArrowRightLeft, ArrowUp, CircleAlert, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";

import { Badge, Button } from "@/components";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fr } from "@/i18n/fr";
import { formatLiters } from "@/lib/format";
import { cn } from "@/lib/utils";

import { usePlanUi } from "../context";
import { isStopMovable, isTripEditable, keyboardMove } from "../edits";
import { usePlanStore, type StopZone } from "../store";
import type { Delivery, PlanViolation, Stop, Trip } from "../types";

const t = fr.screens.plan;

/** Livraisons d'un arrêt, par produit : pastille de couleur du produit, code, volume ; commande urgente signalée. */
export function DeliveryChips({ deliveries, className }: { deliveries: Delivery[]; className?: string }) {
  return (
    <ul className={cn("flex flex-wrap gap-x-2.5 gap-y-0.5", className)}>
      {deliveries.map((delivery) => (
        <li key={delivery.id} className="flex items-center gap-1 text-xs">
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: delivery.product_color ?? "currentColor" }}
            aria-hidden
          />
          <span className="text-muted-foreground" title={delivery.product_label ?? undefined}>
            {delivery.product_code}
          </span>
          <span className="num">{formatLiters(delivery.planned_l)}</span>
          {delivery.priority === "urgent" && (
            <Badge tone="blocking" className="px-1 py-0 text-2xs leading-4">
              {t.stops.urgent}
            </Badge>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Marque de violation sur un arrêt ou une tournée (le détail est toujours dans le panneau des violations). */
export function ViolationMarks({ violations }: { violations: PlanViolation[] }) {
  if (violations.length === 0) return null;
  const blocking = violations.filter((v) => v.severity === "blocking");
  const Icon = blocking.length > 0 ? CircleAlert : TriangleAlert;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center",
        blocking.length > 0 ? "text-blocking" : "text-warning",
      )}
      title={violations.map((v) => `${v.rule_code} — ${v.message}`).join("\n")}
    >
      <Icon className="size-3.5" aria-hidden />
      <span className="sr-only">{violations.map((v) => v.rule_code).join(", ")}</span>
    </span>
  );
}

/**
 * Comportement clavier d'une ligne d'arrêt : Alt + ↑ / ↓ déplace l'arrêt (dans sa tournée, puis vers la
 * tournée voisine), ↑ / ↓ passent à l'arrêt voisin, Entrée ou Espace le sélectionnent.
 */
export function useStopRow(zone: StopZone, trip: Trip, stop: Stop) {
  const { canEdit, edit, busy } = usePlanUi();
  const ref = useRef<HTMLElement | null>(null);
  const wantsFocus = usePlanStore((state) => state.focusStopId === stop.id && state.focusZone === zone);
  const pending = usePlanStore((state) => state.pendingOp !== null);
  const selected = usePlanStore((state) => state.selectedStopId === stop.id);

  useEffect(() => {
    if (!wantsFocus) return;
    ref.current?.focus({ preventScroll: false });
    // La demande est conservée pendant l'appel (la ligne peut être remontée par la réponse du serveur).
    if (!pending) usePlanStore.getState().requestFocus(null);
  }, [wantsFocus, pending, trip.id, stop.seq]);

  const move = useCallback(
    (direction: "up" | "down") => {
      const state = usePlanStore.getState();
      if (!canEdit || busy || !state.confirmed) return;
      const op = keyboardMove(state.confirmed, stop.id, direction);
      if (!op) return;
      void edit(op, { focusStopId: stop.id, zone });
      usePlanStore.getState().selectStop(stop.id);
    },
    [busy, canEdit, edit, stop.id, zone],
  );

  const moveToTrip = useCallback(
    (target: Trip) => {
      if (!canEdit || busy) return;
      void edit(
        {
          type: "move",
          tripId: trip.id,
          stopId: stop.id,
          toTripId: target.id,
          toSeq: target.stops.length + 1,
        },
        { focusStopId: stop.id, zone },
      );
      usePlanStore.getState().selectStop(stop.id);
    },
    [busy, canEdit, edit, stop.id, trip.id, zone],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        if (event.altKey) {
          move(event.key === "ArrowUp" ? "up" : "down");
          return;
        }
        const rows = Array.from(
          event.currentTarget.closest("[data-stop-zone]")?.querySelectorAll<HTMLElement>("[data-stop-row]") ??
            [],
        );
        const index = rows.indexOf(event.currentTarget);
        rows[index + (event.key === "ArrowUp" ? -1 : 1)]?.focus();
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        usePlanStore.getState().selectStop(stop.id);
      }
    },
    [move, stop.id],
  );

  return {
    ref,
    selected,
    move,
    moveToTrip,
    rowProps: {
      tabIndex: 0,
      "data-stop-row": stop.id,
      "aria-keyshortcuts": canEdit ? "Alt+ArrowUp Alt+ArrowDown" : undefined,
      onKeyDown,
      onClick: () => usePlanStore.getState().selectStop(stop.id),
    },
    movable: canEdit && isStopMovable(trip, stop),
  };
}

/** Menu « Déplacer vers… » : la même action que le glisser-déposer, sans souris. */
export function StopMoveMenu({
  trip,
  stop,
  onMove,
  onMoveToTrip,
}: {
  trip: Trip;
  stop: Stop;
  onMove: (direction: "up" | "down") => void;
  onMoveToTrip: (target: Trip) => void;
}) {
  const { busy } = usePlanUi();
  const trips = usePlanStore((state) => state.plan?.trips);
  const others = (trips ?? []).filter((other) => other.id !== trip.id && isTripEditable(other));
  const name = stop.station_name ?? stop.station_code ?? "";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 shrink-0 text-muted-foreground"
          aria-label={t.stops.moveMenu(name)}
          disabled={busy}
          onClick={(event) => event.stopPropagation()}
        >
          <ArrowRightLeft className="!size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-72 overflow-y-auto" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuItem onSelect={() => onMove("up")}>
          <ArrowUp aria-hidden />
          {t.stops.moveUp}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onMove("down")}>
          <ArrowDown aria-hidden />
          {t.stops.moveDown}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t.stops.moveTo}</DropdownMenuLabel>
        {others.length === 0 && <DropdownMenuLabel>{t.stops.noOtherTrip}</DropdownMenuLabel>}
        {others.map((other) => (
          <DropdownMenuItem key={other.id} onSelect={() => onMoveToTrip(other)}>
            {t.stops.moveToTrip(other.seq, other.truck_plate)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
