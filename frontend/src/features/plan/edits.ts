/**
 * Modifications d'un plan, côté écran : fonctions pures.
 * `applyOp` produit l'état optimiste affiché en attendant la réponse de l'API ; les distances, durées,
 * heures et violations ne sont PAS recalculées ici (une seule source de vérité : le serveur) — seuls
 * l'ordre des arrêts, les volumes et le taux de remplissage, déductibles sans règle métier, sont mis à jour.
 */
import type { EditOp, Plan, Stop, Trip } from "./types";

export interface StopLocation {
  trip: Trip;
  stop: Stop;
  tripIndex: number;
  stopIndex: number;
}

export function findTrip(plan: Plan | null | undefined, tripId: string | null | undefined): Trip | undefined {
  return tripId ? plan?.trips.find((trip) => trip.id === tripId) : undefined;
}

export function findStop(
  plan: Plan | null | undefined,
  stopId: string | null | undefined,
): StopLocation | undefined {
  if (!plan || !stopId) return undefined;
  for (let tripIndex = 0; tripIndex < plan.trips.length; tripIndex += 1) {
    const trip = plan.trips[tripIndex];
    const stopIndex = trip.stops.findIndex((stop) => stop.id === stopId);
    if (stopIndex >= 0) return { trip, stop: trip.stops[stopIndex], tripIndex, stopIndex };
  }
  return undefined;
}

/** Une tournée terminée ne se modifie plus ; un arrêt livré ou sauté ne se déplace plus (L5-14). */
export const isTripEditable = (trip: Trip): boolean => trip.status !== "completed";
export const isStopMovable = (trip: Trip, stop: Stop): boolean =>
  isTripEditable(trip) && stop.status === "pending";

function withStops(trip: Trip, stops: Stop[]): Trip {
  const renumbered = stops.map((stop, index) =>
    stop.seq === index + 1 ? stop : { ...stop, seq: index + 1 },
  );
  const planned = renumbered.reduce((sum, stop) => sum + stop.planned_l, 0);
  return {
    ...trip,
    stops: renumbered,
    planned_l: planned,
    fill_rate: trip.truck_capacity_l ? planned / trip.truck_capacity_l : trip.fill_rate,
  };
}

/** État optimiste après l'opération. Renvoie le plan inchangé si l'opération ne s'applique pas. */
export function applyOp(plan: Plan, op: EditOp): Plan {
  switch (op.type) {
    case "move": {
      const from = findStop(plan, op.stopId);
      const target = findTrip(plan, op.toTripId);
      if (!from || !target || from.trip.id !== op.tripId) return plan;
      if (target.id === from.trip.id) {
        const stops = from.trip.stops.filter((stop) => stop.id !== op.stopId);
        stops.splice(Math.max(0, Math.min(op.toSeq - 1, stops.length)), 0, from.stop);
        return replaceTrip(plan, withStops(from.trip, stops));
      }
      const sourceStops = from.trip.stops.filter((stop) => stop.id !== op.stopId);
      const targetStops = [...target.stops];
      targetStops.splice(Math.max(0, Math.min(op.toSeq - 1, targetStops.length)), 0, from.stop);
      const trips = plan.trips
        .map((trip) =>
          trip.id === from.trip.id
            ? withStops(trip, sourceStops)
            : trip.id === target.id
              ? withStops(trip, targetStops)
              : trip,
        )
        // Une tournée vidée de son dernier arrêt est supprimée du plan (L5-10).
        .filter((trip) => trip.stops.length > 0);
      return { ...plan, trips };
    }
    case "reorder": {
      const trip = findTrip(plan, op.tripId);
      if (!trip) return plan;
      const byId = new Map(trip.stops.map((stop) => [stop.id, stop]));
      const stops = op.stopIds.map((id) => byId.get(id)).filter((stop): stop is Stop => !!stop);
      if (stops.length !== trip.stops.length) return plan;
      return replaceTrip(plan, withStops(trip, stops));
    }
    case "assign": {
      const trip = findTrip(plan, op.tripId);
      if (!trip) return plan;
      let next: Trip = trip;
      if (op.truck) {
        const capacity = op.truck.capacity_l ?? null;
        next = {
          ...next,
          truck_id: op.truck.id,
          truck_plate: op.truck.plate,
          truck_size: op.truck.size ?? null,
          truck_capacity_l: capacity,
          fill_rate: capacity ? next.planned_l / capacity : null,
          // Le plan de chargement dépend des compartiments du nouveau camion : recalculé par le serveur.
          loads: [],
        };
      }
      if (op.driver !== undefined) {
        next = {
          ...next,
          driver_id: op.driver?.id ?? null,
          driver_name: op.driver?.name ?? null,
          driver_phone: op.driver?.phone ?? null,
        };
      }
      return replaceTrip(plan, next);
    }
    case "lock": {
      const trip = findTrip(plan, op.tripId);
      return trip ? replaceTrip(plan, { ...trip, locked: op.locked }) : plan;
    }
  }
}

function replaceTrip(plan: Plan, next: Trip): Plan {
  return { ...plan, trips: plan.trips.map((trip) => (trip.id === next.id ? next : trip)) };
}

/** Route et corps de l'appel correspondant à l'opération (spec §9). */
export function opRequest(planId: string, op: EditOp): { path: string; body?: unknown } {
  const base = `/plans/${planId}/trips/${op.tripId}`;
  switch (op.type) {
    case "move":
      return {
        path: `${base}/move-stop`,
        body: { stop_id: op.stopId, to_trip_id: op.toTripId, to_seq: op.toSeq },
      };
    case "reorder":
      return { path: `${base}/reorder`, body: { stop_ids: op.stopIds } };
    case "assign": {
      const body: Record<string, string | null> = {};
      if (op.truck) body.truck_id = op.truck.id;
      if (op.driver !== undefined) body.driver_id = op.driver?.id ?? null;
      return { path: `${base}/assign`, body };
    }
    case "lock":
      return { path: `${base}/${op.locked ? "lock" : "unlock"}` };
  }
}

/**
 * Déplacement d'un arrêt d'un cran au clavier (Alt + ↑ / ↓) : dans sa tournée, ou — au bord — vers la
 * tournée voisine (fin de la précédente, début de la suivante). `null` si le déplacement est impossible.
 */
export function keyboardMove(plan: Plan, stopId: string, direction: "up" | "down"): EditOp | null {
  const at = findStop(plan, stopId);
  if (!at || !isStopMovable(at.trip, at.stop)) return null;
  const { trip, stopIndex, tripIndex } = at;
  const target = direction === "up" ? stopIndex - 1 : stopIndex + 1;
  if (target >= 0 && target < trip.stops.length) {
    const ids = trip.stops.map((stop) => stop.id);
    ids.splice(stopIndex, 1);
    ids.splice(target, 0, stopId);
    return { type: "reorder", tripId: trip.id, stopIds: ids };
  }
  const step = direction === "up" ? -1 : 1;
  for (let index = tripIndex + step; index >= 0 && index < plan.trips.length; index += step) {
    const neighbour = plan.trips[index];
    if (!isTripEditable(neighbour)) continue;
    return {
      type: "move",
      tripId: trip.id,
      stopId,
      toTripId: neighbour.id,
      toSeq: direction === "up" ? neighbour.stops.length + 1 : 1,
    };
  }
  return null;
}

/** Opération correspondant au dépôt d'un arrêt sur un autre arrêt (insertion à sa place) ou sur une tournée (en fin). */
export function dropOp(
  plan: Plan,
  stopId: string,
  over: { type: "stop"; stopId: string } | { type: "trip"; tripId: string },
): EditOp | null {
  const from = findStop(plan, stopId);
  if (!from || !isStopMovable(from.trip, from.stop)) return null;
  if (over.type === "trip") {
    const target = findTrip(plan, over.tripId);
    if (!target || target.id === from.trip.id || !isTripEditable(target)) return null;
    return {
      type: "move",
      tripId: from.trip.id,
      stopId,
      toTripId: target.id,
      toSeq: target.stops.length + 1,
    };
  }
  const to = findStop(plan, over.stopId);
  if (!to || to.stop.id === stopId || !isTripEditable(to.trip)) return null;
  if (to.trip.id === from.trip.id) {
    const ids = from.trip.stops.map((stop) => stop.id);
    ids.splice(from.stopIndex, 1);
    ids.splice(to.stopIndex, 0, stopId);
    return { type: "reorder", tripId: from.trip.id, stopIds: ids };
  }
  return { type: "move", tripId: from.trip.id, stopId, toTripId: to.trip.id, toSeq: to.stopIndex + 1 };
}

/**
 * Après une modification d'un plan publié, le serveur renvoie une NOUVELLE version : nouveaux identifiants
 * de tournées et d'arrêts (L5-4). Retrouve dans `next` la tournée et l'arrêt équivalents à la sélection.
 */
export function remapSelection(
  previous: Plan | null,
  next: Plan,
  selection: { tripId: string | null; stopId: string | null },
): { tripId: string | null; stopId: string | null } {
  const stopAt = findStop(previous, selection.stopId);
  let stop: StopLocation | undefined = findStop(next, selection.stopId);
  if (!stop && stopAt) {
    const orders = new Set(stopAt.stop.deliveries.map((delivery) => delivery.order_id));
    for (const trip of next.trips) {
      const match = trip.stops.find(
        (candidate) =>
          candidate.station_id === stopAt.stop.station_id &&
          candidate.deliveries.some((delivery) => orders.has(delivery.order_id)),
      );
      if (match) {
        stop = findStop(next, match.id);
        break;
      }
    }
  }
  if (stop) return { tripId: stop.trip.id, stopId: stop.stop.id };
  const tripBefore = findTrip(previous, selection.tripId);
  const trip =
    findTrip(next, selection.tripId) ??
    (tripBefore ? next.trips.find((candidate) => candidate.seq === tripBefore.seq) : undefined);
  return { tripId: trip?.id ?? null, stopId: null };
}

const isOpenOrder = (order: Plan["unserved"][number]): boolean =>
  order.order_status !== "postponed" && order.order_status !== "cancelled";

/**
 * Met le plan lu en cohérence avec l'état des commandes (RM-15, L5-20).
 *
 * Constat sur l'API : après `POST /orders/{id}/postpone`, `GET /plans/{id}` renvoie la commande comme
 * `postponed` dans `unserved`, mais garde la violation RM-15 enregistrée (et `blocking_count`,
 * `publishable`) jusqu'au prochain recontrôle — que seule une modification ou la publication déclenche.
 * Sans correction, le bouton Publier resterait désactivé alors que le serveur accepterait la publication.
 * On retire donc les violations RM-15 en trop par rapport aux commandes urgentes encore à traiter ; le
 * serveur reste seul juge à la publication (409 `rule_violation`).
 */
export function reconcileUrgentViolations(plan: Plan): Plan {
  const stale = plan.violations.filter((violation) => violation.rule_code === "RM-15" && !violation.trip_id);
  const openUrgent = plan.unserved.filter((order) => order.priority === "urgent" && isOpenOrder(order));
  if (stale.length <= openUrgent.length) return plan;
  const codes = openUrgent.map((order) => order.station_code).filter((code): code is string => !!code);
  const mentioned = stale.filter((violation) => codes.some((code) => violation.message.includes(code)));
  const kept = new Set(
    (mentioned.length >= openUrgent.length ? mentioned : stale).slice(0, openUrgent.length).map((v) => v.id),
  );
  const violations = plan.violations.filter(
    (violation) => !stale.includes(violation) || kept.has(violation.id),
  );
  const blocking = violations.filter((violation) => violation.severity === "blocking").length;
  return {
    ...plan,
    violations,
    blocking_count: blocking,
    publishable: plan.status === "draft" && plan.kind === "computed" && blocking === 0,
  };
}
