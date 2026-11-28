/**
 * Mise en données par l'API (aucun accès direct à la base) à partir d'un jeu du moteur
 * (`data/fixtures/<jeu>/problem.json`) : référentiels, commandes confirmées et stocks du jour, puis calcul.
 *
 * Depuis un test Playwright :   const { planId } = await seedPlan({ fixture: "demo_douala", day });
 * En ligne de commande :        node --experimental-strip-types e2e/l12-seed.ts demo_douala 2027-01-12
 *
 * Tout ce que ce script crée est préfixé `ZL12` (codes de dépôts et de stations, immatriculations, numéros de
 * permis, noms de stations, de dépôts, de chauffeurs et de transporteurs) : les jeux d'essai des autres lots,
 * dans la même base, ne réutilisent ni ne modifient ces lignes, et réciproquement. Le « Z » les classe en fin
 * de toute liste triée par code ou par nom : un parcours d'un autre lot qui prend « la première station » (ou
 * le premier camion) ne tombe jamais sur une ligne de ce lot.
 * Les dépôts des autres lots reçoivent un stock nul pour le jour d'essai : le plan ne charge qu'aux dépôts du jeu.
 * Hors de ses parcours, ce lot ne doit pas non plus fournir de ressources aux plans des autres : `releaseSeed()`
 * (à appeler en fin de fichier de test) met ses camions en « réservé », ses chauffeurs en « repos » et désactive
 * ses dépôts ; `seedPlan()` les remet en service.
 * Rejouable sur une base déjà remplie : les référentiels sont retrouvés par code / immatriculation / nom ; les
 * commandes et le plan sont créés à chaque appel, pour un jour encore vierge (`freshDay()` : ni commande ni
 * plan, pris dans une plage d'années réservée à ce lot).
 * Les camions et chauffeurs étrangers au jeu sont marqués indisponibles pour le jour, afin que le plan ne
 * dépende pas des autres jeux déjà chargés.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.TOURNEO_API ?? "http://localhost:8000/api/v1";
export const ADMIN = { email: "admin@honowa.tech", password: "admin-dev-only" };
const HERE = dirname(fileURLToPath(import.meta.url));

type Json = Record<string, unknown>;
interface Named {
  id: string;
  [key: string]: unknown;
}
interface Problem {
  products: { id: string; code: string }[];
  depots: {
    id: string;
    code: string;
    name: string;
    lat: number;
    lon: number;
    windows: number[][];
    avg_wait_min: number | null;
    max_loadings_per_truck_day: number | null;
  }[];
  stations: {
    id: string;
    code: string;
    name: string;
    lat: number;
    lon: number;
    windows: number[][];
    max_truck_size: string;
    unload_time_min: number | null;
  }[];
  trucks: {
    id: string;
    plate: string;
    size: string;
    carrier_id: string | null;
    compartments: { position: number; capacity_l: number; allowed_product_ids: string[] | null }[];
  }[];
  drivers: {
    id: string;
    full_name: string;
    carrier_id: string | null;
    license_expiry: string | null;
    hazmat_cert: boolean;
    hazmat_expiry: string | null;
    default_truck_id: string | null;
  }[];
  orders: {
    id: string;
    station_id: string;
    product_id: string;
    requested_l: number;
    priority: string;
    window: number[] | null;
  }[];
  depot_stocks: { depot_id: string; product_id: string; available_l: number }[];
}

export interface SeedOptions {
  fixture?: "demo_douala" | "demo_shortage" | "demo_scale";
  day: string;
  /** Stock du jour par code produit (remplace celui du jeu) : provoquer des commandes non servies. */
  stocks?: Record<string, number>;
  /** Surcharge ponctuelle des paramètres du moteur (`POST /plans/compute {params}`). */
  params?: Json;
  /** Ne garder que les n premiers camions du jeu (les autres sont indisponibles pour le jour). */
  maxTrucks?: number;
  /** Ne pas lancer le calcul. */
  skipCompute?: boolean;
}

export interface SeedResult {
  day: string;
  planId: string | null;
  token: string;
  truckIds: Record<string, string>;
  driverIds: Record<string, string>;
}

/** Préfixes de tout ce que ce lot crée dans la base partagée par les parcours des autres lots (codes, noms). */
export const TAG = "ZL12-";
export const NAME_TAG = "ZL12 ";
/** Permis et habilitations des chauffeurs du jeu : valables sur toute la plage de jours du lot. */
const DOCUMENTS_EXPIRY = "2069-12-31";

/**
 * Jour encore vierge (aucune commande, aucun plan), tiré au hasard entre 2050 et 2055, à l'écart des jours des
 * autres lots : chaque exécution a son plan, même sur une base déjà remplie par des passes précédentes.
 */
export async function freshDay(): Promise<string> {
  const api = await sharedApi();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const offset = Math.floor(Math.random() * 2190);
    const date = new Date(Date.UTC(2050, 0, 1) + offset * 86_400_000);
    // Pas de dimanche : constaté sur l'API, un calcul lancé pour un dimanche avec un stock de gasoil insuffisant
    // planifie plus que le stock (36 000 L pour 30 000 L, RM-08 bloquant dès le calcul) alors que le même jeu,
    // un autre jour, s'arrête au stock. Défaut du moteur signalé (docs/questions/l12-ecran-plan.md, A6) ;
    // les parcours de l'écran n'ont pas à en dépendre.
    if (date.getUTCDay() === 0) continue;
    const day = date.toISOString().slice(0, 10);
    const [orders, plans] = await Promise.all([
      api.call<{ total: number }>("GET", `/orders?day=${day}&limit=1`),
      api.call<{ total: number }>("GET", `/plans?day=${day}&limit=1`),
    ]);
    if (orders.total === 0 && plans.total === 0) return day;
  }
  throw new Error("Aucun jour vierge trouvé entre 2050 et 2055");
}

/** Une seule connexion par processus de test (les connexions sont limitées par minute et par adresse). */
let shared: Promise<Api> | null = null;
function sharedApi(): Promise<Api> {
  shared ??= Api.login();
  return shared;
}

const hm = (seconds: number) =>
  `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}`;

function openingHours(windows: number[][]): Json {
  const ranges = windows.map(([from, to]) => [hm(from), hm(Math.min(to, 86_340))]);
  return Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, ranges]));
}

export class Api {
  readonly token: string;
  constructor(token: string) {
    this.token = token;
  }

  static async login(credentials = ADMIN): Promise<Api> {
    const response = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
    });
    if (!response.ok) throw new Error(`Connexion refusée (${response.status})`);
    return new Api(((await response.json()) as { access_token: string }).access_token);
  }

  async call<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 400)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async all<T extends Named = Named>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let offset = 0; ; offset += 200) {
      const sep = path.includes("?") ? "&" : "?";
      const page = await this.call<{ items: T[]; total: number }>(
        "GET",
        `${path}${sep}limit=200&offset=${offset}`,
      );
      out.push(...page.items);
      if (out.length >= page.total || page.items.length === 0) return out;
    }
  }

  /** Suit une tâche de calcul jusqu'à son terme et renvoie l'identifiant du plan. */
  async waitTask(taskId: string, timeoutMs = 180_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const task = await this.call<{ state: string; plan_id: string | null; error: string | null }>(
        "GET",
        `/tasks/${taskId}`,
      );
      if (task.state === "succeeded" && task.plan_id) return task.plan_id;
      if (task.state === "failed") throw new Error(`Calcul en échec : ${task.error}`);
      await new Promise((r) => setTimeout(r, 700));
    }
    throw new Error("Calcul trop long (un worker Celery tourne-t-il ?)");
  }
}

/**
 * Met en service (ou retire du service) tout ce que ce lot a créé comme ressources planifiables : camions,
 * chauffeurs, dépôts. Retirées, elles n'entrent dans aucun calcul de plan lancé par un autre lot.
 */
async function setInService(api: Api, inService: boolean): Promise<void> {
  const [trucks, drivers, depots] = await Promise.all([
    api.all("/trucks"),
    api.all("/drivers"),
    api.all("/depots"),
  ]);
  for (const truck of trucks.filter((t) => String(t.plate).startsWith(TAG))) {
    const status = inService ? "available" : "reserved";
    if (truck.status !== status) await api.call("PUT", `/trucks/${truck.id}`, { status });
  }
  for (const driver of drivers.filter((d) => String(d.full_name).startsWith(NAME_TAG))) {
    const status = inService ? "available" : "rest";
    // Les documents sont remis à la date du lot : un chauffeur créé par une version antérieure du script reste affectable.
    const upToDate = driver.license_expiry === DOCUMENTS_EXPIRY && driver.hazmat_expiry === DOCUMENTS_EXPIRY;
    if (driver.status !== status || !upToDate) {
      await api.call("PUT", `/drivers/${driver.id}`, {
        status,
        license_expiry: DOCUMENTS_EXPIRY,
        hazmat_cert: true,
        hazmat_expiry: DOCUMENTS_EXPIRY,
      });
    }
  }
  for (const depot of depots.filter((d) => String(d.code).startsWith(TAG))) {
    if (depot.active !== inService) await api.call("PUT", `/depots/${depot.id}`, { active: inService });
  }
}

/** À appeler en fin de fichier de test (`test.afterAll`) : les ressources du lot sortent du service. */
export async function releaseSeed(): Promise<void> {
  await setInService(await sharedApi(), false);
}

export async function seedPlan(options: SeedOptions): Promise<SeedResult> {
  const { fixture = "demo_douala", day } = options;
  const problem = JSON.parse(
    readFileSync(resolve(HERE, `../../data/fixtures/${fixture}/problem.json`), "utf8"),
  ) as Problem;
  const api = await sharedApi();

  const products = await api.all("/products");
  const productId = (code: string) => {
    const found = products.find((p) => p.code === problem.products.find((x) => x.id === code)?.code);
    if (!found) throw new Error(`Produit ${code} absent du seed`);
    return found.id;
  };

  // Transporteurs
  const carriers = await api.all("/carriers");
  const carrierIds: Record<string, string> = {};
  for (const key of new Set([...problem.trucks, ...problem.drivers].map((x) => x.carrier_id))) {
    if (!key) continue;
    const name = `${NAME_TAG}${key}`;
    const existing = carriers.find((c) => c.name === name);
    carrierIds[key] = existing?.id ?? (await api.call<Named>("POST", "/carriers", { name })).id;
  }

  // Dépôts
  const depots = await api.all("/depots");
  const depotIds: Record<string, string> = {};
  for (const depot of problem.depots) {
    const code = `${TAG}${depot.code}`;
    const existing = depots.find((d) => d.code === code);
    depotIds[depot.id] =
      existing?.id ??
      (
        await api.call<Named>("POST", "/depots", {
          code,
          name: `${NAME_TAG}${depot.name}`,
          lat: depot.lat,
          lon: depot.lon,
          opening_hours: openingHours(depot.windows),
          avg_wait_min: depot.avg_wait_min,
          max_loadings_per_truck_day: depot.max_loadings_per_truck_day,
        })
      ).id;
  }

  // Stations
  const stations = await api.all("/stations");
  const stationIds: Record<string, string> = {};
  for (const station of problem.stations) {
    const code = `${TAG}${station.code}`;
    const existing = stations.find((s) => s.code === code);
    stationIds[station.id] =
      existing?.id ??
      (
        await api.call<Named>("POST", "/stations", {
          code,
          name: `${NAME_TAG}${station.name}`,
          lat: station.lat,
          lon: station.lon,
          opening_hours: openingHours(station.windows),
          max_truck_size: station.max_truck_size,
          unload_time_min: station.unload_time_min,
        })
      ).id;
  }

  // Camions (avec compartiments)
  const trucks = await api.all("/trucks");
  const truckIds: Record<string, string> = {};
  const usedTrucks = problem.trucks.slice(0, options.maxTrucks ?? problem.trucks.length);
  for (const truck of problem.trucks) {
    const plate = `${TAG}${truck.plate}`;
    const existing = trucks.find((t) => t.plate === plate);
    truckIds[truck.id] =
      existing?.id ??
      (
        await api.call<Named>("POST", "/trucks", {
          plate,
          size: truck.size,
          carrier_id: truck.carrier_id ? carrierIds[truck.carrier_id] : null,
          compartments: truck.compartments.map((c) => ({
            position: c.position,
            capacity_l: c.capacity_l,
            allowed_product_ids: c.allowed_product_ids?.map(productId) ?? null,
          })),
        })
      ).id;
  }

  // Chauffeurs
  const drivers = await api.all("/drivers");
  const driverIds: Record<string, string> = {};
  for (const driver of problem.drivers) {
    const fullName = `${NAME_TAG}${driver.full_name}`;
    const existing = drivers.find((d) => d.full_name === fullName);
    driverIds[driver.id] =
      existing?.id ??
      (
        await api.call<Named>("POST", "/drivers", {
          full_name: fullName,
          phone: `+237 6 77 00 ${driver.id.replace(/\D/g, "").padStart(2, "0")} 00`,
          license_no: `${TAG}${fixture.replace("demo_", "").toUpperCase()}-${driver.id}`,
          license_expiry: DOCUMENTS_EXPIRY,
          hazmat_cert: true,
          hazmat_expiry: DOCUMENTS_EXPIRY,
          carrier_id: driver.carrier_id ? carrierIds[driver.carrier_id] : null,
          default_truck_id: driver.default_truck_id ? truckIds[driver.default_truck_id] : null,
        })
      ).id;
  }

  await setInService(api, true);

  // Disponibilité du jour : seules les ressources du jeu sont disponibles.
  const wantedTrucks = new Set(usedTrucks.map((t) => truckIds[t.id]));
  const allTrucks = await api.all("/trucks");
  await api.call("PUT", `/availability/trucks?day=${day}`, {
    items: allTrucks.map((t) => ({
      truck_id: t.id,
      available: wantedTrucks.has(t.id),
      reason: wantedTrucks.has(t.id) ? null : "Hors jeu de données",
    })),
  });
  const wantedDrivers = new Set(problem.drivers.map((d) => driverIds[d.id]));
  const allDrivers = await api.all("/drivers");
  await api.call("PUT", `/availability/drivers?day=${day}`, {
    items: allDrivers.map((d) => ({
      driver_id: d.id,
      available: wantedDrivers.has(d.id),
      reason: wantedDrivers.has(d.id) ? null : "Hors jeu de données",
    })),
  });

  // Stocks du jour : ceux du jeu pour ses dépôts ; zéro partout ailleurs, pour que le plan ne charge pas au
  // dépôt d'un autre lot (un stock non renseigné n'est qu'un avertissement, RM-08).
  const ownDepots = new Set(Object.values(depotIds));
  const foreignDepots = (await api.all("/depots")).filter((depot) => !ownDepots.has(depot.id));
  await api.call("PUT", `/availability/depot-stocks?day=${day}`, {
    items: [
      ...problem.depot_stocks.map((s) => ({
        depot_id: depotIds[s.depot_id],
        product_id: productId(s.product_id),
        available_l: options.stocks?.[s.product_id] ?? s.available_l,
      })),
      ...foreignDepots.flatMap((depot) =>
        products.map((product) => ({ depot_id: depot.id, product_id: product.id, available_l: 0 })),
      ),
    ],
  });

  // Commandes du jour, puis confirmation en masse
  const orderIds: string[] = [];
  for (const order of problem.orders) {
    const created = await api.call<Named>("POST", "/orders", {
      day,
      station_id: stationIds[order.station_id],
      product_id: productId(order.product_id),
      requested_l: order.requested_l,
      priority: order.priority,
      window_start: order.window ? hm(order.window[0]) : null,
      window_end: order.window ? hm(order.window[1]) : null,
    });
    orderIds.push(created.id);
  }
  await api.call("POST", "/orders/confirm", { order_ids: orderIds });

  let planId: string | null = null;
  if (!options.skipCompute) {
    const { task_id } = await api.call<{ task_id: string }>("POST", "/plans/compute", {
      day,
      params: options.params,
    });
    planId = await api.waitTask(task_id);
  }
  return { day, planId, token: api.token, truckIds, driverIds };
}

// Exécution directe : node --experimental-strip-types e2e/l12-seed.ts <jeu> <jour>
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [fixture = "demo_douala", requestedDay, ...rest] = process.argv.slice(2);
  const stocks = Object.fromEntries(rest.map((pair) => pair.split("=")).map(([k, v]) => [k, Number(v)]));
  (requestedDay ? Promise.resolve(requestedDay) : freshDay())
    .then((day) => seedPlan({ fixture: fixture as SeedOptions["fixture"], day, stocks }))
    .then((result) => console.log(JSON.stringify({ day: result.day, planId: result.planId })))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
