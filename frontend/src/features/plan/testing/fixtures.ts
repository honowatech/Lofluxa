/** Plans fictifs pour les tests de l'écran Plan (formes de l'API réelle, lot L5). */
import type {
  Delivery,
  DriverDay,
  Load,
  Plan,
  PlanSummary,
  PlanVersion,
  Stop,
  Trip,
  TruckDay,
} from "../types";

export const DAY = "2027-01-12";
const at = (hm: string) => `${DAY}T${hm}:00Z`;

const PRODUCTS = {
  SUPER: {
    product_id: "prod-super",
    product_code: "SUPER",
    product_label: "Super",
    product_color: "#e11d48",
  },
  GASOIL: {
    product_id: "prod-gasoil",
    product_code: "GASOIL",
    product_label: "Gasoil",
    product_color: "#ca8a04",
  },
} as const;

function delivery(id: string, product: keyof typeof PRODUCTS, liters: number, urgent = false): Delivery {
  return {
    id: `del-${id}`,
    order_id: `order-${id}`,
    ...PRODUCTS[product],
    planned_l: liters,
    actual_l: null,
    requested_l: liters,
    priority: urgent ? "urgent" : "normal",
    order_status: "confirmed",
  };
}

function stop(
  id: string,
  seq: number,
  code: string,
  name: string,
  arrival: string,
  deliveries: Delivery[],
): Stop {
  return {
    id: `stop-${id}`,
    seq,
    station_id: `station-${id}`,
    station_code: code,
    station_name: name,
    station_city: "Douala",
    contact_name: null,
    contact_phone: null,
    lat: 4.05 + seq * 0.01,
    lon: 9.7 + seq * 0.01,
    planned_arrival_at: at(arrival),
    planned_departure_at: at(
      arrival.replace(/:(\d\d)$/, (_, m: string) => `:${String(Number(m) + 20).padStart(2, "0")}`),
    ),
    distance_from_prev_m: 4200,
    status: "pending",
    actual_arrival_at: null,
    actual_departure_at: null,
    skip_reason: null,
    planned_l: deliveries.reduce((sum, d) => sum + d.planned_l, 0),
    deliveries,
  };
}

function load(
  id: string,
  position: number,
  product: keyof typeof PRODUCTS,
  liters: number,
  capacity: number,
): Load {
  return {
    id: `load-${id}`,
    compartment_id: `comp-${id}`,
    compartment_position: position,
    capacity_l: capacity,
    ...PRODUCTS[product],
    planned_l: liters,
  };
}

function trip(
  id: string,
  seq: number,
  plate: string,
  driver: string | null,
  stops: Stop[],
  loads: Load[],
): Trip {
  const planned = stops.reduce((sum, s) => sum + s.planned_l, 0);
  return {
    id: `trip-${id}`,
    seq,
    truck_id: `truck-${id}`,
    truck_plate: plate,
    truck_size: "medium",
    truck_capacity_l: 25000,
    driver_id: driver ? `driver-${id}` : null,
    driver_name: driver,
    driver_phone: null,
    depot_id: "depot-1",
    depot_code: "SCDP-DLA",
    depot_name: "SCDP Douala",
    depot_lat: 4.0483,
    depot_lon: 9.6905,
    planned_start_at: at("05:00"),
    planned_depart_at: at("07:15"),
    planned_return_at: at("09:30"),
    distance_m: 16600,
    duration_s: 6300,
    locked: false,
    status: "planned",
    actual_depart_at: null,
    actual_return_at: null,
    actual_distance_m: null,
    planned_l: planned,
    fill_rate: planned / 25000,
    blocking_count: 0,
    warning_count: 0,
    stops,
    loads,
    compartments: [
      ...loads.map((l) => ({
        compartment_id: l.compartment_id,
        compartment_position: l.compartment_position ?? 0,
        capacity_l: l.capacity_l ?? 0,
        product_id: l.product_id,
        product_code: l.product_code,
        product_label: l.product_label,
        product_color: l.product_color,
        planned_l: l.planned_l,
      })),
      {
        compartment_id: `comp-${id}-vide`,
        compartment_position: loads.length + 1,
        capacity_l: 4000,
        product_id: null,
        product_code: null,
        product_label: null,
        product_color: null,
        planned_l: 0,
      },
    ],
  };
}

/** Plan brouillon : deux tournées (Akwa → Bonanjo → Deido ; Ndokoti), sans violation ni commande non servie. */
export function makePlan(overrides: Partial<Plan> = {}): Plan {
  const trips = [
    trip(
      "1",
      1,
      "LT-401-AA",
      "Roger Abega",
      [
        stop("a", 1, "DLA01", "OLA Akwa", "07:30", [
          delivery("a1", "SUPER", 6000),
          delivery("a2", "GASOIL", 5000),
        ]),
        stop("b", 2, "DLA02", "OLA Bonanjo", "08:10", [delivery("b1", "GASOIL", 4000, true)]),
        stop("c", 3, "DLA04", "OLA Deido", "08:50", [delivery("c1", "SUPER", 5000)]),
      ],
      [load("1", 1, "SUPER", 5880, 6000), load("2", 2, "GASOIL", 4900, 5000)],
    ),
    trip(
      "2",
      2,
      "LT-402-AB",
      "Alain Nkoulou",
      [stop("d", 1, "DLA07", "OLA Ndokoti", "07:40", [delivery("d1", "GASOIL", 7000)])],
      [load("3", 1, "GASOIL", 5880, 6000)],
    ),
  ];
  return {
    id: "plan-1",
    day: DAY,
    kind: "computed",
    status: "draft",
    version: 1,
    root_plan_id: "plan-1",
    parent_plan_id: null,
    label: null,
    approximate: true,
    engine_version: "1.0.0",
    computed_at: at("04:42"),
    computed_in_ms: 3000,
    prep_time_s: null,
    metrics: { orders_total: 5, trips_count: 2, total_distance_m: 33200 },
    blocking_count: 0,
    warning_count: 0,
    publishable: true,
    created_at: at("04:42"),
    updated_at: at("04:42"),
    created_by: "user-1",
    created_by_name: "Awa Dispatcher",
    params_snapshot: null,
    solver_log: null,
    trips,
    unserved: [],
    violations: [],
    ...overrides,
  };
}

export function unserved(
  id: string,
  code: string,
  name: string,
  urgent: boolean,
  status = "confirmed",
): Plan["unserved"][number] {
  return {
    id: `unserved-${id}`,
    order_id: `order-${id}`,
    reason_code: "depot_stock",
    reason_text: "Stock dépôt insuffisant pour ce produit.",
    station_id: `station-${id}`,
    station_code: code,
    station_name: name,
    lat: 4.09,
    lon: 9.78,
    ...PRODUCTS.GASOIL,
    requested_l: 6000,
    priority: urgent ? "urgent" : "normal",
    order_status: status as Plan["unserved"][number]["order_status"],
  };
}

export function violation(
  id: string,
  rule: string,
  severity: "blocking" | "warning",
  message: string,
  target: { trip_id?: string; stop_id?: string } = {},
): Plan["violations"][number] {
  return {
    id: `violation-${id}`,
    rule_code: rule,
    severity,
    message,
    trip_id: target.trip_id ?? null,
    trip_seq: null,
    stop_id: target.stop_id ?? null,
    stop_seq: null,
  };
}

export function summaryOf(plan: Plan): PlanSummary {
  const {
    trips: _trips,
    unserved: _unserved,
    violations: _violations,
    params_snapshot: _p,
    solver_log: _s,
    ...summary
  } = plan;
  return summary;
}

/** Copie d'un plan publié en nouvelle version brouillon : nouveaux identifiants partout (RM-18, L5-4). */
export function asNewVersion(plan: Plan, id = "plan-2"): Plan {
  const suffix = `-v${plan.version + 1}`;
  return {
    ...plan,
    id,
    status: "draft",
    version: plan.version + 1,
    root_plan_id: plan.root_plan_id ?? plan.id,
    parent_plan_id: plan.id,
    trips: plan.trips.map((t) => ({
      ...t,
      id: `${t.id}${suffix}`,
      stops: t.stops.map((s) => ({ ...s, id: `${s.id}${suffix}` })),
    })),
    violations: plan.violations.map((v) => ({
      ...v,
      trip_id: v.trip_id ? `${v.trip_id}${suffix}` : null,
      stop_id: v.stop_id ? `${v.stop_id}${suffix}` : null,
    })),
  };
}

export function versionOf(plan: Plan, changes: PlanVersion["changes"] = []): PlanVersion {
  return {
    plan_id: plan.id,
    version: plan.version,
    status: plan.status,
    parent_plan_id: plan.parent_plan_id ?? null,
    is_current: plan.status === "published",
    reason: null,
    created_at: plan.created_at,
    created_by: plan.created_by ?? null,
    created_by_name: plan.created_by_name ?? null,
    published_at: plan.status === "draft" ? null : at("05:10"),
    published_by_name: plan.status === "draft" ? null : "Awa Dispatcher",
    metrics: plan.metrics ?? null,
    changes,
  };
}

export const TRUCK_DAYS: TruckDay[] = [
  { id: "truck-1", plate: "LT-401-AA", assignable: true },
  { id: "truck-2", plate: "LT-402-AB", assignable: true },
  { id: "truck-9", plate: "CE-409-ZZ", assignable: false },
].map(
  (t) =>
    ({
      truck_id: t.id,
      day: DAY,
      plate: t.plate,
      size: "medium",
      total_capacity_l: 25000,
      carrier_id: null,
      carrier_name: null,
      status: t.assignable ? "available" : "maintenance",
      available_today: true,
      day_reason: null,
      assignable: t.assignable,
      block_reason: t.assignable ? null : "en maintenance",
      rule_code: t.assignable ? null : "RM-04",
      driver_id: null,
      driver_name: null,
      assignment_source: null,
    }) as TruckDay,
);

export const DRIVER_DAYS: DriverDay[] = [
  { id: "driver-1", name: "Roger Abega" },
  { id: "driver-2", name: "Alain Nkoulou" },
  { id: "driver-5", name: "Yves Mbarga" },
].map(
  (d) =>
    ({
      driver_id: d.id,
      day: DAY,
      full_name: d.name,
      phone: null,
      carrier_id: null,
      carrier_name: null,
      status: "available",
      license_expiry: "2028-06-30",
      hazmat_cert: true,
      hazmat_expiry: "2027-12-31",
      available_today: true,
      day_reason: null,
      assignable: true,
      block_reason: null,
      rule_code: null,
      default_truck_id: null,
      default_truck_plate: null,
      truck_id: null,
      truck_plate: null,
      assignment_source: null,
    }) as DriverDay,
);
