/**
 * Mise en données du lot L13 contre la vraie API : référentiels (fichiers modèles), comptes `fleet`,
 * `dispatcher` et `supply`, stocks, commandes confirmées, plan calculé puis publié pour le jour demandé.
 *
 * Depuis un test Playwright : `const seed = await seedPublishedPlan()` (jour vierge choisi automatiquement).
 * En ligne de commande      : `node --experimental-strip-types e2e/l13-seed.ts 2031-03-04`
 * Prérequis : API sur :8000 et un worker Celery (le calcul du plan est une tâche de fond).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.TOURNEO_API ?? "http://localhost:8000/api/v1";
const TEMPLATES = resolve(dirname(fileURLToPath(import.meta.url)), "../../data/templates");
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

async function importFile(admin: string, kind: string): Promise<void> {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(resolve(TEMPLATES, `${kind}.xlsx`))]), `${kind}.xlsx`);
  const batch = await call<{ id: string; status: string; report?: unknown }>(`/imports/${kind}/preview`, {
    method: "POST",
    token: admin,
    form,
  });
  if (batch.status !== "previewed") {
    throw new Error(`Import ${kind} refusé : ${JSON.stringify(batch).slice(0, 1500)}`);
  }
  // Constaté une fois : un `apply` envoyé aussitôt après le `preview` répond 404 « Lot d'import introuvable »
  // (le lot n'est pas encore visible). On réessaie brièvement.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await call(`/imports/${batch.id}/apply`, { method: "POST", token: admin });
      return;
    } catch (error) {
      if (attempt >= 4 || !String(error).includes("→ 404")) throw error;
      await new Promise((done) => setTimeout(done, 300));
    }
  }
}

const HOURS = Object.fromEntries(
  ["mon", "tue", "wed", "thu", "fri", "sat"].map((weekday) => [weekday, [["06:00", "20:00"]]]),
);

/** Stations de Douala ajoutées aux deux du fichier modèle (code, nom, lat, lon, e-mail du gérant). */
const STATIONS: [string, string, number, number, string | null][] = [
  ["ST-DEIDO", "OLA Deido", 4.0672, 9.7071, "deido@example.cm"],
  ["ST-BONAP", "OLA Bonapriso", 4.0262, 9.6968, "bonapriso@example.cm"],
  ["ST-NDOKO", "OLA Ndokoti", 4.0461, 9.7402, "ndokoti@example.cm"],
  ["ST-BEPAN", "OLA Bépanda", 4.0621, 9.7289, null],
  ["ST-LOGBA", "OLA Logbaba", 4.0398, 9.7741, "logbaba@example.cm"],
  ["ST-MAKEP", "OLA Makepe", 4.0836, 9.7553, "makepe@example.cm"],
  ["ST-YASSA", "OLA Yassa", 4.0015, 9.8031, null],
  ["ST-BONAM", "OLA Bonamoussadi", 4.0903, 9.7362, "bonamoussadi@example.cm"],
];
/** Camions (immatriculation, gabarit, capacités des compartiments). */
const TRUCKS: [string, "medium" | "large", number[]][] = [
  ["LT 782 KD", "large", [12000, 10000, 8000, 5000]],
  ["LT 915 GH", "large", [11000, 11000, 11000]],
  ["LT 334 BX", "medium", [9000, 9000, 6000]],
  ["LT 608 EM", "medium", [8000, 7000, 5000]],
];
const DRIVERS = ["Emmanuel Tchoua", "Rodrigue Essomba", "Alain Fotso", "Hervé Ndjock"];
/** Commandes du jour (station, produit, litres, priorité). */
const ORDERS: [string, string, number, "normal" | "urgent"][] = [
  ["ST-DEIDO", "SUPER", 12000, "normal"],
  ["ST-DEIDO", "GASOIL", 8000, "normal"],
  ["ST-BONAP", "SUPER", 9000, "urgent"],
  ["ST-NDOKO", "GASOIL", 11000, "normal"],
  ["ST-NDOKO", "SUPER", 10000, "normal"],
  ["ST-BEPAN", "GASOIL", 9000, "normal"],
  ["ST-BEPAN", "PETROLE", 5000, "normal"],
  ["ST-LOGBA", "GASOIL", 11000, "normal"],
  ["ST-MAKEP", "SUPER", 9000, "normal"],
  ["ST-MAKEP", "GASOIL", 6000, "normal"],
  ["ST-YASSA", "GASOIL", 8000, "urgent"],
  ["ST-BONAM", "SUPER", 8000, "normal"],
  ["ST-BONAM", "PETROLE", 5000, "normal"],
];

/** Stations, camions et chauffeurs supplémentaires (créés une seule fois, retrouvés par code / nom). */
async function ensureFleet(admin: string, productId: (code: string) => string): Promise<void> {
  const stations = (await call<Paged<Named>>("/stations?limit=200", { token: admin })).items;
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
  const trucks = (await call<Paged<{ id: string; plate: string }>>("/trucks?limit=200", { token: admin }))
    .items;
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
  const drivers = (await call<Paged<{ full_name: string }>>("/drivers?limit=200", { token: admin })).items;
  for (const [index, full_name] of DRIVERS.entries()) {
    if (drivers.some((driver) => driver.full_name === full_name)) continue;
    await call("/drivers", {
      method: "POST",
      token: admin,
      body: {
        full_name,
        phone: `+237 677 10 20 ${String(30 + index)}`,
        license_no: `CM-2022-01${index}7`,
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

  // Référentiels des fichiers modèles, importés une seule fois.
  const existing = await call<Paged<Named>>("/stations?limit=1", { token: admin });
  if (existing.total === 0) {
    for (const kind of ["depots", "stations", "trucks", "drivers"]) await importFile(admin, kind);
  }

  const depots = (await call<Paged<Named>>("/depots?limit=200", { token: admin })).items;
  const products = (await call<Paged<Named>>("/products?limit=200", { token: admin })).items;
  const productId = (code: string) => products.find((product) => product.code === code)?.id as string;
  await ensureFleet(admin, productId);
  const stations = (await call<Paged<Named>>("/stations?limit=200", { token: admin })).items;
  for (const [stationCode, productCode, requested_l, priority] of ORDERS) {
    const station = stations.find((item) => item.code === stationCode);
    if (!station) throw new Error(`Station ${stationCode} absente.`);
    await call("/orders", {
      method: "POST",
      token: admin,
      body: { day, station_id: station.id, product_id: productId(productCode), requested_l, priority },
    });
  }
  await call(`/availability/depot-stocks?day=${day}`, {
    method: "PUT",
    token: admin,
    body: {
      items: depots.flatMap((depot) =>
        products.map((product) => ({ depot_id: depot.id, product_id: product.id, available_l: 400_000 })),
      ),
    },
  });

  const orders = (
    await call<Paged<{ id: string; status: string }>>(`/orders?day=${day}&limit=200`, { token: admin })
  ).items;
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
  return { day, planId, adminToken: admin, trips: [...plan.trips].sort((a, b) => a.seq - b.seq) };
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
