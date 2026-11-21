/**
 * Doublures MSW de l'écran Chargement, fidèles aux routes réelles du lot L6 (`backend/app/loading/`) :
 * mêmes formes, mêmes codes d'erreur (`loading_missing`, `invalid_transition`, `loading_locked`…).
 * Branchées dans les tests par `server.use(...createLoadingMocks(day).handlers)`.
 */
import { http, HttpResponse } from "msw";

import type { IsoDate } from "@/lib/types";
import { db } from "@/mocks/db";
import { API, authenticate, authorize, errorResponse, notFound } from "@/mocks/handlers/helpers";

import { LOADING_EDITABLE, TRIP_FLOW } from "./api";
import type { Loading, LoadingInput, Plan, PlanTrip, TripLoading, TripStatusInput } from "./api";
import { computeGap, volumeAt15 } from "./conversion";

const TOLERANCE = 2;
const NOTE =
  "volume corrigé à 15 °C selon coefficient de dilatation, tables ASTM non appliquées dans le prototype";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export interface LoadingMocks {
  handlers: ReturnType<typeof http.get>[];
  trips: TripLoading[];
  plan: Plan;
  loadings: Map<string, Loading>;
  /** Corps des requêtes d'écriture reçues, pour les vérifications des tests. */
  requests: { method: string; path: string; body: unknown }[];
  sentEmails: string[][];
}

export function createLoadingMocks(day: IsoDate): LoadingMocks {
  const product = (code: string) => db.products.find((item) => item.code === code) ?? db.products[0];
  const depot = db.depots[0];
  const at = (hm: string) => `${day}T${hm}:00Z`;
  const stations = db.stations.slice(0, 4);
  const planId = id(900);

  const planTrip = (
    seq: number,
    plate: string,
    driver: string,
    loads: [number, number, string, number][],
    stopStations: number[],
  ): PlanTrip =>
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
      planned_start_at: at(seq === 1 ? "05:00" : "05:30"),
      planned_depart_at: at(seq === 1 ? "07:15" : "07:45"),
      planned_return_at: at("11:30"),
      distance_m: 18400 + seq * 2100,
      duration_s: 14400,
      locked: false,
      status: "planned",
      planned_l: loads.reduce((sum, load) => sum + load[3], 0),
      blocking_count: 0,
      warning_count: 0,
      loads: loads.map(([position, capacity, code, planned], index) => ({
        id: id(seq * 1000 + index),
        compartment_id: id(seq * 1000 + 500 + position),
        compartment_position: position,
        capacity_l: capacity,
        product_id: product(code).id,
        product_code: product(code).code,
        product_label: product(code).label,
        product_color: product(code).color,
        planned_l: planned,
      })),
      stops: stopStations.map((stationIndex, index) => ({
        id: id(seq * 1000 + 800 + index),
        seq: index + 1,
        station_id: stations[stationIndex].id,
        station_code: stations[stationIndex].code,
        station_name: stations[stationIndex].name,
        planned_arrival_at: at(`0${8 + index}:10`),
        planned_departure_at: at(`0${8 + index}:50`),
        distance_from_prev_m: 5200,
        status: "pending",
        planned_l: 10000,
        deliveries: [],
      })),
    }) as PlanTrip;

  const planTrips = [
    planTrip(
      1,
      "LT 482 AB",
      "Jean-Paul Mbarga",
      [
        [1, 12000, "SUPER", 12000],
        [2, 10000, "SUPER", 9000],
        [3, 8000, "GASOIL", 8000],
      ],
      [0, 1],
    ),
    planTrip(
      2,
      "LT 120 GH",
      "Aminatou Bello",
      [
        [1, 11000, "GASOIL", 11000],
        [2, 11000, "GASOIL", 10000],
      ],
      [2, 3],
    ),
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

  const trips: TripLoading[] = planTrips.map((trip) => ({
    id: trip.id,
    plan_id: planId,
    plan_version: 1,
    plan_label: null,
    day,
    seq: trip.seq,
    status: "planned",
    truck_id: trip.truck_id,
    truck_plate: trip.truck_plate ?? null,
    driver_id: trip.driver_id ?? null,
    driver_name: trip.driver_name ?? null,
    depot_id: trip.depot_id,
    depot_code: trip.depot_code ?? null,
    depot_name: trip.depot_name ?? null,
    planned_start_at: trip.planned_start_at ?? null,
    planned_depart_at: trip.planned_depart_at ?? null,
    planned_return_at: trip.planned_return_at ?? null,
    actual_depart_at: null,
    actual_return_at: null,
    distance_m: trip.distance_m,
    actual_distance_m: null,
    planned_total_l: trip.planned_l,
    stop_count: trip.stops.length,
    stops_done: 0,
    loading_recorded: false,
    loading: null,
  }));
  const loadings = new Map<string, Loading>();
  const requests: LoadingMocks["requests"] = [];
  const sentEmails: string[][] = [];

  const buildLoading = (trip: TripLoading, input: LoadingInput, userName: string): Loading => {
    const loads = planTrips.find((item) => item.id === trip.id)?.loads ?? [];
    const lines = input.lines.map((line, index) => {
      const load = loads.find((item) => item.compartment_id === line.compartment_id);
      const item = db.products.find((p) => p.id === line.product_id);
      const at15 = volumeAt15(line.observed_l, line.observed_temp_c, item?.thermal_coeff ?? 0);
      const gap = computeGap(at15, load?.planned_l ?? 0, TOLERANCE);
      return {
        id: id(50000 + index),
        compartment_id: line.compartment_id,
        compartment_position: load?.compartment_position ?? null,
        product_id: line.product_id,
        product_code: item?.code ?? null,
        product_label: item?.label ?? null,
        observed_l: line.observed_l,
        observed_temp_c: line.observed_temp_c,
        observed_density: line.observed_density ?? null,
        volume_15_l: at15,
        planned_l: load?.planned_l ?? null,
        gap_l: gap.gapL,
        gap_pct: gap.gapPct,
        // Décomposition de l'écart comme le serveur : température (15 °C − observé) + volume (observé − planifié).
        gap_temperature_l: at15 - line.observed_l,
        gap_temperature_pct: load?.planned_l ? ((at15 - line.observed_l) / load.planned_l) * 100 : null,
        gap_observed_l: load?.planned_l != null ? line.observed_l - load.planned_l : null,
        gap_observed_pct: load?.planned_l
          ? ((line.observed_l - load.planned_l) / load.planned_l) * 100
          : null,
        out_of_tolerance: gap.outOfTolerance === true,
      };
    });
    const missing = loads.filter(
      (load) => !lines.some((line) => line.compartment_id === load.compartment_id),
    );
    const at15Total = lines.reduce((sum, line) => sum + line.volume_15_l, 0);
    const observedTotal = lines.reduce((sum, line) => sum + line.observed_l, 0);
    const total = computeGap(at15Total, trip.planned_total_l, TOLERANCE);
    const out =
      total.outOfTolerance === true || missing.length > 0 || lines.some((line) => line.out_of_tolerance);
    return {
      id: id(60000 + trip.seq),
      trip_id: trip.id,
      depot_id: trip.depot_id,
      depot_code: trip.depot_code,
      arrived_at: input.arrived_at ?? null,
      started_at: input.started_at ?? null,
      finished_at: input.finished_at ?? null,
      depot_ticket_no: input.depot_ticket_no ?? null,
      entered_by: null,
      entered_by_name: userName,
      lines,
      observed_total_l: lines.reduce((sum, line) => sum + line.observed_l, 0),
      volume_15_total_l: at15Total,
      planned_total_l: trip.planned_total_l,
      gap_l: total.gapL,
      gap_pct: total.gapPct,
      gap_temperature_l: at15Total - observedTotal,
      gap_temperature_pct: trip.planned_total_l
        ? ((at15Total - observedTotal) / trip.planned_total_l) * 100
        : null,
      gap_observed_l: observedTotal - trip.planned_total_l,
      gap_observed_pct: trip.planned_total_l
        ? ((observedTotal - trip.planned_total_l) / trip.planned_total_l) * 100
        : null,
      gap_explanation: out
        ? "Écart dû en partie à la correction de température, en partie au volume observé."
        : null,
      tolerance_pct: TOLERANCE,
      out_of_tolerance: out,
      warning_message: out
        ? "Écart entre volume chargé à 15 °C et volume planifié au-delà de la tolérance (2 %)."
        : null,
      conversion_note: NOTE,
    };
  };

  const findTrip = (tripId: unknown) => trips.find((trip) => trip.id === tripId);
  const WRITERS = ["fleet", "dispatcher"] as const;

  const handlers = [
    http.get(`${API}/loadings`, ({ request }) => {
      const user = authenticate(request);
      if (user instanceof Response) return user;
      const url = new URL(request.url);
      const depotId = url.searchParams.get("depot_id");
      const items =
        url.searchParams.get("day") === day ? trips.filter((t) => !depotId || t.depot_id === depotId) : [];
      return HttpResponse.json({ items, total: items.length, limit: 200, offset: 0 });
    }),
    http.get(`${API}/plans/:planId`, ({ request, params }) => {
      const user = authenticate(request);
      if (user instanceof Response) return user;
      if (params.planId !== planId) return notFound("Plan");
      for (const trip of planTrips) trip.status = findTrip(trip.id)?.status ?? trip.status;
      return HttpResponse.json(plan);
    }),
    http.get(`${API}/stations`, ({ request }) => {
      const user = authenticate(request);
      if (user instanceof Response) return user;
      // Les stations fictives du socle n'ont pas d'adresse : on en donne une aux arrêts de la tournée 1.
      const items = db.stations.map((station, index) => ({
        ...station,
        contact_email: index === 0 ? "akwa@ola.example" : station.contact_email,
      }));
      return HttpResponse.json({ items, total: items.length, limit: 200, offset: 0 });
    }),
    http.get(`${API}/trips/:tripId/loading`, ({ request, params }) => {
      const user = authenticate(request);
      if (user instanceof Response) return user;
      const loading = loadings.get(String(params.tripId));
      return loading
        ? HttpResponse.json(loading)
        : errorResponse(404, "loading_not_found", "Aucun chargement enregistré pour cette tournée.");
    }),
    http.post(`${API}/trips/:tripId/loading`, async ({ request, params }) => {
      const user = authorize(request, [...WRITERS]);
      if (user instanceof Response) return user;
      const trip = findTrip(params.tripId);
      if (!trip) return notFound("Tournée");
      const input = (await request.json()) as LoadingInput;
      requests.push({ method: "POST", path: `/trips/${trip.id}/loading`, body: input });
      if (!LOADING_EDITABLE.includes(trip.status)) {
        return errorResponse(
          409,
          "loading_locked",
          "Le chargement n'est plus modifiable : la tournée est en cours.",
        );
      }
      const loading = buildLoading(trip, input, user.full_name);
      loadings.set(trip.id, loading);
      trip.loading_recorded = true;
      trip.loading = {
        id: loading.id,
        arrived_at: loading.arrived_at,
        started_at: loading.started_at,
        finished_at: loading.finished_at,
        depot_ticket_no: loading.depot_ticket_no,
        observed_total_l: loading.observed_total_l,
        volume_15_total_l: loading.volume_15_total_l,
        gap_l: loading.gap_l,
        gap_pct: loading.gap_pct,
        out_of_tolerance: loading.out_of_tolerance,
      };
      return HttpResponse.json(loading);
    }),
    http.put(`${API}/trips/:tripId/status`, async ({ request, params }) => {
      const user = authorize(request, [...WRITERS]);
      if (user instanceof Response) return user;
      const trip = findTrip(params.tripId);
      if (!trip) return notFound("Tournée");
      const input = (await request.json()) as TripStatusInput;
      requests.push({ method: "PUT", path: `/trips/${trip.id}/status`, body: input });
      const expected = TRIP_FLOW[TRIP_FLOW.indexOf(trip.status) + 1];
      if (input.status !== expected) {
        return errorResponse(
          409,
          "invalid_transition",
          `Transition de statut interdite : « ${trip.status} » → « ${input.status} » (seule transition possible : « ${expected} »).`,
        );
      }
      if (input.status === "loaded" && !trip.loading_recorded) {
        return errorResponse(
          409,
          "loading_missing",
          "Le chargement doit être enregistré avant de passer la tournée à « chargée ».",
        );
      }
      if (input.status === "in_progress")
        trip.actual_depart_at = input.actual_depart_at ?? new Date().toISOString();
      trip.status = input.status;
      return HttpResponse.json(trip);
    }),
    http.get(`${API}/trips/:tripId/loading-sheet.pdf`, ({ request, params }) => {
      const user = authenticate(request);
      if (user instanceof Response) return user;
      if (!loadings.has(String(params.tripId))) {
        return errorResponse(
          409,
          "loading_missing",
          "La fiche de chargement n'existe qu'une fois le chargement enregistré.",
        );
      }
      return new HttpResponse("%PDF-1.4 fiche", {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'inline; filename="fiche-chargement-LT482AB.pdf"',
        },
      });
    }),
    http.post(`${API}/trips/:tripId/loading-sheet/email`, async ({ request, params }) => {
      const user = authorize(request, [...WRITERS]);
      if (user instanceof Response) return user;
      const body = (await request.json().catch(() => ({}))) as { recipients?: string[] | null };
      requests.push({ method: "POST", path: `/trips/${String(params.tripId)}/loading-sheet/email`, body });
      const recipients = body.recipients ?? [];
      if (recipients.length === 0) {
        return errorResponse(
          422,
          "no_recipient",
          "Aucun destinataire : aucune station de la tournée n'a d'adresse.",
        );
      }
      sentEmails.push(recipients);
      return HttpResponse.json({ sent_to: recipients, stations_without_email: [] });
    }),
  ];

  return { handlers, trips, plan, loadings, requests, sentEmails };
}
