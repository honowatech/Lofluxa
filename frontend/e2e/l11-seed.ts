/**
 * Jeu d'essai des parcours L11, créé par l'API réelle uniquement (aucun accès direct à la base).
 *
 * Tout ce qui est créé ici porte le préfixe `L11` (codes de stations, immatriculations, numéros de permis, noms
 * de chauffeurs et de transporteur, adresses des comptes) : rien n'est importé des fichiers modèles, rien ne
 * peut être confondu avec les données d'un autre lot, et tout est rejouable sur une base déjà remplie
 * (chaque création est précédée d'une recherche par code, immatriculation ou nom).
 *
 * Les dépôts ne sont pas créés ici : un dépôt de plus ajouterait une ligne à la grille des stocks de tous les
 * parcours. Ceux du jeu commun (`l9-seed.ts`, vérifiés par `prerequis.setup.ts`) suffisent.
 *
 * Contenu : le jeu fictif `data/fixtures/demo_douala` (12 stations de Douala avec cuves, 4 camions, 5 chauffeurs),
 * complété par un camion en panne et trois chauffeurs non affectables (permis expiré, habilitation expirée,
 * congé) pour illustrer RM-03 et RM-04.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { API, fetchTokens, type Credentials } from "./auth";

export const TAG = "L11-";
export const NAME_TAG = "L11 ";

export const DISPATCHER: Credentials = {
  email: "l11.dispatcher@ola.example",
  password: "l11-dispatcher-dev-only",
};
export const SUPPLY: Credentials = { email: "l11.supply@ola.example", password: "l11-supply-dev-only" };
export const MANAGER: Credentials = {
  email: "l11.direction@ola.example",
  password: "l11-direction-dev-only",
};
export const NAMES = {
  dispatcher: "L11 Awa Dispatcher",
  supply: "L11 Brice Supply",
  manager: "L11 Mme Direction",
};

/** Station des parcours : cuves de 30 000 L (super, gasoil) et 12 000 L (pétrole). */
export const STATION = { code: `${TAG}DLA01`, name: "OLA Akwa" };
/** Station sans cuve de pétrole : une commande de pétrole y est confirmée avec un avertissement (F3.4). */
export const STATION_NO_KEROSENE = { code: `${TAG}DLA06`, name: "OLA Bépanda" };
export const TRUCK = `${TAG}401-AA`;
export const TRUCK_SMALL = `${TAG}403-AC`;
export const DRIVER_FREE = `${NAME_TAG}Yves Mbarga`;
export const DRIVER_OTHER = `${NAME_TAG}Paul Tchoupo`;

type Json = Record<string, unknown>;
interface Row {
  id: string;
  code?: string;
  name?: string;
  plate?: string;
  full_name?: string;
  email?: string;
}

/** Petit client de l'API pour préparer des données. */
export class Api {
  constructor(private readonly token: string) {}

  static async as(credentials?: Credentials): Promise<Api> {
    return new Api((await fetchTokens(credentials)).access_token);
  }

  async call<T>(method: string, path: string, body?: Json): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok)
      throw new Error(`${method} ${path} → HTTP ${response.status} : ${await response.text()}`);
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  /** Toutes les lignes d'une liste paginée. */
  async all<T = Row>(path: string): Promise<T[]> {
    const items: T[] = [];
    for (;;) {
      const separator = path.includes("?") ? "&" : "?";
      const page = await this.call<{ items: T[]; total: number }>(
        "GET",
        `${path}${separator}limit=500&offset=${items.length}`,
      );
      items.push(...page.items);
      if (page.items.length === 0 || items.length >= page.total) return items;
    }
  }
}

async function ensureAccount(admin: Api, credentials: Credentials, role: string, full_name: string) {
  const users = await admin.all<Row>("/users");
  const existing = users.find((user) => user.email === credentials.email);
  if (!existing) await admin.call("POST", "/users", { ...credentials, role, full_name });
  // Compte créé par une version antérieure du jeu d'essai : seul son nom affiché est réaligné.
  else if (existing.full_name !== full_name) await admin.call("PUT", `/users/${existing.id}`, { full_name });
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
    status: string;
    compartments: { position: number; capacity_l: number }[];
  }[];
  drivers: {
    full_name: string;
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

const problem = (): DemoProblem =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../data/fixtures/demo_douala/problem.json", import.meta.url)),
      "utf8",
    ),
  ) as DemoProblem;

const tagged = (value: string) => `${TAG}${value.replace(/^LT-/, "")}`;

export interface Seed {
  admin: Api;
  /** Identifiants des produits par code (SUPER, GASOIL, PETROLE). */
  products: Map<string, string>;
  /** Identifiants des stations L11 par code préfixé. */
  stations: Map<string, string>;
}

/** Comptes, transporteur, stations (avec cuves), camions et chauffeurs du lot L11. Idempotent. */
export async function seedL11(): Promise<Seed> {
  const admin = await Api.as();
  await ensureAccount(admin, DISPATCHER, "dispatcher", NAMES.dispatcher);
  await ensureAccount(admin, SUPPLY, "supply", NAMES.supply);
  await ensureAccount(admin, MANAGER, "manager", NAMES.manager);

  const demo = problem();
  const products = new Map((await admin.all("/products")).map((p) => [p.code as string, p.id]));
  const stations = new Map((await admin.all("/stations")).map((s) => [s.code as string, s.id]));
  const trucks = new Map((await admin.all("/trucks")).map((t) => [t.plate as string, t.id]));
  const drivers = new Set((await admin.all("/drivers")).map((d) => d.full_name as string));

  const carrierName = `${NAME_TAG}Flotte Douala`;
  const carrier =
    (await admin.all("/carriers")).find((c) => c.name === carrierName) ??
    (await admin.call<Row>("POST", "/carriers", { name: carrierName, type: "third_party", contact: null }));

  const weekdays = ["mon", "tue", "wed", "thu", "fri", "sat"];
  const opening_hours = { ...Object.fromEntries(weekdays.map((d) => [d, [["06:00", "18:00"]]])), sun: [] };
  for (const station of demo.stations) {
    const code = `${TAG}${station.code}`;
    if (stations.has(code)) continue;
    const tanks = ["SUPER", "GASOIL", "PETROLE"]
      .filter((product) => !(code === STATION_NO_KEROSENE.code && product === "PETROLE"))
      .map((product) => ({
        product_id: products.get(product),
        capacity_l: product === "PETROLE" ? 12000 : 30000,
        safety_stock_l: product === "PETROLE" ? 1500 : 3000,
      }));
    const created = await admin.call<Row>("POST", "/stations", {
      code,
      name: station.name,
      region: "Littoral",
      city: "Douala",
      lat: station.lat,
      lon: station.lon,
      opening_hours,
      max_truck_size: station.max_truck_size,
      unload_time_min: station.unload_time_min,
      contact_name: null,
      contact_phone: null,
      contact_email: null,
      active: true,
      tanks,
    });
    stations.set(code, created.id);
  }

  const truckIds = new Map<string, string>();
  const broken = {
    id: "panne",
    plate: "LT-777-ZZ",
    size: "large",
    status: "broken",
    compartments: [
      { position: 1, capacity_l: 12000 },
      { position: 2, capacity_l: 12000 },
    ],
  };
  for (const truck of [...demo.trucks, broken]) {
    const plate = tagged(truck.plate);
    if (!trucks.has(plate)) {
      const created = await admin.call<Row>("POST", "/trucks", {
        plate,
        carrier_id: carrier.id,
        size: truck.size,
        status: truck.status,
        total_capacity_l: truck.compartments.reduce((sum, c) => sum + c.capacity_l, 0),
        avg_speed_kmh: null,
        cost_per_km: null,
        notes: null,
        compartments: truck.compartments.map((c) => ({
          position: c.position,
          capacity_l: c.capacity_l,
          allowed_product_ids: null,
        })),
      });
      trucks.set(plate, created.id);
    }
    truckIds.set(truck.id, trucks.get(plate) as string);
  }

  const blocked = [
    {
      full_name: "Samuel Etoga",
      license_expiry: "2026-12-31",
      hazmat_expiry: "2029-08-31",
      status: "available",
    },
    {
      full_name: "Blaise Nkono",
      license_expiry: "2029-02-28",
      hazmat_expiry: "2027-01-05",
      status: "available",
    },
    { full_name: "Aline Fotso", license_expiry: "2029-02-28", hazmat_expiry: "2029-02-02", status: "leave" },
  ].map((driver) => ({ ...driver, hazmat_cert: true, default_truck_id: null }));
  // Documents des chauffeurs affectables valables jusqu'en 2029 : les parcours tirent leur jour J en 2028.
  const valid = demo.drivers.map((driver) => ({
    ...driver,
    license_expiry: "2029-06-30",
    hazmat_expiry: "2029-12-31",
  }));
  for (const [index, driver] of [...valid, ...blocked].entries()) {
    const full_name = `${NAME_TAG}${driver.full_name}`;
    if (drivers.has(full_name)) continue;
    await admin.call("POST", "/drivers", {
      full_name,
      phone: null,
      license_no: `${TAG}P-${String(index + 1).padStart(3, "0")}`,
      license_expiry: driver.license_expiry,
      hazmat_cert: driver.hazmat_cert,
      hazmat_expiry: driver.hazmat_expiry,
      carrier_id: carrier.id,
      status: driver.status,
      default_truck_id: driver.default_truck_id ? (truckIds.get(driver.default_truck_id) ?? null) : null,
    });
  }
  return { admin, products, stations };
}

interface DaySummary {
  orders: { total: number };
  depot_stocks: { entered: number; last_entered_at: string | null };
}

/**
 * Jour ouvré de 2028 encore vierge (aucune commande, aucun stock saisi, aucun plan) : chaque exécution a le sien,
 * quel que soit le nombre de passages déjà faits sur la base.
 */
export async function freshDay(api: Api): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const date = new Date(Date.UTC(2028, 0, 3 + Math.floor(Math.random() * 350)));
    if (date.getUTCDay() === 0) continue;
    const day = date.toISOString().slice(0, 10);
    const summary = await api.call<DaySummary>("GET", `/availability/summary?day=${day}`);
    const plans = await api.call<{ total: number }>("GET", `/plans?day=${day}&limit=1`);
    if (
      summary.orders.total === 0 &&
      summary.depot_stocks.entered === 0 &&
      summary.depot_stocks.last_entered_at === null &&
      plans.total === 0
    )
      return day;
  }
  throw new Error("Aucun jour vierge trouvé en 2028 pour les parcours L11.");
}

const hm = (seconds: number) =>
  `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}`;

/** Les 20 commandes de `demo_douala` sur les stations L11, pour le jour donné (captures). */
export async function seedDemoOrders(seed: Seed, day: string): Promise<void> {
  const demo = problem();
  const codeOf = new Map(demo.stations.map((station) => [station.id, `${TAG}${station.code}`]));
  for (const order of demo.orders) {
    await seed.admin.call("POST", "/orders", {
      day,
      station_id: seed.stations.get(codeOf.get(order.station_id) as string),
      product_id: seed.products.get(order.product_id),
      requested_l: order.requested_l,
      priority: order.priority,
      window_start: order.window ? hm(order.window[0]) : null,
      window_end: order.window ? hm(order.window[1]) : null,
      comment: null,
    });
  }
}
