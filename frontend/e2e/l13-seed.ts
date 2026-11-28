/**
 * Mise en données du lot L13 contre la vraie API : ressources propres au lot (préfixe L13), comptes `fleet`,
 * `dispatcher` et `supply`, stocks, commandes confirmées, plan calculé puis publié pour le jour demandé.
 *
 * Depuis un test Playwright : `const seed = await seedPublishedPlan()` (jour vierge choisi automatiquement).
 * En ligne de commande      : `node --experimental-strip-types e2e/l13-seed.ts 2031-03-04`
 * Prérequis : API sur :8000 et un worker Celery (le calcul du plan est une tâche de fond).
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.TOURNEO_API ?? "http://localhost:8000/api/v1";
const ADMIN = { email: "admin@honowa.tech", password: "admin-dev-only" };

export const ACCOUNTS = {
  fleet: { email: "l13.fleet@ola.example", password: "l13-fleet-dev-only", full_name: "Brigitte Ngo Bassa" },
  dispatcher: {
    email: "l13.dispatch@ola.example",
    password: "l13-dispatch-dev-only",
    full_name: "Serge Mbarga",
  },
  supply: { email: "l13.supply@ola.example", password: "l13-supply-dev-only", full_name: "Aïcha Njoya" },
} as const;
type RoleName = keyof typeof ACCOUNTS;

interface Paged<T> {
  items: T[];
  total: number;
}
interface Named {
  id: string;
  code: string;
}

export async function call<T>(
  path: string,
  {
    method = "GET",
    token,
    body,
    form,
  }: { method?: string; token?: string; body?: unknown; form?: FormData } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 600)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function login(email: string, password: string): Promise<string> {
  const pair = await call<{ access_token: string }>("/auth/login", {
    method: "POST",
    body: { email, password },
  });
  return pair.access_token;
}

/** Crée les comptes de test absents (sans tentative de connexion : `/auth/login` est limité en débit). */
async function ensureUsers(admin: string): Promise<void> {
  const users = (await call<Paged<{ email: string }>>("/users?limit=200", { token: admin })).items;
  for (const role of Object.keys(ACCOUNTS) as RoleName[]) {
    if (users.some((user) => user.email === ACCOUNTS[role].email)) continue;
    await call("/users", { method: "POST", token: admin, body: { ...ACCOUNTS[role], role } });
  }
}

/** Lit une liste entière, page par page (une base partagée dépasse vite 200 lignes). */
export async function listAll<T>(path: string, token: string): Promise<T[]> {
  const items: T[] = [];
  const separator = path.includes("?") ? "&" : "?";
  for (;;) {
    const page = await call<Paged<T>>(`${path}${separator}limit=200&offset=${items.length}`, { token });
    items.push(...page.items);
    if (page.items.length === 0 || items.length >= page.total) return items;
  }
}

/** Dépôts du lot : les tournées chargent au premier ; le second sert de dépôt de repli (pénurie). */
const DEPOTS: [string, string, number, number][] = [
  ["L13-DEPOT-A", "Dépôt Douala Port (L13)", 4.0435, 9.7043],
  ["L13-DEPOT-B", "Dépôt Bonabéri (L13)", 4.0712, 9.6701],
];
/** Camions et chauffeurs disponibles au calcul du plan : deux camions, donc deux tournées chacun. */
const PLANNED_TRUCKS = 2;

const HOURS = Object.fromEntries(
  ["mon", "tue", "wed", "thu", "fri", "sat"].map((weekday) => [weekday, [["06:00", "20:00"]]]),
);

/** Stations de Douala ajoutées aux deux du fichier modèle (code, nom, lat, lon, e-mail du gérant). */
const STATIONS: [string, string, number, number, string | null][] = [
  ["L13-DEIDO", "OLA Deido (L13)", 4.0672, 9.7071, "deido@example.cm"],
  ["L13-BONAP", "OLA Bonapriso (L13)", 4.0262, 9.6968, "bonapriso@example.cm"],
  ["L13-NDOKO", "OLA Ndokoti (L13)", 4.0461, 9.7402, "ndokoti@example.cm"],
  ["L13-BEPAN", "OLA Bépanda (L13)", 4.0621, 9.7289, null],
  ["L13-LOGBA", "OLA Logbaba (L13)", 4.0398, 9.7741, "logbaba@example.cm"],
  ["L13-MAKEP", "OLA Makepe (L13)", 4.0836, 9.7553, "makepe@example.cm"],
  ["L13-YASSA", "OLA Yassa (L13)", 4.0015, 9.8031, null],
  ["L13-BONAM", "OLA Bonamoussadi (L13)", 4.0903, 9.7362, "bonamoussadi@example.cm"],
];
/** Camions (immatriculation, gabarit, capacités des compartiments). */
const TRUCKS: [string, "medium" | "large", number[]][] = [
  ["L13 782 KD", "large", [12000, 10000, 8000, 5000]],
  ["L13 915 GH", "large", [11000, 11000, 11000]],
  ["L13 334 BX", "medium", [9000, 9000, 6000]],
  ["L13 608 EM", "medium", [8000, 7000, 5000]],
];
/** Chauffeurs, retrouvés par leur numéro de permis (`L13-…`). */
const DRIVERS = [
  "Emmanuel Tchoua (L13)",
  "Rodrigue Essomba (L13)",
  "Alain Fotso (L13)",
  "Hervé Ndjock (L13)",
];
/** Commandes du jour (station, produit, litres, priorité). */
const ORDERS: [string, string, number, "normal" | "urgent"][] = [
  ["L13-DEIDO", "SUPER", 12000, "normal"],
  ["L13-DEIDO", "GASOIL", 8000, "normal"],
  ["L13-BONAP", "SUPER", 9000, "urgent"],
  ["L13-NDOKO", "GASOIL", 11000, "normal"],
  ["L13-NDOKO", "SUPER", 10000, "normal"],
  ["L13-BEPAN", "GASOIL", 9000, "normal"],
  ["L13-BEPAN", "PETROLE", 5000, "normal"],
  ["L13-LOGBA", "GASOIL", 11000, "normal"],
  ["L13-MAKEP", "SUPER", 9000, "normal"],
  ["L13-MAKEP", "GASOIL", 6000, "normal"],
  ["L13-YASSA", "GASOIL", 8000, "urgent"],
  ["L13-BONAM", "SUPER", 8000, "normal"],
  ["L13-BONAM", "PETROLE", 5000, "normal"],
];

/** Stations, camions et chauffeurs supplémentaires (créés une seule fois, retrouvés par code / nom). */
async function ensureFleet(admin: string, productId: (code: string) => string): Promise<void> {
  const depots = await listAll<Named>("/depots", admin);
  for (const [code, name, lat, lon] of DEPOTS) {
    if (depots.some((depot) => depot.code === code)) continue;
    await call("/depots", {
      method: "POST",
      token: admin,
      body: {
        code,
        name,
        operator: "scdp",
        lat,
        lon,
        opening_hours: Object.fromEntries(
          Object.keys(HOURS).map((weekday) => [weekday, [["06:00", "18:00"]]]),
        ),
        avg_wait_min: 90,
        max_loadings_per_truck_day: 2,
      },
    });
  }
  const stations = await listAll<Named>("/stations", admin);
  for (const [code, name, lat, lon, contact_email] of STATIONS) {
    if (stations.some((station) => station.code === code)) continue;
    await call("/stations", {
      method: "POST",
      token: admin,
      body: {
        code,
        name,
        region: "Littoral",
        city: "Douala",
        lat,
        lon,
        opening_hours: HOURS,
        max_truck_size: "large",
        unload_time_min: 35,
        contact_name: `Gérant ${name}`,
        contact_email,
        tanks: ["SUPER", "GASOIL", "PETROLE"].map((product) => ({
          product_id: productId(product),
          capacity_l: 40000,
          safety_stock_l: 4000,
        })),
      },
    });
  }
  const trucks = await listAll<{ id: string; plate: string }>("/trucks", admin);
  for (const [plate, size, capacities] of TRUCKS) {
    if (trucks.some((truck) => truck.plate === plate)) continue;
    await call("/trucks", {
      method: "POST",
      token: admin,
      body: {
        plate,
        size,
        avg_speed_kmh: 40,
        cost_per_km: 600,
        compartments: capacities.map((capacity_l, index) => ({ position: index + 1, capacity_l })),
      },
    });
  }
  const drivers = (await call<Paged<{ license_no: string | null }>>("/drivers?limit=200", { token: admin }))
    .items;
  for (const [index, full_name] of DRIVERS.entries()) {
    const license_no = `L13-2022-01${index}7`;
    if (drivers.some((driver) => driver.license_no === license_no)) continue;
    await call("/drivers", {
      method: "POST",
      token: admin,
      body: {
        full_name,
        phone: `+237 677 10 20 ${String(30 + index)}`,
        license_no,
        license_expiry: "2045-12-31",
        hazmat_cert: true,
        hazmat_expiry: "2045-12-31",
      },
    });
  }
}

export interface SeedLoad {
  compartment_id: string;
  compartment_position: number;
  product_id: string;
  product_code: string;
  planned_l: number;
}
export interface SeedStop {
  id: string;
  seq: number;
  station_code: string;
  station_name: string;
  planned_arrival_at: string;
  deliveries: { order_id: string; product_code: string; planned_l: number }[];
}
export interface SeedTrip {
  id: string;
  seq: number;
  truck_id: string;
  truck_plate: string;
  driver_id: string;
  driver_name: string;
  depot_id: string;
  planned_depart_at: string;
  loads: SeedLoad[];
  stops: SeedStop[];
}
export interface Seed {
  day: string;
  planId: string;
  /** Jeton administrateur, pour préparer des états par l'API sans nouvelle connexion (débit limité). */
  adminToken: string;
  trips: SeedTrip[];
  /** Les deux dépôts du lot : `[dépôt de chargement, dépôt de repli]`. */
  depots: { id: string; code: string; name: string }[];
}

/** Écrit une disponibilité du jour pour toute une liste, par lots de 400 lignes au plus. */
async function put<T>(path: string, token: string, rows: T[], items: (row: T) => unknown[]): Promise<void> {
  const all = rows.flatMap(items);
  for (let start = 0; start < all.length; start += 400) {
    await call(path, { method: "PUT", token, body: { items: all.slice(start, start + 400) } });
  }
}

/** Jour sans aucun plan, loin dans le futur (hors dimanche : dépôt fermé) : chaque exécution a le sien. */
async function freeDay(admin: string): Promise<string> {
  const date = new Date(Date.UTC(2030, 0, 1) + (Math.floor(Date.now() / 1000) % 5000) * 86_400_000);
  for (;;) {
    const day = date.toISOString().slice(0, 10);
    if (date.getUTCDay() !== 0) {
      const plans = await call<Paged<unknown>>(`/plans?day=${day}&limit=1`, { token: admin });
      if (plans.total === 0) return day;
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
}

/** Sans `requestedDay`, un jour encore vierge est choisi (voir `Seed.day`). */
export async function seedPublishedPlan(requestedDay?: string): Promise<Seed> {
  const admin = await login(ADMIN.email, ADMIN.password);
  const day = requestedDay ?? (await freeDay(admin));
  await ensureUsers(admin);

  // Le script ne s'appuie que sur SES ressources (préfixe L13) : sur une base partagée avec d'autres lots,
  // les dépôts, camions et chauffeurs des autres sont neutralisés pour ce jour seulement.
  const products = await listAll<Named>("/products", admin);
  const productId = (code: string) => products.find((product) => product.code === code)?.id as string;
  await ensureFleet(admin, productId);

  const allDepots = await listAll<Named & { name: string }>("/depots", admin);
  const depots = DEPOTS.map(([code]) => allDepots.find((depot) => depot.code === code)).filter(
    (depot): depot is Named & { name: string } => !!depot,
  );
  const stocks = (available: (depot: Named) => number) =>
    put(`/availability/depot-stocks?day=${day}`, admin, allDepots, (depot) =>
      products.map((product) => ({
        depot_id: depot.id,
        product_id: product.id,
        available_l: available(depot),
      })),
    );
  // Au calcul, seul le premier dépôt a du stock : toutes les tournées y chargent.
  await stocks((depot) => (depot.id === depots[0].id ? 400_000 : 0));

  const plates = TRUCKS.map(([plate]) => plate);
  const trucks = await listAll<{ id: string; plate: string }>("/trucks", admin);
  const drivers = await listAll<{ id: string; license_no: string | null }>("/drivers", admin);
  const mine = (driver: { license_no: string | null }) => driver.license_no?.startsWith("L13-") ?? false;
  const rank = (driver: { license_no: string | null }) => Number(driver.license_no?.slice(-2, -1));
  const fleet = (planned: boolean) =>
    Promise.all([
      put(`/availability/trucks?day=${day}`, admin, trucks, (truck) => [
        {
          truck_id: truck.id,
          available:
            plates.includes(truck.plate) && (!planned || plates.indexOf(truck.plate) < PLANNED_TRUCKS),
        },
      ]),
      put(`/availability/drivers?day=${day}`, admin, drivers, (driver) => [
        { driver_id: driver.id, available: mine(driver) && (!planned || rank(driver) < PLANNED_TRUCKS) },
      ]),
    ]);
  await fleet(true);

  const stations = await listAll<Named>("/stations", admin);
  for (const [stationCode, productCode, requested_l, priority] of ORDERS) {
    const station = stations.find((item) => item.code === stationCode);
    if (!station) throw new Error(`Station ${stationCode} absente.`);
    await call("/orders", {
      method: "POST",
      token: admin,
      body: { day, station_id: station.id, product_id: productId(productCode), requested_l, priority },
    });
  }

  const orders = await listAll<{ id: string; status: string }>(`/orders?day=${day}`, admin);
  const drafts = orders.filter((order) => order.status === "draft").map((order) => order.id);
  if (drafts.length > 0)
    await call("/orders/confirm", { method: "POST", token: admin, body: { order_ids: drafts } });

  const { task_id } = await call<{ task_id: string }>("/plans/compute", {
    method: "POST",
    token: admin,
    body: { day },
  });
  let planId: string | null = null;
  for (let attempt = 0; attempt < 240 && !planId; attempt += 1) {
    await new Promise((done) => setTimeout(done, 1000));
    const task = await call<{ state: string; plan_id: string | null; error: string | null }>(
      `/tasks/${task_id}`,
      {
        token: admin,
      },
    );
    if (task.state === "failed") throw new Error(`Calcul du plan en échec : ${task.error}`);
    if (task.state === "succeeded") planId = task.plan_id;
  }
  if (!planId) throw new Error("Calcul du plan : délai dépassé (le worker Celery tourne-t-il ?).");
  const plan = await call<{ trips: SeedTrip[] }>(`/plans/${planId}/publish`, {
    method: "POST",
    token: admin,
  });
  // Plan publié : les autres camions et chauffeurs du lot redeviennent disponibles (remplaçants d'une panne)
  // et le second dépôt reçoit du stock (dépôt de repli d'une pénurie).
  await fleet(false);
  await stocks((depot) => (depots.some((own) => own.id === depot.id) ? 400_000 : 0));
  return {
    day,
    planId,
    adminToken: admin,
    trips: [...plan.trips].sort((a, b) => a.seq - b.seq),
    depots: depots.map(({ id, code, name }) => ({ id, code, name })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  seedPublishedPlan(process.argv[2]).then(
    (seed) => console.log(JSON.stringify({ day: seed.day, planId: seed.planId, trips: seed.trips.length })),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
