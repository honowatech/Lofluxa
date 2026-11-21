/**
 * Doublures MSW de l'écran Suivi des livraisons, fidèles aux routes réelles du lot L6 :
 * `GET /loadings`, `GET /plans/{id}`, `PUT /stops/{id}/delivery`, `PUT /trips/{id}/status`
 * et leurs refus (`trip_not_in_progress`, `invalid_order_transition`, `stops_pending`…).
 */
import { http, HttpResponse } from "msw";

import type { IsoDate } from "@/lib/types";
import { db } from "@/mocks/db";
import { API, authenticate, authorize, errorResponse, notFound } from "@/mocks/handlers/helpers";

import { TRIP_FLOW } from "./api";
import type { Plan, PlanStop, PlanTrip, StopDeliveryInput, TripStatusInput, TripSummary } from "./api";

const id = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;

export interface DeliveryMocks {
  handlers: ReturnType<typeof http.get>[];
  trips: TripSummary[];
  plan: Plan;
  stop: (tripSeq: number, stopSeq: number) => PlanStop;
  requests: { method: string; path: string; body: unknown }[];
}

export function createDeliveryMocks(day: IsoDate): DeliveryMocks {
  const product = (code: string) => db.products.find((item) => item.code === code) ?? db.products[0];
  const depot = db.depots[0];
  const at = (hm: string) => `${day}T${hm}:00Z`;
  const planId = id(900);
  let counter = 1000;

  const stop = (seq: number, stationIndex: number, arrival: string, lines: [string, number][]): PlanStop =>
    ({
      id: id((counter += 1)),
      seq,
      station_id: db.stations[stationIndex].id,
      station_code: db.stations[stationIndex].code,
      station_name: db.stations[stationIndex].name,
      station_city: db.stations[stationIndex].city,
      planned_arrival_at: at(arrival),
      planned_departure_at: at(arrival.replace(/:\d\d$/, ":50")),
      distance_from_prev_m: 5200,
      status: "pending",
      actual_arrival_at: null,
      actual_departure_at: null,
      skip_reason: null,
      planned_l: lines.reduce((sum, line) => sum + line[1], 0),
      deliveries: lines.map(([code, planned]) => ({
        id: id((counter += 1)),
        order_id: id((counter += 1)),
        product_id: product(code).id,
        product_code: product(code).code,
        product_label: product(code).label,
        product_color: product(code).color,
        planned_l: planned,
        actual_l: null,
        order_status: "loaded",
      })),
    }) as PlanStop;

  const trip = (seq: number, plate: string, driver: string, status: PlanTrip["status"], stops: PlanStop[]) =>
    ({
      id: id(seq),
      seq,
      truck_id: id(100 + seq),
      truck_plate: plate,
      driver_id: id(200 + seq),
      driver_name: driver,
      depot_id: depot.id,
      depot_code: depot.code,
      depot_name: depot.name,
      planned_start_at: at("05:00"),
      planned_depart_at: at("07:15"),
      planned_return_at: at("11:30"),
      actual_depart_at: status === "in_progress" ? at("07:22") : null,
      distance_m: 24600,
      duration_s: 15300,
      locked: false,
      status,
      planned_l: stops.reduce((sum, item) => sum + item.planned_l, 0),
      blocking_count: 0,
      warning_count: 0,
      loads: [],
      stops,
    }) as PlanTrip;

  const planTrips = [
    trip(1, "LT 482 AB", "Jean-Paul Mbarga", "in_progress", [
      stop(1, 0, "07:40", [
        ["SUPER", 12000],
        ["GASOIL", 8000],
      ]),
      stop(2, 1, "08:35", [["SUPER", 9000]]),
    ]),
    trip(2, "LT 120 GH", "Aminatou Bello", "loaded", [stop(1, 2, "08:10", [["GASOIL", 11000]])]),
  ];
  const plan = {
    id: planId,
    day,
    kind: "computed",
    status: "published",
    version: 1,
    approximate: false,
    blocking_count: 0,
    warning_count: 0,
    publishable: false,
    created_at: at("04:00"),
    updated_at: at("04:10"),
    trips: planTrips,
    unserved: [],
    violations: [],
  } as unknown as Plan;

  const summary = (item: PlanTrip): TripSummary => ({
    id: item.id,
    plan_id: planId,
    day,
    seq: item.seq,
    status: item.status,
    truck_id: item.truck_id,
    truck_plate: item.truck_plate ?? null,
    driver_id: item.driver_id ?? null,
    driver_name: item.driver_name ?? null,
    depot_id: item.depot_id,
    depot_code: item.depot_code ?? null,
    depot_name: item.depot_name ?? null,
    planned_start_at: item.planned_start_at ?? null,
    planned_depart_at: item.planned_depart_at ?? null,
    planned_return_at: item.planned_return_at ?? null,
    actual_depart_at: item.actual_depart_at ?? null,
    actual_return_at: item.actual_return_at ?? null,
    distance_m: item.distance_m,
    actual_distance_m: item.actual_distance_m ?? null,
    planned_total_l: item.planned_l,
    stop_count: item.stops.length,
    stops_done: item.stops.filter((s) => s.status !== "pending").length,
    loading_recorded: item.status !== "planned",
    loading: null,
  });
  const requests: DeliveryMocks["requests"] = [];
  const WRITERS = ["fleet", "dispatcher"] as const;

  const handlers = [
    http.get(`${API}/loadings`, ({ request }) => {
      const user = authenticate(request);
      if (user instanceof Response) return user;
      const items = new URL(request.url).searchParams.get("day") === day ? planTrips.map(summary) : [];
      return HttpResponse.json({ items, total: items.length, limit: 200, offset: 0 });
    }),
    http.get(`${API}/plans/:planId`, ({ request, params }) => {
      const user = authenticate(request);
      if (user instanceof Response) return user;
      return params.planId === planId ? HttpResponse.json(plan) : notFound("Plan");
    }),
    http.put(`${API}/stops/:stopId/delivery`, async ({ request, params }) => {
      const user = authorize(request, [...WRITERS]);
      if (user instanceof Response) return user;
      const owner = planTrips.find((item) => item.stops.some((s) => s.id === params.stopId));
      const target = owner?.stops.find((s) => s.id === params.stopId);
      if (!owner || !target) return notFound("Arrêt");
      const input = (await request.json()) as StopDeliveryInput;
      requests.push({ method: "PUT", path: `/stops/${target.id}/delivery`, body: input });
      if (owner.status !== "in_progress") {
        return errorResponse(
          409,
          "trip_not_in_progress",
          "Une livraison se saisit sur une tournée en cours (la tournée est chargée).",
        );
      }
      if (input.skip_reason) {
        if (target.status === "delivered") {
          return errorResponse(
            409,
            "invalid_order_transition",
            "Transition interdite : une commande « delivered » ne peut pas revenir à « confirmed ».",
          );
        }
        target.status = "skipped";
        target.skip_reason = input.skip_reason;
        for (const line of target.deliveries) {
          line.actual_l = null;
          line.order_status = "confirmed";
        }
      } else {
        target.status = "delivered";
        target.skip_reason = null;
        for (const line of target.deliveries) {
          line.actual_l = input.deliveries?.find((d) => d.order_id === line.order_id)?.actual_l ?? 0;
          line.order_status = line.actual_l > 0 ? "delivered" : "confirmed";
        }
      }
      target.actual_arrival_at = input.actual_arrival_at ?? null;
      target.actual_departure_at = input.actual_departure_at ?? null;
      return HttpResponse.json({
        ...target,
        trip_id: owner.id,
        trip_status: owner.status,
        trip_all_stops_done: owner.stops.every((s) => s.status !== "pending"),
      });
    }),
    http.put(`${API}/trips/:tripId/status`, async ({ request, params }) => {
      const user = authorize(request, [...WRITERS]);
      if (user instanceof Response) return user;
      const target = planTrips.find((item) => item.id === params.tripId);
      if (!target) return notFound("Tournée");
      const input = (await request.json()) as TripStatusInput;
      requests.push({ method: "PUT", path: `/trips/${target.id}/status`, body: input });
      if (input.status !== TRIP_FLOW[TRIP_FLOW.indexOf(target.status) + 1]) {
        return errorResponse(409, "invalid_transition", "Transition de statut interdite.");
      }
      const pending = target.stops.filter((s) => s.status === "pending");
      if (input.status === "completed" && pending.length > 0) {
        return errorResponse(
          409,
          "stops_pending",
          `La tournée ne peut pas être terminée : ${pending.length} arrêt(s) ni livré(s) ni sauté(s).`,
        );
      }
      target.status = input.status;
      target.actual_return_at = input.actual_return_at ?? new Date().toISOString();
      target.actual_distance_m = input.actual_distance_m ?? null;
      return HttpResponse.json(summary(target));
    }),
  ];

  return {
    handlers,
    trips: planTrips.map(summary),
    plan,
    stop: (tripSeq, stopSeq) => planTrips[tripSeq - 1].stops[stopSeq - 1],
    requests,
  };
}
