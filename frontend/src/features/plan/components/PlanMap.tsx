/**
 * Carte du plan : une couleur par tournée, arrêts numérotés, détail au survol, dépôts, commandes non
 * servies. La sélection est partagée avec la liste et le détail (store) : une tournée sélectionnée met les
 * autres en retrait ; cliquer un arrêt sélectionne l'arrêt et sa tournée.
 */
import { useMemo } from "react";

import { Button, MapView, type MapPoint, type MapRoute } from "@/components";
import { fr } from "@/i18n/fr";
import { formatLiters, formatLocalTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import { tripColor } from "../context";
import { usePlanStore } from "../store";
import type { Plan } from "../types";

const t = fr.screens.plan;

const hasPosition = <T extends { lat?: number | null; lon?: number | null }>(
  item: T,
): item is T & { lat: number; lon: number } => typeof item.lat === "number" && typeof item.lon === "number";

export function buildMapData(
  plan: Plan,
  selectedTripId: string | null,
): { points: MapPoint[]; routes: MapRoute[] } {
  const points: MapPoint[] = [];
  const seenDepots = new Set<string>();
  for (const trip of plan.trips) {
    if (
      seenDepots.has(trip.depot_id) ||
      typeof trip.depot_lat !== "number" ||
      typeof trip.depot_lon !== "number"
    )
      continue;
    seenDepots.add(trip.depot_id);
    points.push({
      id: `depot:${trip.depot_id}`,
      kind: "depot",
      lat: trip.depot_lat,
      lon: trip.depot_lon,
      label: trip.depot_name ?? t.map.depot(trip.depot_code),
      detail: trip.depot_code ? [trip.depot_code] : [],
    });
  }
  const seenStations = new Set<string>();
  for (const order of plan.unserved) {
    if (!hasPosition(order) || !order.station_id) continue;
    if (order.order_status === "postponed" || order.order_status === "cancelled") continue;
    const line = `${order.product_code ?? ""} ${formatLiters(order.requested_l)} — ${
      order.reason_text ?? t.unserved.reasons[order.reason_code]
    }`;
    const existing = points.find((point) => point.id === `unserved:${order.station_id}`);
    if (existing) {
      existing.detail = [...(existing.detail ?? []), line];
      continue;
    }
    if (seenStations.has(order.station_id)) continue;
    seenStations.add(order.station_id);
    points.push({
      id: `unserved:${order.station_id}`,
      kind: "station",
      lat: order.lat,
      lon: order.lon,
      label: order.station_name ?? order.station_code ?? "",
      detail: [t.map.unserved, line],
      inactive: true,
    });
  }

  const routes: MapRoute[] = plan.trips.map((trip) => {
    const stops = trip.stops.filter(hasPosition);
    const depot =
      typeof trip.depot_lat === "number" && typeof trip.depot_lon === "number"
        ? [{ lat: trip.depot_lat, lon: trip.depot_lon }]
        : [];
    return {
      id: trip.id,
      color: tripColor(trip),
      label: t.map.tripLine(trip.seq, trip.truck_plate),
      dimmed: selectedTripId !== null && selectedTripId !== trip.id,
      path: [...depot, ...stops.map((stop) => ({ lat: stop.lat, lon: stop.lon })), ...depot],
      stops: stops.map((stop) => ({
        id: stop.id,
        seq: stop.seq,
        lat: stop.lat,
        lon: stop.lon,
        label: stop.station_name ?? stop.station_code ?? "",
        detail: [
          t.map.tripLine(trip.seq, trip.truck_plate),
          t.map.stopTime(
            formatLocalTime(stop.planned_arrival_at),
            formatLocalTime(stop.planned_departure_at),
          ),
          ...stop.deliveries.map(
            (delivery) =>
              `${delivery.product_label ?? delivery.product_code ?? ""} : ${formatLiters(delivery.planned_l)}${
                delivery.priority === "urgent" ? ` (${t.stops.urgent.toLowerCase()})` : ""
              }`,
          ),
        ],
      })),
    };
  });
  // La tournée sélectionnée est dessinée en dernier : son tracé passe au-dessus des autres.
  routes.sort((a, b) => Number(a.id === selectedTripId) - Number(b.id === selectedTripId));
  return { points, routes };
}

export function PlanMap({ plan, className }: { plan: Plan; className?: string }) {
  const selectedTripId = usePlanStore((state) => state.selectedTripId);
  const selectedStopId = usePlanStore((state) => state.selectedStopId);
  const { points, routes } = useMemo(() => buildMapData(plan, selectedTripId), [plan, selectedTripId]);

  return (
    <div className={cn("relative min-h-0", className)}>
      <MapView
        className="h-full"
        label={t.map.label}
        points={points}
        routes={routes}
        selectedId={selectedStopId}
        onSelect={(id, kind) => {
          if (kind === "stop") usePlanStore.getState().selectStop(id);
        }}
      />
      {selectedTripId && (
        <Button
          variant="outline"
          size="sm"
          className="absolute bottom-2 left-2 z-10 shadow-sm"
          onClick={() => usePlanStore.getState().selectTrip(null)}
        >
          {t.map.showAll}
        </Button>
      )}
    </div>
  );
}
