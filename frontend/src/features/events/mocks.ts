/**
 * Doublures MSW de l'écran « Journal des événements » (routes du lot L10, non livrées) et jeu de données
 * réaliste réutilisable (tests Vitest, captures d'écran).
 *
 * Fidèles à la spec §9 (corps des POST à la lettre) et au modèle `backend/app/events/models.py`
 * (id, day, plan_id, trip_id, type, payload, occurred_at, actor_id). Les réponses des POST et la route
 * des options de remplacement sont des formes SUPPOSÉES, décrites dans `api.ts`.
 *
 *   server.use(...eventsHandlers(createEventsScenario(day)));
 *
 * Données brutes (objets JSON simples, sans MSW) : `sampleEvents(day)`, `samplePlan(day)`,
 * `sampleReplacementOptions()` — utilisables par `page.route` dans Playwright.
 */
import { http, HttpResponse } from "msw";

import { dayBoundsUtc } from "@/lib/format";
import type { IsoDate } from "@/lib/types";

import type { PlanOut, TripOut } from "./api";

const API = "*/api/v1";

/** Identifiants de référence (remplaçables par ceux d'une base réelle ou des doublures communes). */
export interface SampleRefs {
  depot: { id: string; code: string; name: string };
  products: Record<"SUPER" | "GASOIL" | "PETROLE", string>;
}
export const DEFAULT_REFS: SampleRefs = {
  depot: { id: "0e000000-0000-7000-8000-00000000d001", code: "SCDP-DLA", name: "SCDP Douala" },
  products: {
    SUPER: "0e000000-0000-7000-8000-00000000a001",
    GASOIL: "0e000000-0000-7000-8000-00000000a002",
    PETROLE: "0e000000-0000-7000-8000-00000000a003",
  },
};

const uid = (kind: string, n: number) => `0e000000-0000-7000-8000-${kind}${String(n).padStart(8, "0")}`;
export const SAMPLE_PLAN_ID = uid("0001", 1);
export const SAMPLE_NEW_PLAN_ID = uid("0001", 2);
export const SAMPLE_TRIP_IDS = [uid("0002", 1), uid("0002", 2), uid("0002", 3)] as const;
const ACTORS = {
  dispatcher: { id: uid("0009", 1), name: "Serge Mbarga" },
  fleet: { id: uid("0009", 2), name: "Brigitte Ngo Bassa" },
  supply: { id: uid("0009", 3), name: "Aïcha Njoya" },
};

/** Horodatage UTC d'une heure locale de Douala (`"07:15"`) du jour J. */
function at(day: IsoDate, hm: string): string {
  const [h, m] = hm.split(":").map(Number);
  return new Date(Date.parse(dayBoundsUtc(day).from) + (h * 60 + m) * 60_000).toISOString();
}

const LABELS = { SUPER: "Super", GASOIL: "Gasoil", PETROLE: "Pétrole lampant" } as const;
type ProductCode = keyof typeof LABELS;

interface StopSeed {
  code: string;
  name: string;
  arrival: string;
  status: "pending" | "delivered" | "skipped";
  lines: [ProductCode, number][];
}
interface TripSeed {
  plate: string;
  driver: string;
  status: TripOut["status"];
  depart: string;
  back: string;
  stops: StopSeed[];
}

const TRIPS: TripSeed[] = [
  {
    plate: "LT 782 KD",
    driver: "Alain Fotso",
    status: "in_progress",
    depart: "07:15",
    back: "10:40",
    stops: [
      {
        code: "ST-DEIDO",
        name: "OLA Deido",
        arrival: "07:35",
        status: "delivered",
        lines: [
          ["SUPER", 12000],
          ["GASOIL", 8000],
        ],
      },
      {
        code: "ST-BONAP",
        name: "OLA Bonapriso",
        arrival: "08:40",
        status: "pending",
        lines: [["SUPER", 9000]],
      },
      { code: "ST-AKWA", name: "OLA Akwa", arrival: "09:35", status: "pending", lines: [["GASOIL", 5000]] },
    ],
  },
  {
    plate: "LT 915 GH",
    driver: "Emmanuel Tchoua",
    status: "loaded",
    depart: "07:45",
    back: "11:30",
    stops: [
      {
        code: "ST-NDOKO",
        name: "OLA Ndokoti",
        arrival: "08:10",
        status: "pending",
        lines: [["SUPER", 10000]],
      },
      {
        code: "ST-LOGBA",
        name: "OLA Logbaba",
        arrival: "09:05",
        status: "pending",
        lines: [["GASOIL", 11000]],
      },
      { code: "ST-YASSA", name: "OLA Yassa", arrival: "10:00", status: "pending", lines: [["GASOIL", 8000]] },
    ],
  },
  {
    plate: "LT 334 BX",
    driver: "Rodrigue Essomba",
    status: "completed",
    depart: "06:30",
    back: "09:10",
    stops: [
      {
        code: "ST-BEPAN",
        name: "OLA Bépanda",
        arrival: "06:55",
        status: "delivered",
        lines: [
          ["GASOIL", 9000],
          ["PETROLE", 5000],
        ],
      },
      { code: "ST-MAKEP", name: "OLA Makepe", arrival: "07:50", status: "skipped", lines: [["SUPER", 9000]] },
    ],
  },
];

/** Plan publié du jour (forme `PlanOut` de l'API réelle), trois tournées à des stades différents. */
export function samplePlan(day: IsoDate, refs: SampleRefs = DEFAULT_REFS): PlanOut {
  let stopNo = 0;
  let lineNo = 0;
  const trips = TRIPS.map((seed, index): TripOut => {
    const perProduct = new Map<ProductCode, number>();
    const stops = seed.stops.map((stop, position) => {
      stopNo += 1;
      for (const [code, liters] of stop.lines) perProduct.set(code, (perProduct.get(code) ?? 0) + liters);
      return {
        id: uid("0003", stopNo),
        seq: position + 1,
        station_id: uid("0004", stopNo),
        station_code: stop.code,
        station_name: stop.name,
        station_city: "Douala",
        planned_arrival_at: at(day, stop.arrival),
        planned_departure_at: null,
        distance_from_prev_m: 6200,
        status: stop.status,
        actual_arrival_at: stop.status === "delivered" ? at(day, stop.arrival) : null,
        actual_departure_at: null,
        skip_reason: stop.status === "skipped" ? "Station fermée à l'arrivée" : null,
        planned_l: stop.lines.reduce((sum, [, liters]) => sum + liters, 0),
        deliveries: stop.lines.map(([code, liters]) => {
          lineNo += 1;
          return {
            id: uid("0005", lineNo),
            order_id: uid("0006", lineNo),
            product_id: refs.products[code],
            product_code: code,
            product_label: LABELS[code],
            planned_l: liters,
            actual_l: stop.status === "delivered" ? liters : null,
          };
        }),
      };
    });
    const planned = stops.reduce((sum, stop) => sum + stop.planned_l, 0);
    return {
      id: SAMPLE_TRIP_IDS[index],
      seq: index + 1,
      truck_id: uid("0007", index + 1),
      truck_plate: seed.plate,
      truck_size: "large",
      truck_capacity_l: 35000,
      driver_id: uid("0008", index + 1),
      driver_name: seed.driver,
      depot_id: refs.depot.id,
      depot_code: refs.depot.code,
      depot_name: refs.depot.name,
      planned_start_at: at(day, "06:00"),
      planned_depart_at: at(day, seed.depart),
      planned_return_at: at(day, seed.back),
      distance_m: 31400,
      duration_s: 12300,
      locked: false,
      status: seed.status,
      actual_depart_at:
        seed.status === "in_progress" || seed.status === "completed" ? at(day, seed.depart) : null,
      actual_return_at: seed.status === "completed" ? at(day, seed.back) : null,
      actual_distance_m: null,
      planned_l: planned,
      fill_rate: planned / 35000,
      blocking_count: 0,
      warning_count: 0,
      stops,
      loads: [...perProduct.entries()].map(([code, liters], position) => ({
        id: uid("000a", index * 10 + position),
        compartment_id: uid("000b", index * 10 + position),
        compartment_position: position + 1,
        capacity_l: 12000,
        product_id: refs.products[code],
        product_code: code,
        product_label: LABELS[code],
        planned_l: liters,
      })),
    };
  });
  return {
    id: SAMPLE_PLAN_ID,
    day,
    kind: "computed",
    status: "published",
    version: 1,
    root_plan_id: null,
    parent_plan_id: null,
    label: null,
    approximate: false,
    blocking_count: 0,
    warning_count: 1,
    publishable: false,
    created_at: at(day, "05:40"),
    updated_at: at(day, "05:52"),
    created_by: ACTORS.dispatcher.id,
    created_by_name: ACTORS.dispatcher.name,
    trips,
    unserved: [],
    violations: [],
  } as PlanOut;
}

/** Événement tel que le renvoie (par hypothèse) `GET /events` : colonnes du modèle + libellés. */
export interface SampleEvent {
  id: string;
  day: IsoDate;
  plan_id: string | null;
  trip_id: string | null;
  type: string;
  payload: Record<string, unknown>;
  occurred_at: string;
  actor_id: string | null;
  actor_name: string | null;
  trip_seq: number | null;
  truck_plate: string | null;
}

/** Journée type : publication, chargements (dont un écart RM-13), livraisons, arrêt sauté, panne, pénurie. */
export function sampleEvents(day: IsoDate, refs: SampleRefs = DEFAULT_REFS): SampleEvent[] {
  const [trip1, trip2, trip3] = SAMPLE_TRIP_IDS;
  let n = 0;
  const event = (
    time: string,
    type: string,
    actor: keyof typeof ACTORS,
    payload: Record<string, unknown>,
    trip: { id: string; seq: number; plate: string } | null = null,
    planId: string = SAMPLE_PLAN_ID,
  ): SampleEvent => ({
    id: uid("000e", (n += 1)),
    day,
    plan_id: planId,
    trip_id: trip?.id ?? null,
    type,
    payload,
    occurred_at: at(day, time),
    actor_id: ACTORS[actor].id,
    actor_name: ACTORS[actor].name,
    trip_seq: trip?.seq ?? null,
    truck_plate: trip?.plate ?? null,
  });
  const t1 = { id: trip1, seq: 1, plate: "LT 782 KD" };
  const t2 = { id: trip2, seq: 2, plate: "LT 915 GH" };
  const t3 = { id: trip3, seq: 3, plate: "LT 334 BX" };
  return [
    event(
      "05:48",
      "manual_edit",
      "dispatcher",
      {
        plan_version: 1,
        action: "move_stop",
        summary: "Arrêt OLA Akwa déplacé de la tournée n° 2 vers la tournée n° 1 (position 3).",
      },
      t1,
    ),
    event("05:52", "publish", "dispatcher", {
      plan_version: 1,
      action: "publish",
      summary: "Version 1 publiée.",
      archived_plan_id: null,
    }),
    event(
      "06:24",
      "loading_recorded",
      "fleet",
      {
        loading_id: uid("000c", 3),
        updated: false,
        depot_ticket_no: "BL-2231",
        volume_15_total_l: 22980.4,
        planned_total_l: 23000,
        gap_pct: -0.09,
        out_of_tolerance: false,
      },
      t3,
    ),
    event(
      "06:58",
      "delivery_recorded",
      "dispatcher",
      {
        stop_id: uid("0003", 7),
        seq: 1,
        station_code: "ST-BEPAN",
        status: "delivered",
        skip_reason: null,
        deliveries: [
          { order_id: uid("0006", 10), planned_l: 9000, actual_l: 9000 },
          { order_id: uid("0006", 11), planned_l: 5000, actual_l: 4950 },
        ],
      },
      t3,
    ),
    event(
      "07:08",
      "loading_recorded",
      "fleet",
      {
        loading_id: uid("000c", 1),
        updated: false,
        depot_ticket_no: "BL-2238",
        volume_15_total_l: 33105.75,
        planned_total_l: 34000,
        gap_pct: -2.63,
        out_of_tolerance: true,
      },
      t1,
    ),
    event(
      "07:38",
      "delivery_recorded",
      "dispatcher",
      {
        stop_id: uid("0003", 1),
        seq: 1,
        station_code: "ST-DEIDO",
        status: "delivered",
        skip_reason: null,
        deliveries: [
          { order_id: uid("0006", 1), planned_l: 12000, actual_l: 12000 },
          { order_id: uid("0006", 2), planned_l: 8000, actual_l: 8000 },
        ],
      },
      t1,
    ),
    event(
      "07:41",
      "loading_recorded",
      "fleet",
      {
        loading_id: uid("000c", 2),
        updated: true,
        depot_ticket_no: "BL-2241",
        volume_15_total_l: 28874.1,
        planned_total_l: 29000,
        gap_pct: -0.43,
        out_of_tolerance: false,
      },
      t2,
    ),
    event(
      "07:55",
      "delivery_recorded",
      "fleet",
      {
        stop_id: uid("0003", 8),
        seq: 2,
        station_code: "ST-MAKEP",
        status: "skipped",
        skip_reason: "Station fermée à l'arrivée",
        deliveries: [{ order_id: uid("0006", 12), planned_l: 9000, actual_l: null }],
      },
      t3,
    ),
    event(
      "08:12",
      "truck_breakdown",
      "dispatcher",
      {
        plan_version: 2,
        truck_plate: "LT 782 KD",
        replacement_truck_id: uid("0007", 9),
        replacement_truck_plate: "LT 608 EM",
        replacement_driver_id: null,
        replacement_driver_name: null,
        transferred_stop_count: 2,
        kept_stop_count: 1,
        new_plan_id: SAMPLE_NEW_PLAN_ID,
        new_plan_version: 2,
      },
      t1,
    ),
    event(
      "08:14",
      "replan",
      "dispatcher",
      {
        plan_version: 2,
        action: "recompute",
        summary:
          "Plan recalculé en conservant 2 tournée(s) figée(s) : 4 tournée(s), 0 commande(s) non servie(s).",
      },
      null,
      SAMPLE_NEW_PLAN_ID,
    ),
    event(
      "08:15",
      "publish",
      "dispatcher",
      {
        plan_version: 2,
        action: "publish",
        summary: "Version 2 publiée (la version 1 est archivée).",
        archived_plan_id: SAMPLE_PLAN_ID,
      },
      null,
      SAMPLE_NEW_PLAN_ID,
    ),
    event("08:47", "product_shortage", "supply", {
      depot_id: refs.depot.id,
      depot_code: refs.depot.code,
      product_id: refs.products.GASOIL,
      product_code: "GASOIL",
      product_label: "Gasoil",
      previous_available_l: 400000,
      new_available_l: 15000,
      impacted_trips: [{ trip_id: trip2, trip_seq: 2, truck_plate: "LT 915 GH", planned_l: 19000 }],
    }),
    event(
      "09:20",
      "driver_unavailable",
      "dispatcher",
      {
        plan_version: 3,
        driver_name: "Emmanuel Tchoua",
        replacement_driver_id: uid("0008", 9),
        replacement_driver_name: "Hervé Ndjock",
        transferred_stop_count: 3,
        kept_stop_count: 0,
        new_plan_id: uid("0001", 3),
        new_plan_version: 3,
      },
      t2,
      SAMPLE_NEW_PLAN_ID,
    ),
  ];
}

/** Réponse supposée de `GET /events/replacement-options`. */
export function sampleReplacementOptions() {
  return {
    trucks: [
      {
        id: uid("0007", 9),
        plate: "LT 608 EM",
        size: "medium",
        total_capacity_l: 20000,
        carrier_name: "OLA Flotte",
        suitable: true,
        reason: null,
      },
      {
        id: uid("0007", 8),
        plate: "LT 123 AB",
        size: "large",
        total_capacity_l: 33000,
        carrier_name: "Transcam",
        suitable: true,
        reason: null,
      },
      {
        id: uid("0007", 7),
        plate: "LT 456 CD",
        size: "small",
        total_capacity_l: 12000,
        carrier_name: "Transcam",
        suitable: false,
        reason: "En maintenance",
      },
    ],
    drivers: [
      {
        id: uid("0008", 9),
        full_name: "Hervé Ndjock",
        phone: "+237 677 10 20 33",
        suitable: true,
        reason: null,
      },
      {
        id: uid("0008", 8),
        full_name: "Jean Mbarga",
        phone: "+237 677 00 00 01",
        suitable: true,
        reason: null,
      },
      { id: uid("0008", 7), full_name: "Paul Atangana", phone: null, suitable: false, reason: "En repos" },
    ],
  };
}

/** État d'un scénario de doublures : données servies et requêtes reçues (pour les assertions). */
export interface EventsScenario {
  day: IsoDate;
  refs: SampleRefs;
  plan: PlanOut;
  events: SampleEvent[];
  options: ReturnType<typeof sampleReplacementOptions>;
  /** Corps JSON des POST reçus, par chemin (`/events/truck-breakdown`…). */
  received: { path: string; body: unknown }[];
  /** Requêtes d'options de remplacement reçues. */
  optionQueries: { trip_id: string | null; kind: string | null }[];
}

export function createEventsScenario(day: IsoDate, refs: SampleRefs = DEFAULT_REFS): EventsScenario {
  return {
    day,
    refs,
    plan: samplePlan(day, refs),
    events: sampleEvents(day, refs),
    options: sampleReplacementOptions(),
    received: [],
    optionQueries: [],
  };
}

const error = (status: number, code: string, message: string, details: unknown[] = []) =>
  HttpResponse.json({ code, message, details }, { status });

export function eventsHandlers(scenario: EventsScenario) {
  const findTrip = (id: unknown) => scenario.plan.trips.find((trip) => trip.id === id);
  const push = (type: string, payload: Record<string, unknown>, trip: TripOut | null, planId: string) => {
    const created: SampleEvent = {
      id: uid("000f", scenario.events.length + 1),
      day: scenario.day,
      plan_id: planId,
      trip_id: trip?.id ?? null,
      type,
      payload,
      occurred_at: new Date().toISOString(),
      actor_id: ACTORS.dispatcher.id,
      actor_name: ACTORS.dispatcher.name,
      trip_seq: trip?.seq ?? null,
      truck_plate: trip?.truck_plate ?? null,
    };
    scenario.events.push(created);
    return created;
  };

  const reassign = (kind: "truck" | "driver") =>
    http.post(
      `${API}/events/${kind === "truck" ? "truck-breakdown" : "driver-unavailable"}`,
      async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        scenario.received.push({ path: new URL(request.url).pathname.replace(/^.*\/api\/v1/, ""), body });
        const trip = findTrip(body.trip_id);
        if (!trip) return error(404, "not_found", "Tournée introuvable.");
        const pending = trip.stops.filter((stop) => stop.status === "pending");
        if (pending.length === 0) {
          return error(
            409,
            "no_pending_stop",
            "Aucun arrêt à transférer : tous les arrêts sont livrés ou sautés.",
            [
              {
                rule_code: "RM-19",
                severity: "blocking",
                message: "Seuls les arrêts « à livrer » sont transférables.",
                trip_id: trip.id,
              },
            ],
          );
        }
        const truck = scenario.options.trucks.find((item) => item.id === body.replacement_truck_id);
        const driver = scenario.options.drivers.find((item) => item.id === body.replacement_driver_id);
        if (kind === "truck" && !truck)
          return error(422, "validation_error", "Camion de remplacement inconnu.");
        if (kind === "driver" && !driver)
          return error(422, "validation_error", "Chauffeur de remplacement inconnu.");
        const payload = {
          plan_version: scenario.plan.version + 1,
          truck_plate: trip.truck_plate,
          driver_name: trip.driver_name,
          replacement_truck_id: truck?.id ?? null,
          replacement_truck_plate: truck?.plate ?? null,
          replacement_driver_id: driver?.id ?? null,
          replacement_driver_name: driver?.full_name ?? null,
          transferred_stop_count: pending.length,
          kept_stop_count: trip.stops.length - pending.length,
          new_plan_id: SAMPLE_NEW_PLAN_ID,
          new_plan_version: scenario.plan.version + 1,
        };
        const created = push(
          kind === "truck" ? "truck_breakdown" : "driver_unavailable",
          payload,
          trip,
          scenario.plan.id,
        );
        return HttpResponse.json(
          {
            event: created,
            plan: { id: SAMPLE_NEW_PLAN_ID, version: scenario.plan.version + 1, status: "draft" },
            transferred_stop_count: pending.length,
          },
          { status: 201 },
        );
      },
    );

  return [
    http.get(`${API}/events/replacement-options`, ({ request }) => {
      const url = new URL(request.url);
      scenario.optionQueries.push({
        trip_id: url.searchParams.get("trip_id"),
        kind: url.searchParams.get("kind"),
      });
      return HttpResponse.json(scenario.options);
    }),
    http.get(`${API}/events`, ({ request }) => {
      const url = new URL(request.url);
      const day = url.searchParams.get("day");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const items = scenario.events.filter((item) => !day || item.day === day);
      return HttpResponse.json({
        items: items.slice(offset, offset + limit),
        total: items.length,
        limit,
        offset,
      });
    }),
    reassign("truck"),
    reassign("driver"),
    http.post(`${API}/events/product-shortage`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      scenario.received.push({ path: "/events/product-shortage", body });
      const available = Number(body.new_available_l);
      const impacted = scenario.plan.trips
        .filter(
          (trip) =>
            trip.depot_id === body.depot_id &&
            (trip.status === "planned" || trip.status === "at_depot" || trip.status === "loaded"),
        )
        .map((trip) => ({
          trip,
          planned: trip.loads
            .filter((load) => load.product_id === body.product_id)
            .reduce((sum, load) => sum + load.planned_l, 0),
        }))
        .filter((item) => item.planned > available)
        .map((item) => ({
          trip_id: item.trip.id,
          plan_id: scenario.plan.id,
          trip_seq: item.trip.seq,
          truck_plate: item.trip.truck_plate,
          driver_name: item.trip.driver_name,
          planned_l: item.planned,
          shortfall_l: item.planned - available,
        }));
      const created = push(
        "product_shortage",
        {
          depot_id: body.depot_id,
          depot_code: scenario.refs.depot.code,
          product_id: body.product_id,
          new_available_l: available,
          impacted_trips: impacted,
        },
        null,
        scenario.plan.id,
      );
      return HttpResponse.json(
        { event: created, available_l: available, impacted_trips: impacted },
        { status: 201 },
      );
    }),
    // Routes réelles (lot L5) dont l'assistant a besoin : plans publiés du jour.
    http.get(`${API}/plans`, ({ request }) => {
      const url = new URL(request.url);
      const match =
        (url.searchParams.get("day") ?? scenario.day) === scenario.day &&
        (url.searchParams.get("status") ?? "published") === scenario.plan.status;
      const { trips: _trips, unserved: _unserved, violations: _violations, ...summary } = scenario.plan;
      const items = match ? [summary] : [];
      return HttpResponse.json({ items, total: items.length, limit: 200, offset: 0 });
    }),
    http.get(`${API}/plans/:id`, ({ params }) =>
      params.id === scenario.plan.id
        ? HttpResponse.json(scenario.plan)
        : error(404, "not_found", "Plan introuvable."),
    ),
  ];
}
