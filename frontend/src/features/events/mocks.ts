/**
 * Doublures MSW de l'écran « Journal des événements » et jeu de données réaliste réutilisable
 * (tests Vitest, captures d'écran). Formes RÉELLES du lot L10 (`backend/app/events/schemas.py`,
 * commit 1bd8741) : `EventOut`, `ReplacementOptionsOut`, `EventResultOut`, `ShortageOut`, `ResolveOut`.
 *
 *   server.use(...eventsHandlers(createEventsScenario(day)));
 *
 * Données brutes (objets JSON simples, sans MSW) : `sampleEvents(day)`, `samplePlan(day)`.
 */
import { http, HttpResponse } from "msw";

import { dayBoundsUtc } from "@/lib/format";
import type { IsoDate } from "@/lib/types";

import type {
  DriverOptionOut,
  EventOut,
  EventResultOut,
  ImpactedTripOut,
  PlanOut,
  PlanResultOut,
  ReplacementOptionsOut,
  ResolveOut,
  RuleIssueOut,
  ShortageOut,
  TripOut,
  TruckOptionOut,
} from "./api";

const API = "*/api/v1";

/** Identifiants de référence (remplaçables par ceux d'une base réelle ou des doublures communes). */
export interface SampleRefs {
  depot: { id: string; code: string; name: string };
  /** Dépôt de repli proposé pour « changer de dépôt ». */
  altDepot: { id: string; code: string; name: string };
  products: Record<"SUPER" | "GASOIL" | "PETROLE", string>;
}
export const DEFAULT_REFS: SampleRefs = {
  depot: { id: "0e000000-0000-7000-8000-00000000d001", code: "SCDP-DLA", name: "SCDP Douala" },
  altDepot: { id: "0e000000-0000-7000-8000-00000000d002", code: "DEP-BON", name: "Dépôt Bonabéri" },
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
export const SAMPLE_SHORTAGE_EVENT_ID = uid("000e", 99);
/** Camions de remplacement : éligible, éligible avec chauffeur du jour, sans chauffeur possible, en maintenance. */
export const SAMPLE_TRUCK_IDS = {
  free: uid("0007", 9),
  withDriver: uid("0007", 8),
  driverRequired: uid("0007", 6),
  maintenance: uid("0007", 7),
} as const;
export const SAMPLE_DRIVER_IDS = {
  herve: uid("0008", 9),
  jean: uid("0008", 8),
  paul: uid("0008", 7),
} as const;
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
    status: "at_depot",
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

type Actor = keyof typeof ACTORS;
const TYPE_LABELS: Record<string, string> = {
  truck_breakdown: "Panne de camion",
  driver_unavailable: "Chauffeur indisponible",
  product_shortage: "Produit indisponible au dépôt",
  manual_edit: "Modification du plan",
  publish: "Publication du plan",
  replan: "Recalcul du plan",
  loading_recorded: "Chargement enregistré",
  delivery_recorded: "Livraison enregistrée",
};
const liters = (value: number) => `${Math.round(value).toLocaleString("fr-FR").replace(/\s/g, " ")} L`;

function makeEvent(
  id: string,
  day: IsoDate,
  occurredAt: string,
  type: EventOut["type"],
  actor: Actor,
  summary: string,
  payload: Record<string, unknown>,
  trip: { id: string; seq: number; plate: string | null } | null,
  plan: { id: string; version: number } | null,
): EventOut {
  return {
    id,
    day,
    type,
    type_label: TYPE_LABELS[type],
    action: typeof payload.action === "string" ? payload.action : null,
    summary,
    occurred_at: occurredAt,
    actor_id: ACTORS[actor].id,
    actor_name: ACTORS[actor].name,
    plan_id: plan?.id ?? null,
    plan_version: plan?.version ?? null,
    trip_id: trip?.id ?? null,
    trip_seq: trip?.seq ?? null,
    truck_plate: trip?.plate ?? null,
    payload: { ...payload, summary },
  };
}

/** Répartition du stock restant entre les tournées non chargées, dans l'ordre de départ (L10-16). */
function analyse(plan: PlanOut, refs: SampleRefs, depotId: string, productId: string, available: number) {
  const volume = (trip: TripOut) =>
    trip.loads.filter((load) => load.product_id === productId).reduce((sum, load) => sum + load.planned_l, 0);
  const trips = plan.trips.filter((trip) => trip.depot_id === depotId && volume(trip) > 0);
  const isLoaded = (trip: TripOut) => ["loaded", "in_progress", "completed"].includes(trip.status);
  const loaded = trips.filter(isLoaded).reduce((sum, trip) => sum + volume(trip), 0);
  let left = available - loaded;
  const impacted: ImpactedTripOut[] = [];
  let plannedUnloaded = 0;
  for (const trip of trips.filter((item) => !isLoaded(item))) {
    const planned = volume(trip);
    plannedUnloaded += planned;
    const covered = Math.max(0, Math.min(planned, left));
    left -= covered;
    if (covered >= planned) continue;
    impacted.push({
      plan_id: plan.id,
      plan_version: plan.version,
      plan_status: plan.status,
      trip_id: trip.id,
      trip_seq: trip.seq,
      status: trip.status,
      truck_plate: trip.truck_plate,
      driver_name: trip.driver_name,
      planned_start_at: trip.planned_start_at,
      planned_l: planned,
      covered_l: covered,
      shortfall_l: planned - covered,
      options: covered > 0 ? ["reduce", "postpone", "change_depot"] : ["postpone", "change_depot"],
      orders: trip.stops.flatMap((stop) =>
        stop.deliveries
          .filter((delivery) => delivery.product_id === productId)
          .map((delivery) => ({
            order_id: delivery.order_id,
            stop_id: stop.id,
            station_code: stop.station_code,
            station_name: stop.station_name,
            planned_l: delivery.planned_l,
            requested_l: delivery.planned_l,
            priority: "normal",
          })),
      ),
      alternative_depots: [
        {
          depot_id: refs.altDepot.id,
          code: refs.altDepot.code,
          name: refs.altDepot.name,
          available_l: 60000,
          planned_l: 0,
          remaining_l: 60000,
          sufficient: true,
        },
      ],
      resolution: null,
    });
  }
  const remaining = available - loaded;
  return {
    loaded_l: loaded,
    remaining_l: remaining,
    planned_unloaded_l: plannedUnloaded,
    shortfall_l: impacted.reduce((sum, trip) => sum + trip.shortfall_l, 0),
    impacted,
  };
}

function makeShortage(
  eventId: string,
  day: IsoDate,
  occurredAt: string,
  plan: PlanOut,
  refs: SampleRefs,
  depotId: string,
  productId: string,
  available: number,
  previous: number | null,
): ShortageOut | { below: number } {
  const analysis = analyse(plan, refs, depotId, productId, available);
  if (analysis.remaining_l < 0) return { below: analysis.loaded_l };
  const productCode =
    (Object.entries(refs.products).find(([, id]) => id === productId)?.[0] as string | undefined) ??
    "PRODUIT";
  const depotCode = depotId === refs.depot.id ? refs.depot.code : refs.altDepot.code;
  const status = analysis.impacted.length > 0 ? "open" : "no_impact";
  const summary =
    `Stock de ${productCode} au dépôt ${depotCode} : ${previous !== null ? liters(previous) : "non renseigné"} → ` +
    `${liters(available)} (déjà chargé ${liters(analysis.loaded_l)}, reste ${liters(analysis.remaining_l)} pour ` +
    `${liters(analysis.planned_unloaded_l)} encore à charger). ` +
    (analysis.impacted.length > 0
      ? `${analysis.impacted.length} tournée(s) impactée(s) (n° ${analysis.impacted.map((trip) => trip.trip_seq).join(", ")}), ` +
        `il manque ${liters(analysis.shortfall_l)} : le dispatcher doit réduire, reporter ou changer de dépôt.`
      : "Aucune tournée impactée.");
  const figures = {
    status,
    day,
    depot_id: depotId,
    depot_code: depotCode,
    product_id: productId,
    product_code: productCode,
    previous_available_l: previous,
    new_available_l: available,
    loaded_l: analysis.loaded_l,
    remaining_l: analysis.remaining_l,
    planned_unloaded_l: analysis.planned_unloaded_l,
    shortfall_l: analysis.shortfall_l,
    impacted_trips: analysis.impacted,
  } as const;
  const event = makeEvent(
    eventId,
    day,
    occurredAt,
    "product_shortage",
    "supply",
    summary,
    {
      action: "declared",
      comment: null,
      ...figures,
      related_trip_ids: analysis.impacted.map((trip) => trip.trip_id),
      resolutions: [],
    },
    null,
    { id: plan.id, version: plan.version },
  );
  return { event, ...figures };
}

/**
 * Journée type telle que la renvoie `GET /events` (du plus récent au plus ancien) : publication,
 * chargements (dont un écart RM-13), livraisons, arrêt sauté, panne de camion, pénurie ouverte.
 */
export function sampleEvents(day: IsoDate, refs: SampleRefs = DEFAULT_REFS): EventOut[] {
  const [trip1, , trip3] = SAMPLE_TRIP_IDS;
  const plan = { id: SAMPLE_PLAN_ID, version: 1 };
  let n = 0;
  const event = (
    time: string,
    type: EventOut["type"],
    actor: Actor,
    summary: string,
    payload: Record<string, unknown>,
    trip: { id: string; seq: number; plate: string } | null = null,
  ) => makeEvent(uid("000e", (n += 1)), day, at(day, time), type, actor, summary, payload, trip, plan);
  const t1 = { id: trip1, seq: 1, plate: "LT 782 KD" };
  const t3 = { id: trip3, seq: 3, plate: "LT 334 BX" };
  const shortage = makeShortage(
    SAMPLE_SHORTAGE_EVENT_ID,
    day,
    at(day, "08:47"),
    samplePlan(day, refs),
    refs,
    refs.depot.id,
    refs.products.GASOIL,
    37000,
    400000,
  ) as ShortageOut;
  const list = [
    event(
      "05:48",
      "manual_edit",
      "dispatcher",
      "Arrêt OLA Akwa déplacé de la tournée 2 vers la tournée 1 (position 3).",
      { action: "move_stop", plan_version: 1 },
      t1,
    ),
    event("05:52", "publish", "dispatcher", "Version 1 publiée.", {
      action: "publish",
      plan_version: 1,
      archived_plan_id: null,
    }),
    event(
      "06:24",
      "loading_recorded",
      "fleet",
      "Chargement enregistré (bon BL-2231) : 22 980 L à 15 °C pour 23 000 L planifiés (écart -0,09 %).",
      {
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
      "Arrêt 1 (ST-BEPAN) livré : 13 950 L pour 14 000 L planifiés.",
      { seq: 1, station_code: "ST-BEPAN", status: "delivered", skip_reason: null },
      t3,
    ),
    event(
      "07:08",
      "loading_recorded",
      "fleet",
      "Chargement enregistré (bon BL-2238) : 33 106 L à 15 °C pour 34 000 L planifiés (écart -2,63 %) — hors tolérance (RM-13).",
      {
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
      "Arrêt 1 (ST-DEIDO) livré : 20 000 L pour 20 000 L planifiés.",
      { seq: 1, station_code: "ST-DEIDO", status: "delivered", skip_reason: null },
      t1,
    ),
    event(
      "07:55",
      "delivery_recorded",
      "fleet",
      "Arrêt 2 (ST-MAKEP) non livré : Station fermée à l'arrivée.",
      { seq: 2, station_code: "ST-MAKEP", status: "skipped", skip_reason: "Station fermée à l'arrivée" },
      t3,
    ),
    shortage.event,
  ];
  return list.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
}

/** État d'un scénario de doublures : données servies et requêtes reçues (pour les assertions). */
export interface EventsScenario {
  day: IsoDate;
  refs: SampleRefs;
  plan: PlanOut;
  events: EventOut[];
  /** Pénuries déclarées, par identifiant d'événement. */
  shortages: Map<string, ShortageOut>;
  /** Corps JSON des POST reçus, par chemin (`/events/truck-breakdown`…). */
  received: { path: string; body: unknown }[];
  /** Requêtes d'options de remplacement reçues. */
  optionQueries: { trip_id: string | null; replacement_truck_id: string | null }[];
  /** Si renseigné : la prochaine version créée garde ces violations et reste en brouillon. */
  blockingViolations: RuleIssueOut[];
  /**
   * Autres tournées de la ressource défaillante, annoncées par la PROCHAINE réaffectation seulement
   * (`other_impacted_trips`) ; les suivantes n'en annoncent plus.
   */
  otherImpactedTrips: EventResultOut["other_impacted_trips"];
}

export function createEventsScenario(day: IsoDate, refs: SampleRefs = DEFAULT_REFS): EventsScenario {
  const plan = samplePlan(day, refs);
  const events = sampleEvents(day, refs);
  const open = makeShortage(
    SAMPLE_SHORTAGE_EVENT_ID,
    day,
    at(day, "08:47"),
    plan,
    refs,
    refs.depot.id,
    refs.products.GASOIL,
    37000,
    400000,
  ) as ShortageOut;
  return {
    day,
    refs,
    plan,
    events,
    shortages: new Map([[SAMPLE_SHORTAGE_EVENT_ID, open]]),
    received: [],
    optionQueries: [],
    blockingViolations: [],
    otherImpactedTrips: [],
  };
}

const TRUCK_SEEDS: Omit<TruckOptionOut, "suggested_driver_id" | "suggested_driver_name">[] = [
  {
    truck_id: SAMPLE_TRUCK_IDS.free,
    plate: "LT 608 EM",
    size: "medium",
    carrier_name: "OLA Flotte",
    total_capacity_l: 20000,
    assigned_driver_id: null,
    assigned_driver_name: null,
    other_trip_seqs: [],
    eligible: true,
    reasons: [],
    driver_required: false,
  },
  {
    truck_id: SAMPLE_TRUCK_IDS.withDriver,
    plate: "LT 123 AB",
    size: "large",
    carrier_name: "Transcam",
    total_capacity_l: 33000,
    assigned_driver_id: SAMPLE_DRIVER_IDS.jean,
    assigned_driver_name: "Jean Mbarga",
    other_trip_seqs: [],
    eligible: true,
    reasons: [],
    driver_required: false,
  },
  {
    truck_id: SAMPLE_TRUCK_IDS.driverRequired,
    plate: "LT 271 NP",
    size: "large",
    carrier_name: null,
    total_capacity_l: 30000,
    assigned_driver_id: null,
    assigned_driver_name: null,
    other_trip_seqs: [],
    eligible: true,
    reasons: [],
    driver_required: true,
  },
  {
    truck_id: SAMPLE_TRUCK_IDS.maintenance,
    plate: "LT 456 CD",
    size: "small",
    carrier_name: "Transcam",
    total_capacity_l: 12000,
    assigned_driver_id: null,
    assigned_driver_name: null,
    other_trip_seqs: [],
    eligible: false,
    reasons: [{ rule_code: "RM-04", message: "Camion en maintenance." }],
    driver_required: false,
  },
];

/** `ReplacementOptionsOut` pour une tournée du plan du scénario. */
export function sampleReplacementOptions(
  scenario: EventsScenario,
  tripId: string,
  replacementTruckId: string | null = null,
): ReplacementOptionsOut | null {
  const trip = scenario.plan.trips.find((item) => item.id === tripId);
  if (!trip) return null;
  const pending = trip.stops.filter((stop) => stop.status === "pending");
  const blocked =
    trip.status === "completed"
      ? `La tournée ${trip.seq} est terminée : il n'y a plus rien à réaffecter.`
      : pending.length === 0
        ? `La tournée ${trip.seq} n'a plus aucun arrêt en attente de livraison.`
        : null;
  const drivers: DriverOptionOut[] = [
    {
      driver_id: trip.driver_id as string,
      full_name: trip.driver_name as string,
      phone: null,
      carrier_name: null,
      assigned_truck_id: trip.truck_id,
      assigned_truck_plate: trip.truck_plate,
      other_trip_seqs: [],
      is_current: true,
      eligible: true,
      reasons: [],
    },
    {
      driver_id: SAMPLE_DRIVER_IDS.herve,
      full_name: "Hervé Ndjock",
      phone: "+237 677 10 20 33",
      carrier_name: null,
      assigned_truck_id: null,
      assigned_truck_plate: null,
      other_trip_seqs: [],
      is_current: false,
      eligible: true,
      reasons: [],
    },
    {
      driver_id: SAMPLE_DRIVER_IDS.jean,
      full_name: "Jean Mbarga",
      phone: "+237 677 00 00 01",
      carrier_name: "Transcam",
      assigned_truck_id: SAMPLE_TRUCK_IDS.withDriver,
      assigned_truck_plate: "LT 123 AB",
      other_trip_seqs: [],
      is_current: false,
      eligible: true,
      reasons: [],
    },
    {
      driver_id: SAMPLE_DRIVER_IDS.paul,
      full_name: "Paul Atangana",
      phone: null,
      carrier_name: "Transcam",
      assigned_truck_id: null,
      assigned_truck_plate: null,
      other_trip_seqs: [],
      is_current: false,
      eligible: false,
      reasons: [{ rule_code: "RM-03", message: "Chauffeur en repos." }],
    },
  ];
  return {
    trip: {
      trip_id: trip.id,
      source_trip_id: trip.id,
      plan_id: scenario.plan.id,
      plan_version: scenario.plan.version,
      plan_status: scenario.plan.status,
      seq: trip.seq,
      status: trip.status,
      truck_id: trip.truck_id,
      truck_plate: trip.truck_plate,
      driver_id: trip.driver_id,
      driver_name: trip.driver_name,
      depot_id: trip.depot_id,
      depot_code: trip.depot_code,
      pending_stops: pending.length,
      delivered_stops: trip.stops.filter((stop) => stop.status === "delivered").length,
      skipped_stops: trip.stops.filter((stop) => stop.status === "skipped").length,
      pending_l: pending.reduce((sum, stop) => sum + stop.planned_l, 0),
      pending_station_codes: pending.map((stop) => stop.station_code ?? ""),
      can_replace_truck: blocked === null,
      can_replace_driver: blocked === null,
      blocked_reason: blocked,
    },
    occurred_at: new Date().toISOString(),
    drivers_evaluated_for_truck_id: replacementTruckId ?? trip.truck_id,
    trucks: blocked
      ? []
      : TRUCK_SEEDS.map((seed) => ({
          ...seed,
          suggested_driver_id: seed.driver_required ? null : (seed.assigned_driver_id ?? trip.driver_id),
          suggested_driver_name: seed.driver_required
            ? null
            : (seed.assigned_driver_name ?? trip.driver_name),
        })),
    drivers: blocked ? [] : drivers,
  };
}

const error = (status: number, code: string, message: string, details: unknown[] = []) =>
  HttpResponse.json({ code, message, details }, { status });

export function eventsHandlers(scenario: EventsScenario) {
  const pathOf = (request: Request) => new URL(request.url).pathname.replace(/^.*\/api\/v1/, "");

  /** Nouvelle version du plan (RM-18) : publiée d'office sauf violation bloquante (L10-2). */
  const newVersion = (): PlanResultOut => {
    const violations = scenario.blockingViolations;
    const published = violations.length === 0;
    const previous = scenario.plan;
    const plan = {
      ...previous,
      id: SAMPLE_NEW_PLAN_ID,
      version: previous.version + 1,
      status: published ? "published" : "draft",
    } as PlanOut;
    return {
      plan_id: plan.id,
      plan_version: plan.version,
      plan_status: plan.status,
      published,
      version_created: true,
      previous_plan_id: previous.id,
      previous_plan_version: previous.version,
      previous_plan_status: published ? "archived" : "published",
      blocking_count: violations.length,
      warning_count: 0,
      violations,
      plan,
    };
  };

  const reassign = (kind: "truck" | "driver") =>
    http.post(
      `${API}/events/${kind === "truck" ? "truck-breakdown" : "driver-unavailable"}`,
      async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        scenario.received.push({ path: pathOf(request), body });
        const options = sampleReplacementOptions(
          scenario,
          String(body.trip_id),
          kind === "truck" ? String(body.replacement_truck_id) : null,
        );
        const trip = scenario.plan.trips.find((item) => item.id === body.trip_id);
        if (!options || !trip) return error(404, "not_found", "Tournée introuvable.");
        if (options.trip.blocked_reason) return error(409, "no_pending_stops", options.trip.blocked_reason);
        const truck = options.trucks.find((item) => item.truck_id === body.replacement_truck_id);
        const driver = options.drivers.find((item) => item.driver_id === body.replacement_driver_id);
        if (kind === "truck" && !truck) return error(404, "not_found", "Camion de remplacement introuvable.");
        if (kind === "driver" && !driver) return error(404, "not_found", "Chauffeur remplaçant introuvable.");
        if (kind === "truck" && truck?.driver_required && !driver) {
          return error(
            409,
            "rule_violation",
            "Aucun chauffeur pour la tournée de remplacement : indiquez un chauffeur remplaçant.",
            [
              {
                rule_code: "RM-01",
                severity: "blocking",
                message: `Le camion ${truck.plate} n'a pas de chauffeur affecté pour la journée et la tournée d'origine n'en a pas non plus.`,
              },
            ],
          );
        }
        const result = newVersion();
        const pending = trip.stops.filter((stop) => stop.status === "pending");
        const kept = trip.stops.filter((stop) => stop.status !== "pending");
        const driverName = driver?.full_name ?? truck?.suggested_driver_name ?? trip.driver_name;
        const tail = result.published
          ? `Version ${result.plan_version} publiée.`
          : `Version ${result.plan_version} en brouillon : ${result.blocking_count} violation(s) bloquante(s) à corriger.`;
        const summary =
          kind === "truck"
            ? `Panne du camion ${trip.truck_plate} (tournée ${trip.seq}) à 09:10 : ${pending.length} arrêt(s) non livré(s) transféré(s) sur le camion ${truck?.plate} (tournée ${scenario.plan.trips.length + 1}, chauffeur ${driverName}), à recharger au dépôt` +
              (kept.length > 0
                ? ` ; ${kept.length} arrêt(s) déjà réalisé(s) conservé(s) sur la tournée d'origine. `
                : ". ") +
              tail
            : `Chauffeur ${trip.driver_name} indisponible (tournée ${trip.seq}) à 09:10 : remplacé par ${driverName}. ${tail}`;
        const event = makeEvent(
          uid("000f", scenario.events.length + 1),
          scenario.day,
          new Date().toISOString(),
          kind === "truck" ? "truck_breakdown" : "driver_unavailable",
          "dispatcher",
          summary,
          {
            action: kind === "truck" ? "truck_breakdown" : "driver_unavailable",
            reason: body.reason ?? null,
            published: result.published,
            blocking_count: result.blocking_count,
            plan_version: result.plan_version,
          },
          { id: trip.id, seq: trip.seq, plate: trip.truck_plate ?? null },
          { id: result.plan_id, version: result.plan_version },
        );
        scenario.events.unshift(event);
        const out: EventResultOut = {
          ...result,
          event,
          source_trip_id: trip.id,
          origin_trip_id: kind === "truck" && kept.length > 0 ? trip.id : null,
          new_trip_id: kind === "truck" ? uid("0002", 9) : null,
          trip_id: kind === "truck" ? uid("0002", 9) : trip.id,
          truck_id: truck?.truck_id ?? trip.truck_id,
          driver_id: driver?.driver_id ?? truck?.suggested_driver_id ?? trip.driver_id,
          transferred_stop_ids: kind === "truck" ? pending.map((stop) => stop.id) : [],
          kept_stop_ids: kind === "truck" ? kept.map((stop) => stop.id) : [],
          other_impacted_trips: scenario.otherImpactedTrips,
        };
        scenario.otherImpactedTrips = [];
        return HttpResponse.json(out);
      },
    );

  return [
    http.get(`${API}/events/replacement-options`, ({ request }) => {
      const url = new URL(request.url);
      const query = {
        trip_id: url.searchParams.get("trip_id"),
        replacement_truck_id: url.searchParams.get("replacement_truck_id"),
      };
      scenario.optionQueries.push(query);
      const options = sampleReplacementOptions(scenario, String(query.trip_id), query.replacement_truck_id);
      return options ? HttpResponse.json(options) : error(404, "not_found", "Tournée introuvable.");
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
      scenario.received.push({ path: pathOf(request), body });
      const id = uid("000f", scenario.events.length + 1);
      const declared = makeShortage(
        id,
        scenario.day,
        new Date().toISOString(),
        scenario.plan,
        scenario.refs,
        String(body.depot_id),
        String(body.product_id),
        Number(body.new_available_l),
        400000,
      );
      if ("below" in declared) {
        return error(
          422,
          "stock_below_loaded",
          `Le nouveau stock (${liters(Number(body.new_available_l))}) est inférieur au volume déjà chargé aujourd'hui (${liters(declared.below)}).`,
          [{ field: "new_available_l", loaded_l: declared.below }],
        );
      }
      scenario.shortages.set(id, declared);
      scenario.events.unshift(declared.event);
      return HttpResponse.json(declared);
    }),
    http.get(`${API}/events/:id/impact`, ({ params }) => {
      const shortage = scenario.shortages.get(String(params.id));
      return shortage
        ? HttpResponse.json(shortage)
        : error(409, "event_not_resolvable", "Cet événement n'est pas une pénurie déclarée.");
    }),
    http.post(`${API}/events/:id/resolve`, async ({ request, params }) => {
      const body = (await request.json()) as {
        resolutions: { trip_id: string; action: string; depot_id?: string }[];
      };
      scenario.received.push({ path: pathOf(request), body });
      const shortage = scenario.shortages.get(String(params.id));
      if (!shortage)
        return error(409, "event_not_resolvable", "Cet événement n'est pas une pénurie déclarée.");
      if (shortage.status !== "open")
        return error(409, "shortage_not_open", "Cette pénurie est déjà résolue.");
      for (const decision of body.resolutions) {
        if (!shortage.impacted_trips.some((trip) => trip.trip_id === decision.trip_id)) {
          return error(409, "trip_not_concerned", "Cette tournée n'est pas impactée par la pénurie.");
        }
      }
      const result = newVersion();
      const decided = new Set(body.resolutions.map((decision) => decision.trip_id));
      const impacted = shortage.impacted_trips.filter((trip) => !decided.has(trip.trip_id));
      const updated: ShortageOut = {
        ...shortage,
        status: impacted.length === 0 ? "resolved" : "open",
        shortfall_l: impacted.reduce((sum, trip) => sum + trip.shortfall_l, 0),
        impacted_trips: impacted,
        event: {
          ...shortage.event,
          payload: { ...shortage.event.payload, status: impacted.length === 0 ? "resolved" : "open" },
        },
      };
      scenario.shortages.set(String(params.id), updated);
      scenario.events = scenario.events.map((item) => (item.id === updated.event.id ? updated.event : item));
      const out: ResolveOut = { ...updated, results: [result] };
      return HttpResponse.json(out);
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
