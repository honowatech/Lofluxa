/**
 * Préparation des données des parcours L11, par l'API réelle uniquement (aucun accès direct à la base) :
 * comptes `dispatcher` et `supply`, référentiels des fichiers modèles `data/templates/*.xlsx`, et — pour les
 * captures — le jeu fictif `data/fixtures/demo_douala`. Tout est idempotent : relançable sur une base déjà garnie.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, type APIRequestContext } from "@playwright/test";

export const API = "http://localhost:8000/api/v1";
export const ADMIN = { email: "admin@honowa.tech", password: "admin-dev-only" };
export const DISPATCHER = { email: "l11.dispatcher@ola.example", password: "l11-dispatcher-dev-only" };
export const SUPPLY = { email: "l11.supply@ola.example", password: "l11-supply-dev-only" };
export const MANAGER = { email: "l11.direction@ola.example", password: "l11-direction-dev-only" };

const ROOT = path.resolve(process.cwd(), "..");
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

type Json = Record<string, unknown>;
interface Named {
  id: string;
  code?: string;
  name?: string;
  plate?: string;
  full_name?: string;
}

export async function login(request: APIRequestContext, account: { email: string; password: string }) {
  const response = await request.post(`${API}/auth/login`, { data: account });
  return response.ok() ? ((await response.json()) as { access_token: string }).access_token : null;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function all<T = Named>(request: APIRequestContext, token: string, resource: string): Promise<T[]> {
  const response = await request.get(`${API}${resource}`, { headers: bearer(token), params: { limit: 500 } });
  expect(response.ok(), `GET ${resource}`).toBeTruthy();
  return ((await response.json()) as { items: T[] }).items;
}

async function post<T = Named>(
  request: APIRequestContext,
  token: string,
  resource: string,
  data: Json,
): Promise<T> {
  const response = await request.post(`${API}${resource}`, { headers: bearer(token), data });
  expect(response.ok(), `POST ${resource} → ${response.status()} ${await response.text()}`).toBeTruthy();
  return (await response.json()) as T;
}

/** Comptes des parcours (créés par l'administrateur du seed s'ils n'existent pas). */
export async function ensureAccounts(request: APIRequestContext): Promise<string> {
  const admin = await login(request, ADMIN);
  expect(admin, "compte admin du seed (./scripts/dev_setup.sh)").not.toBeNull();
  const accounts = [
    { ...DISPATCHER, role: "dispatcher", full_name: "Awa Dispatcher" },
    { ...SUPPLY, role: "supply", full_name: "Brice Supply" },
    { ...MANAGER, role: "manager", full_name: "Mme Direction" },
  ];
  for (const account of accounts) {
    if (!(await login(request, account))) await post(request, admin as string, "/users", account);
  }
  return admin as string;
}

/** Référentiels minimaux : import des fichiers modèles (dépôts → stations → camions → chauffeurs). */
export async function ensureTemplates(request: APIRequestContext, admin: string): Promise<void> {
  if ((await all(request, admin, "/stations")).length > 0) return;
  for (const kind of ["depots", "stations", "trucks", "drivers"]) {
    const preview = await request.post(`${API}/imports/${kind}/preview`, {
      headers: bearer(admin),
      multipart: {
        file: {
          name: `${kind}.xlsx`,
          mimeType: XLSX,
          buffer: readFileSync(path.join(ROOT, "data", "templates", `${kind}.xlsx`)),
        },
      },
    });
    expect(preview.ok(), `prévisualisation ${kind}`).toBeTruthy();
    const batch = (await preview.json()) as { id: string };
    const applied = await request.post(`${API}/imports/${batch.id}/apply`, { headers: bearer(admin) });
    expect(applied.ok(), `application ${kind}`).toBeTruthy();
  }
}

interface DemoProblem {
  stations: {
    id: string;
    code: string;
    name: string;
    lat: number;
    lon: number;
    max_truck_size: string;
    unload_time_min: number;
  }[];
  trucks: {
    id: string;
    plate: string;
    size: string;
    carrier_id: string;
    status: string;
    compartments: { position: number; capacity_l: number }[];
  }[];
  drivers: {
    id: string;
    full_name: string;
    carrier_id: string;
    license_expiry: string;
    hazmat_cert: boolean;
    hazmat_expiry: string;
    status: string;
    default_truck_id: string | null;
  }[];
  orders: {
    station_id: string;
    product_id: string;
    requested_l: number;
    priority: string;
    window: [number, number] | null;
  }[];
}

const hm = (seconds: number) =>
  `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}`;

/**
 * Jeu fictif `demo_douala` (12 stations de Douala, 4 camions, 5 chauffeurs, 20 commandes), complété par un camion
 * en panne et trois chauffeurs non affectables (permis expiré, habilitation expirée, congé) pour illustrer RM-03
 * et RM-04. Les commandes ne sont créées que si le jour n'en a aucune.
 */
export async function ensureDemo(request: APIRequestContext, admin: string, day: string): Promise<void> {
  const problem = JSON.parse(
    readFileSync(path.join(ROOT, "data", "fixtures", "demo_douala", "problem.json"), "utf8"),
  ) as DemoProblem;
  const products = new Map((await all(request, admin, "/products")).map((p) => [p.code as string, p.id]));
  const stations = new Map((await all(request, admin, "/stations")).map((s) => [s.code as string, s.id]));
  const carriers = new Map((await all(request, admin, "/carriers")).map((c) => [c.name as string, c.id]));
  const trucks = new Map((await all(request, admin, "/trucks")).map((t) => [t.plate as string, t.id]));
  const drivers = new Set((await all(request, admin, "/drivers")).map((d) => d.full_name as string));

  const weekdays = ["mon", "tue", "wed", "thu", "fri", "sat"];
  const opening_hours = { ...Object.fromEntries(weekdays.map((d) => [d, [["06:00", "18:00"]]])), sun: [] };
  for (const [index, station] of problem.stations.entries()) {
    if (stations.has(station.code)) continue;
    // Une station sans cuve de pétrole : sa commande de pétrole est confirmée avec un avertissement (F3.4).
    const tanks = ["SUPER", "GASOIL", "PETROLE"]
      .filter((code) => !(index === 5 && code === "PETROLE"))
      .map((code) => ({
        product_id: products.get(code),
        capacity_l: code === "PETROLE" ? 12000 : 30000,
        safety_stock_l: code === "PETROLE" ? 1500 : 3000,
      }));
    const created = await post(request, admin, "/stations", {
      code: station.code,
      name: station.name,
      region: "Littoral",
      city: "Douala",
      lat: station.lat,
      lon: station.lon,
      opening_hours,
      max_truck_size: station.max_truck_size,
      unload_time_min: station.unload_time_min,
      active: true,
      tanks,
    });
    stations.set(station.code, created.id);
  }

  const carrierNames: Record<string, string> = { "TR-OLA": "OLA Flotte", "TR-SOTRACAM": "Sotracam" };
  const carrierOf = async (key: string) => {
    const name = carrierNames[key] ?? key;
    if (!carriers.has(name)) {
      carriers.set(name, (await post(request, admin, "/carriers", { name, type: "third_party" })).id);
    }
    return carriers.get(name) as string;
  };

  const truckIds = new Map<string, string>();
  const extraTruck = {
    id: "L11-PANNE",
    plate: "LT-777-ZZ",
    size: "large",
    carrier_id: "TR-OLA",
    status: "broken",
    compartments: [
      { position: 1, capacity_l: 12000 },
      { position: 2, capacity_l: 12000 },
    ],
  };
  for (const truck of [...problem.trucks, extraTruck]) {
    if (!trucks.has(truck.plate)) {
      const created = await post(request, admin, "/trucks", {
        plate: truck.plate,
        carrier_id: await carrierOf(truck.carrier_id),
        size: truck.size,
        status: truck.status,
        total_capacity_l: truck.compartments.reduce((sum, c) => sum + c.capacity_l, 0),
        compartments: truck.compartments.map((c) => ({
          position: c.position,
          capacity_l: c.capacity_l,
          allowed_product_ids: null,
        })),
      });
      trucks.set(truck.plate, created.id);
    }
    truckIds.set(truck.id, trucks.get(truck.plate) as string);
  }

  const extraDrivers = [
    {
      full_name: "Samuel Etoga",
      license_expiry: "2026-12-31",
      hazmat_expiry: "2027-08-31",
      status: "available",
    },
    {
      full_name: "Blaise Nkono",
      license_expiry: "2028-02-28",
      hazmat_expiry: "2027-01-05",
      status: "available",
    },
    { full_name: "Aline Fotso", license_expiry: "2029-02-28", hazmat_expiry: "2027-02-02", status: "leave" },
  ].map((driver) => ({ ...driver, id: "", carrier_id: "TR-OLA", hazmat_cert: true, default_truck_id: null }));
  for (const driver of [...problem.drivers, ...extraDrivers]) {
    if (drivers.has(driver.full_name)) continue;
    await post(request, admin, "/drivers", {
      full_name: driver.full_name,
      phone: null,
      license_no: null,
      license_expiry: driver.license_expiry,
      hazmat_cert: driver.hazmat_cert,
      hazmat_expiry: driver.hazmat_expiry,
      carrier_id: await carrierOf(driver.carrier_id),
      status: driver.status,
      default_truck_id: driver.default_truck_id ? (truckIds.get(driver.default_truck_id) ?? null) : null,
    });
  }

  const existing = await request.get(`${API}/orders`, { headers: bearer(admin), params: { day, limit: 1 } });
  if (((await existing.json()) as { total: number }).total > 0) return;
  const codeOf = new Map(problem.stations.map((station) => [station.id, station.code]));
  for (const order of problem.orders) {
    await post(request, admin, "/orders", {
      day,
      station_id: stations.get(codeOf.get(order.station_id) as string),
      product_id: products.get(order.product_id),
      requested_l: order.requested_l,
      priority: order.priority,
      window_start: order.window ? hm(order.window[0]) : null,
      window_end: order.window ? hm(order.window[1]) : null,
      comment: null,
    });
  }
}
