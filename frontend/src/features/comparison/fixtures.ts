/**
 * Jeu de test de l'écran Comparaison et doublures MSW du lot (branchées par `server.use(...)` dans les tests).
 * Les formes sont celles de l'API réelle (types générés) ; les chiffres reprennent une journée de Douala.
 */
import { http, HttpResponse, type HttpHandler } from "msw";

import { API, errorResponse, readUpload } from "@/mocks/handlers/helpers";

import type {
  Comparison,
  Dashboard,
  MetricDelta,
  PlanMetrics,
  PlanRow,
  PlanSummary,
  Task,
  TripRoute,
} from "./api";

export const DAY = "2027-01-12";
export const IDS = {
  reference: "00000000-0000-7000-8000-00000000000a",
  replay: "00000000-0000-7000-8000-00000000000b",
  computed: "00000000-0000-7000-8000-00000000000c",
  empty: "00000000-0000-7000-8000-00000000000d",
  oldReference: "00000000-0000-7000-8000-00000000000e",
  newReference: "00000000-0000-7000-8000-0000000000a1",
  newReplay: "00000000-0000-7000-8000-0000000000b1",
};

function planRow(id: string, kind: PlanRow["kind"], overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    id,
    day: DAY,
    kind,
    status: "draft",
    version: 1,
    root_plan_id: id,
    parent_plan_id: null,
    label: null,
    approximate: true,
    engine_version: kind === "manual_reference" ? null : "1.0.0",
    computed_at: kind === "manual_reference" ? null : "2027-01-12T05:10:00Z",
    computed_in_ms: kind === "manual_reference" ? null : 6200,
    prep_time_s: kind === "manual_reference" ? 6300 : null,
    metrics: {},
    ...overrides,
  } as PlanRow;
}

/** Du plus récent au plus ancien, comme `GET /plans`. */
export const PLANS: PlanRow[] = [
  planRow(IDS.empty, "computed", { label: "Plan vide", version: 2 }),
  planRow(IDS.computed, "computed", { status: "published", label: "Plan du jour" }),
  planRow(IDS.replay, "replay", { parent_plan_id: IDS.reference, label: "Rejeu — Journée A" }),
  planRow(IDS.reference, "manual_reference", { label: "Journée A — dispatch manuel" }),
  planRow(IDS.oldReference, "manual_reference", { status: "archived", label: "Journée A — ancienne" }),
];

const summary = (row: PlanRow, title: string): PlanSummary => ({
  id: row.id,
  day: row.day,
  kind: row.kind,
  status: row.status,
  version: row.version,
  label: row.label ?? null,
  title,
  approximate: row.approximate,
  parent_plan_id: row.parent_plan_id ?? null,
  engine_version: row.engine_version ?? null,
  computed_at: row.computed_at ?? null,
});

const DEPOT = { kind: "depot", lat: 4.0435, lon: 9.7043, code: "SCDP-DLA", name: "SCDP Douala" };
const STATIONS: Record<string, { name: string; lat: number; lon: number }> = {
  "ST-AKWA": { name: "OLA Akwa", lat: 4.0511, lon: 9.7085 },
  "ST-MAKEP": { name: "OLA Makepe", lat: 4.076, lon: 9.756 },
  "ST-BONAB": { name: "OLA Bonabéri", lat: 4.0712, lon: 9.6601 },
  "ST-NDOKO": { name: "OLA Ndokoti", lat: 4.044, lon: 9.741 },
};

function route(
  seq: number,
  plate: string,
  driver: string | null,
  codes: string[],
  overrides: Partial<TripRoute> = {},
): TripRoute {
  const id = `trip-${plate.replace(/\s/g, "")}-${seq}`;
  const stops = codes.map((code, index) => ({
    stop_id: `${id}-stop-${index + 1}`,
    seq: index + 1,
    station_id: `station-${code}`,
    station_code: code,
    station_name: STATIONS[code].name,
    status: "pending" as const,
    planned_arrival_at: `2027-01-12T0${6 + index}:30:00Z`,
    planned_departure_at: `2027-01-12T0${6 + index}:55:00Z`,
    actual_arrival_at: null,
    actual_departure_at: null,
    distance_from_prev_m: 5200 + index * 1300,
    deliveries: [
      {
        order_id: `order-${code}`,
        product_id: "product-super",
        product_code: index % 2 === 0 ? "SUPER" : "GASOIL",
        planned_l: 10000,
        actual_l: null,
      },
    ],
  }));
  return {
    trip_id: id,
    seq,
    color: "#1f77b4",
    truck_id: `truck-${plate}`,
    truck_plate: plate,
    driver_id: driver ? `driver-${driver}` : null,
    driver_name: driver,
    depot_id: "depot-1",
    depot_code: "SCDP-DLA",
    status: "planned",
    planned_depart_at: "2027-01-12T05:15:00Z",
    planned_return_at: "2027-01-12T08:50:00Z",
    actual_depart_at: null,
    actual_return_at: null,
    distance_m: 23300,
    actual_distance_m: null,
    duration_s: 9300,
    volume_planned_l: codes.length * 10000,
    fill_rate_pct: 83.3,
    points: [
      { ...DEPOT, seq: null, station_id: null },
      ...codes.map((code, index) => ({
        kind: "station",
        lat: STATIONS[code].lat,
        lon: STATIONS[code].lon,
        code,
        name: STATIONS[code].name,
        seq: index + 1,
        station_id: `station-${code}`,
      })),
      { ...DEPOT, seq: null, station_id: null },
    ],
    stops,
    ...overrides,
  };
}

const METRICS_A: PlanMetrics = {
  distance_estimated_m: 182934,
  distance_actual_m: 234000,
  distance_actual_trips: 2,
  trucks_used: 5,
  drivers_used: 5,
  trips_count: 2,
  stations_requested: 14,
  stations_served: 14,
  stations_delivered: 14,
  orders_requested: 15,
  orders_served: 14,
  volume_requested_l: 138500,
  volume_planned_l: 133500,
  volume_delivered_l: 133500,
  service_duration_s: 50062,
  service_duration_actual_s: 79500,
  fill_rate_avg_pct: 85.67,
  violations_blocking: 0,
  violations_warning: 2,
  violations_total: 2,
  prep_time_s: 6300,
  prep_time_source: "manual",
};
const METRICS_B: PlanMetrics = {
  distance_estimated_m: 131878,
  distance_actual_m: null,
  distance_actual_trips: 0,
  trucks_used: 3,
  drivers_used: 3,
  trips_count: 2,
  stations_requested: 14,
  stations_served: 14,
  stations_delivered: null,
  orders_requested: 15,
  orders_served: 15,
  volume_requested_l: 138500,
  volume_planned_l: 138500,
  volume_delivered_l: null,
  service_duration_s: 45467,
  service_duration_actual_s: null,
  fill_rate_avg_pct: 89.05,
  violations_blocking: 0,
  violations_warning: 3,
  violations_total: 3,
  prep_time_s: 6,
  prep_time_source: "computed",
};

/** Mêmes lignes et même ordre que `app.comparison.metrics.INDICATORS` (libellé, unité, « plus bas = mieux »). */
const INDICATORS: [keyof PlanMetrics, string, string, boolean | null][] = [
  ["distance_estimated_m", "Kilomètres estimés", "m", true],
  ["distance_actual_m", "Kilomètres réels", "m", true],
  ["trucks_used", "Camions mobilisés", "count", true],
  ["drivers_used", "Chauffeurs mobilisés", "count", true],
  ["trips_count", "Tournées", "count", true],
  ["stations_requested", "Stations demandées", "count", null],
  ["stations_served", "Stations servies par le plan", "count", false],
  ["stations_delivered", "Stations réellement livrées", "count", false],
  ["orders_requested", "Commandes demandées", "count", null],
  ["orders_served", "Commandes servies par le plan", "count", false],
  ["volume_requested_l", "Volume demandé", "l", null],
  ["volume_planned_l", "Volume planifié", "l", false],
  ["volume_delivered_l", "Volume réellement livré", "l", false],
  ["service_duration_s", "Durée totale de service prévue", "s", true],
  ["service_duration_actual_s", "Durée totale de service réelle", "s", true],
  ["fill_rate_avg_pct", "Taux de remplissage moyen", "pct", false],
  ["violations_blocking", "Violations bloquantes", "count", true],
  ["violations_warning", "Avertissements", "count", true],
  ["violations_total", "Violations (total)", "count", true],
  ["prep_time_s", "Temps de préparation du plan", "s", true],
];

/** Reproduit le calcul du serveur pour fabriquer des réponses cohérentes ; l'écran, lui, ne recalcule rien. */
function deltasOf(a: PlanMetrics, b: PlanMetrics): MetricDelta[] {
  return INDICATORS.map(([key, label, unit, lowerIsBetter]) => {
    const va = a[key] as number | null;
    const vb = b[key] as number | null;
    if (va === null || vb === null) {
      return { key, label, unit, a: va, b: vb, delta: null, delta_pct: null, better: null };
    }
    const delta = Math.round((vb - va) * 100) / 100;
    return {
      key,
      label,
      unit,
      a: va,
      b: vb,
      delta,
      delta_pct: va === 0 ? null : Math.round((delta / va) * 10000) / 100,
      better: lowerIsBetter === null ? null : delta === 0 ? "equal" : delta < 0 === lowerIsBetter ? "b" : "a",
    };
  });
}

function build(
  planB: PlanRow,
  titleB: string,
  metricsA: PlanMetrics,
  metricsB: PlanMetrics,
  verdict: Partial<Comparison["verdict"]>,
  routesB: TripRoute[],
  extra: Partial<Comparison> = {},
): Comparison {
  const gain = metricsA.distance_estimated_m - metricsB.distance_estimated_m;
  return {
    plan_a: summary(PLANS[3], "Journée A — dispatch manuel"),
    plan_b: summary(planB, titleB),
    metrics_a: metricsA,
    metrics_b: metricsB,
    deltas: deltasOf(metricsA, metricsB),
    verdict: {
      threshold_pct: 10,
      distance_a_m: metricsA.distance_estimated_m,
      distance_b_m: metricsB.distance_estimated_m,
      gain_m: gain,
      gain_pct: 27.91,
      success: true,
      gain_vs_actual_pct: null,
      no_blocking_violation: true,
      orders_served_ok: true,
      message:
        "Objectif atteint : le plan B parcourt 27,9 % de kilomètres en moins que le plan A (seuil : 10,0 %).",
      ...verdict,
    },
    routes_a: [
      route(1, "LT 201 DA", "Jean Mbarga", ["ST-AKWA", "ST-MAKEP"], { actual_distance_m: 41000 }),
      route(2, "LT 202 DA", "Paul Etoa", ["ST-BONAB", "ST-NDOKO"], { actual_distance_m: 46000 }),
    ],
    routes_b: routesB,
    unserved_a: [
      {
        order_id: "order-pk14",
        station_code: "ST-PK14",
        station_name: "OLA PK14",
        product_code: "PETROLE",
        requested_l: 5000,
        reason_code: "other",
        reason_text: "Commande non livrée lors de la journée de référence.",
      },
    ],
    unserved_b: [],
    ...extra,
  };
}

/** Résultat favorable : journée A contre son rejeu. */
export const FAVORABLE = build(
  PLANS[2],
  "Rejeu — Journée A",
  METRICS_A,
  METRICS_B,
  { gain_vs_actual_pct: 43.64 },
  [
    route(1, "LT 201 DA", "Paul Etoa", ["ST-AKWA", "ST-NDOKO", "ST-MAKEP"]),
    route(2, "LT 305 DB", null, ["ST-BONAB"]),
  ],
);

const METRICS_WORSE: PlanMetrics = {
  ...METRICS_B,
  distance_estimated_m: 192447,
  orders_served: 13,
  violations_blocking: 2,
  violations_total: 5,
};
/** Résultat défavorable : le plan du jour roule plus, sert moins et garde des violations bloquantes. */
export const UNFAVORABLE = build(
  PLANS[1],
  "Plan du jour",
  { ...METRICS_A, distance_actual_m: 41000, distance_actual_trips: 1 },
  METRICS_WORSE,
  {
    gain_pct: -5.2,
    success: false,
    no_blocking_violation: false,
    orders_served_ok: false,
    message:
      "Objectif non atteint : le plan B parcourt 5,2 % de kilomètres en plus que le plan A (seuil de gain : 10,0 %).",
  },
  [route(1, "LT 201 DA", "Paul Etoa", ["ST-AKWA", "ST-NDOKO"])],
  { plan_b: { ...summary(PLANS[1], "Plan du jour"), approximate: false } },
);

const METRICS_EMPTY: PlanMetrics = {
  ...METRICS_B,
  distance_estimated_m: 0,
  trucks_used: 0,
  drivers_used: 0,
  trips_count: 0,
  stations_served: 0,
  orders_served: 0,
  volume_planned_l: 0,
  service_duration_s: 0,
  fill_rate_avg_pct: null,
  violations_warning: 0,
  violations_total: 0,
};
/** Plan B sans aucune tournée : zéro kilomètre, mais aucune commande servie. */
export const NO_TRIPS = build(
  PLANS[0],
  "Plan vide",
  METRICS_A,
  METRICS_EMPTY,
  {
    gain_pct: 100,
    orders_served_ok: false,
    message:
      "Objectif atteint : le plan B parcourt 100,0 % de kilomètres en moins que le plan A (seuil : 10,0 %).",
  },
  [],
  {
    unserved_b: [
      {
        order_id: "order-akwa",
        station_code: "ST-AKWA",
        station_name: "OLA Akwa",
        product_code: "SUPER",
        requested_l: 10000,
        reason_code: "no_truck",
        reason_text: null,
      },
    ],
  },
);

export const DASHBOARD: Dashboard = {
  day: DAY,
  generated_at: "2027-01-12T09:05:00Z",
  plan: { ...summary(PLANS[1], "Plan du jour"), version: 3 },
  summary: {
    trips_total: 3,
    trips_by_status: { planned: 1, at_depot: 0, loaded: 0, in_progress: 1, completed: 1 },
    stops_total: 7,
    stops_delivered: 4,
    stops_skipped: 1,
    stops_pending: 2,
    volume_planned_l: 70000,
    volume_delivered_l: 40000,
    trips_late: 1,
    max_delay_s: 1500,
    alerts_blocking: 1,
    alerts_total: 2,
  },
  trips: [
    {
      trip_id: "t1",
      seq: 1,
      truck_plate: "LT 201 DA",
      driver_name: "Paul Etoa",
      depot_code: "SCDP-DLA",
      status: "in_progress",
      stops_total: 3,
      stops_delivered: 2,
      stops_skipped: 0,
      stops_pending: 1,
      volume_planned_l: 30000,
      volume_delivered_l: 20000,
      planned_depart_at: "2027-01-12T05:15:00Z",
      planned_return_at: "2027-01-12T09:40:00Z",
      actual_depart_at: "2027-01-12T05:35:00Z",
      actual_return_at: null,
      delay_s: 1500,
      next_station_code: "ST-MAKEP",
      next_station_name: "OLA Makepe",
      next_planned_arrival_at: "2027-01-12T09:00:00Z",
      next_estimated_arrival_at: "2027-01-12T09:25:00Z",
    },
    {
      trip_id: "t2",
      seq: 2,
      truck_plate: "LT 305 DB",
      driver_name: "Alain Biyong",
      depot_code: "SCDP-DLA",
      status: "completed",
      stops_total: 2,
      stops_delivered: 2,
      stops_skipped: 0,
      stops_pending: 0,
      volume_planned_l: 20000,
      volume_delivered_l: 20000,
      planned_depart_at: "2027-01-12T05:15:00Z",
      planned_return_at: "2027-01-12T07:40:00Z",
      actual_depart_at: "2027-01-12T05:15:00Z",
      actual_return_at: "2027-01-12T07:40:00Z",
      delay_s: 0,
      next_station_code: null,
      next_station_name: null,
      next_planned_arrival_at: null,
      next_estimated_arrival_at: null,
    },
  ],
  delays: [
    {
      trip_id: "t1",
      trip_seq: 1,
      truck_plate: "LT 201 DA",
      stop_id: "s1",
      stop_seq: 2,
      station_code: "ST-NDOKO",
      station_name: "OLA Ndokoti",
      planned_at: "2027-01-12T07:30:00Z",
      actual_at: "2027-01-12T07:55:00Z",
      delay_s: 1500,
    },
  ],
  alerts: [
    {
      source: "event",
      severity: "blocking",
      code: "truck_breakdown",
      message: "Panne du camion LT 306 DB sur la tournée 3.",
      trip_id: "t3",
      trip_seq: 3,
      event_id: "e1",
      event_type: null,
      occurred_at: "2027-01-12T08:10:00Z",
      payload: null,
    },
    {
      source: "violation",
      severity: "warning",
      code: "RM-08",
      message: "Dépôt SCDP-DLA : stock non renseigné pour SUPER.",
      trip_id: null,
      trip_seq: null,
      event_id: null,
      event_type: null,
      occurred_at: null,
      payload: null,
    },
  ],
};

export const DASHBOARD_NO_PLAN: Dashboard = {
  day: DAY,
  generated_at: "2027-01-12T09:05:00Z",
  plan: null,
  summary: {
    trips_total: 0,
    trips_by_status: {},
    stops_total: 0,
    stops_delivered: 0,
    stops_skipped: 0,
    stops_pending: 0,
    volume_planned_l: 0,
    volume_delivered_l: 0,
    trips_late: 0,
    max_delay_s: 0,
    alerts_blocking: 0,
    alerts_total: 0,
  },
  trips: [],
  delays: [],
  alerts: [],
};

export interface Recorded {
  /** Champs de chaque appel à `POST /reference-days/import`, dans l'ordre. */
  imports: Record<string, string>[];
  replays: string[];
  pdf: string[];
}

/**
 * Doublures du lot. `plans` est la liste vivante renvoyée par `GET /plans` : l'import et le rejeu y
 * ajoutent leurs plans, comme le ferait le serveur.
 */
export function comparisonHandlers(
  options: { plans?: PlanRow[]; dashboard?: Dashboard; taskStates?: Partial<Task>[] } = {},
): { handlers: HttpHandler[]; recorded: Recorded } {
  const plans = (options.plans ?? PLANS).map((plan) => ({ ...plan }));
  const recorded: Recorded = { imports: [], replays: [], pdf: [] };
  const byPair: Record<string, Comparison> = {
    [`${IDS.reference}:${IDS.replay}`]: FAVORABLE,
    [`${IDS.reference}:${IDS.computed}`]: UNFAVORABLE,
    [`${IDS.reference}:${IDS.empty}`]: NO_TRIPS,
    [`${IDS.reference}:${IDS.newReplay}`]: {
      ...FAVORABLE,
      plan_b: { ...FAVORABLE.plan_b, id: IDS.newReplay },
    },
  };
  const taskStates = [
    ...(options.taskStates ?? [
      { state: "running", progress: 40, message: "Calcul des tournées" },
      { state: "succeeded", progress: 100, message: "Plan calculé", plan_id: IDS.newReplay },
    ]),
  ];
  let existing = plans.some((plan) => plan.kind === "manual_reference" && plan.status !== "archived");

  const handlers = [
    http.get(`${API}/plans`, ({ request }) => {
      const day = new URL(request.url).searchParams.get("day");
      const items = plans.filter((plan) => plan.day === day);
      return HttpResponse.json({ items, total: items.length, limit: 200, offset: 0 });
    }),
    http.get(`${API}/comparison`, ({ request }) => {
      const query = new URL(request.url).searchParams;
      const found = byPair[`${query.get("plan_a")}:${query.get("plan_b")}`];
      return found ? HttpResponse.json(found) : errorResponse(404, "not_found", "Plan introuvable.");
    }),
    http.get(`${API}/comparison.pdf`, ({ request }) => {
      recorded.pdf.push(new URL(request.url).search);
      return new HttpResponse("%PDF-1.7", {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="comparaison_AB_2027-01-12.pdf"',
        },
      });
    }),
    http.get(`${API}/dashboard`, () => HttpResponse.json(options.dashboard ?? DASHBOARD)),
    http.post(`${API}/reference-days/import`, async ({ request }) => {
      const upload = await readUpload(request);
      recorded.imports.push({ ...upload.fields, filename: upload.files.file?.name ?? "" });
      const base = { batch_id: "batch-1", plan_id: null, day: upload.fields.day || DAY, row_count: 29 };
      if (upload.files.file?.name.includes("erreur")) {
        const errors = [
          { sheet: "Tournées", row: 3, column: "Code station", message: "Station inconnue : ST-XXX." },
          { sheet: "Tournées", row: 5, column: "Camion", message: "Camion inconnu : LT 999 ZZ." },
        ];
        return HttpResponse.json(
          {
            code: "import_rejected",
            message: "Fichier rejeté : 2 erreur(s). Aucune donnée n'a été créée.",
            details: errors,
            ...base,
            status: "rejected",
            error_count: 2,
            errors,
            warnings: [],
            summary: {},
          },
          { status: 422 },
        );
      }
      const summaryOut = {
        orders: 15,
        trips: 6,
        stops: 14,
        volume_delivered_l: 133500,
        trips_with_actual_km: 6,
      };
      if (upload.fields.dry_run === "true") {
        return HttpResponse.json({
          ...base,
          status: "previewed",
          error_count: 0,
          errors: [],
          warnings: [
            {
              sheet: "Commandes",
              row: 16,
              column: "Volume demandé (L)",
              message: "Commande non livrée : elle sera inscrite comme non servie.",
            },
          ],
          summary: summaryOut,
        });
      }
      if (existing && upload.fields.replace !== "true") {
        return errorResponse(
          409,
          "reference_day_exists",
          "Une journée de référence existe déjà pour le 12/01/2027. Relancer l'import en demandant son remplacement.",
        );
      }
      existing = true;
      for (const plan of plans) {
        if (plan.kind === "manual_reference") plan.status = "archived";
      }
      plans.unshift(
        planRow(IDS.newReference, "manual_reference", { label: upload.fields.label || "Journée A" }),
      );
      return HttpResponse.json(
        {
          ...base,
          status: "applied",
          plan_id: IDS.newReference,
          error_count: 0,
          errors: [],
          warnings: [],
          summary: summaryOut,
        },
        { status: 201 },
      );
    }),
    http.post(`${API}/plans/:planId/replay`, ({ params }) => {
      recorded.replays.push(String(params.planId));
      return HttpResponse.json({ task_id: "task-1" }, { status: 202 });
    }),
    http.get(`${API}/tasks/:taskId`, () => {
      const next = taskStates.length > 1 ? taskStates.shift() : taskStates[0];
      if (next?.state === "succeeded" && next.plan_id) {
        plans.unshift(planRow(next.plan_id, "replay", { parent_plan_id: IDS.reference, label: "Rejeu 2" }));
      }
      return HttpResponse.json({
        task_id: "task-1",
        state: "pending",
        progress: 0,
        message: null,
        plan_id: null,
        error: null,
        ...next,
      });
    }),
  ];
  return { handlers, recorded };
}
