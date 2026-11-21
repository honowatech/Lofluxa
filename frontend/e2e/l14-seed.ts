/**
 * Mise en données de l'écran Comparaison A / B (lot L14), **contre la vraie API**.
 *
 * Les fichiers d'exemple de `data/templates/` ne sont pas cohérents entre eux (la journée de référence
 * d'exemple cite des stations, camions et chauffeurs absents des autres modèles) : ce module fabrique donc
 * son propre jeu fictif mais réaliste — un dépôt, quatorze stations de Douala, cinq camions, six chauffeurs
 * et une journée dispatchée à la main — et l'envoie par les routes d'import, qui sont idempotentes.
 *
 * Utilisé par `l14-comparaison.e2e.ts` et `l14-captures.e2e.ts`. Exécutable seul :
 *   node --experimental-strip-types e2e/l14-seed.ts [AAAA-MM-JJ]
 */
import { crc32 } from "node:zlib";

export const API = process.env.TOURNEO_API ?? "http://localhost:8000/api/v1";
export const ADMIN = { email: "admin@honowa.tech", password: "admin-dev-only" };
export const DISPATCHER = {
  email: "dispatch.l14@ola.example",
  password: "dispatch-l14-dev",
  full_name: "Aline Ngo Bassa",
  role: "dispatcher",
};
export const MANAGER = {
  email: "direction.l14@ola.example",
  password: "direction-l14-dev",
  full_name: "Serge Tchami",
  role: "manager",
};

/* ------------------------------------------------------------------ classeur .xlsx minimal */

export type Cell = string | number | null;
export interface Sheet {
  name: string;
  rows: Cell[][];
}

const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

function sheetXml(rows: Cell[][]): string {
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          if (value === null || value === "") return "";
          const ref = `${columnName(c)}${r + 1}`;
          return typeof value === "number"
            ? `<c r="${ref}"><v>${value}</v></c>`
            : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

/** Archive ZIP sans compression : suffisant pour un classeur de quelques dizaines de lignes. */
function zip(files: { path: string; content: string }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const data = Buffer.from(file.content, "utf8");
    const sum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // noms en UTF-8
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt32LE(sum, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    central.push(header, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export function buildXlsx(sheets: Sheet[]): Buffer {
  const ns = "http://schemas.openxmlformats.org";
  const head = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;
  return zip([
    {
      path: "[Content_Types].xml",
      content: `${head}<Types xmlns="${ns}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join("")}</Types>`,
    },
    {
      path: "_rels/.rels",
      content: `${head}<Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      path: "xl/workbook.xml",
      content: `${head}<workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${ns}/officeDocument/2006/relationships"><sheets>${sheets
        .map((sheet, i) => `<sheet name="${xml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("")}</sheets></workbook>`,
    },
    {
      path: "xl/_rels/workbook.xml.rels",
      content: `${head}<Relationships xmlns="${ns}/package/2006/relationships">${sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="${ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join("")}</Relationships>`,
    },
    ...sheets.map((sheet, i) => ({ path: `xl/worksheets/sheet${i + 1}.xml`, content: sheetXml(sheet.rows) })),
  ]);
}

/* ------------------------------------------------------------------ jeu fictif : Douala */

const DEPOT = "SCDP-DLA";

/** code, nom, lat, lon, gabarit max, produits des cuves */
const STATIONS: [string, string, number, number, string, string[]][] = [
  ["L14-AKWA", "OLA Akwa", 4.0511, 9.7085, "grand", ["SUPER", "GASOIL"]],
  ["L14-BONAB", "OLA Bonabéri", 4.0712, 9.6601, "grand", ["SUPER", "GASOIL"]],
  ["L14-DEIDO", "OLA Deido", 4.064, 9.713, "grand", ["SUPER", "GASOIL"]],
  ["L14-BONAP", "OLA Bonapriso", 4.025, 9.696, "grand", ["SUPER", "GASOIL"]],
  ["L14-BONAM", "OLA Bonamoussadi", 4.088, 9.74, "grand", ["SUPER", "GASOIL"]],
  ["L14-MAKEP", "OLA Makepe", 4.076, 9.756, "grand", ["SUPER", "GASOIL"]],
  ["L14-NDOKO", "OLA Ndokoti", 4.044, 9.741, "grand", ["SUPER", "GASOIL"]],
  ["L14-BASSA", "OLA Bassa", 4.03, 9.76, "grand", ["SUPER", "GASOIL"]],
  ["L14-LOGBA", "OLA Logbaba", 4.038, 9.78, "grand", ["SUPER", "GASOIL"]],
  ["L14-PK14", "OLA PK14", 4.07, 9.81, "grand", ["SUPER", "GASOIL", "PETROLE"]],
  ["L14-YASSA", "OLA Yassa", 4.001, 9.81, "grand", ["SUPER", "GASOIL"]],
  ["L14-VILLA", "OLA Village", 4.015, 9.75, "grand", ["SUPER", "GASOIL"]],
  ["L14-KOTTO", "OLA Kotto", 4.095, 9.765, "grand", ["SUPER", "GASOIL"]],
  ["L14-BEPAN", "OLA Bépanda", 4.06, 9.73, "grand", ["SUPER", "GASOIL"]],
];

/** immatriculation, transporteur, type, gabarit, capacités des compartiments */
const TRUCKS: [string, string, string, string, number[]][] = [
  ["LT 201 DA", "Transcam", "tiers", "grand", [11000, 11000, 11000]],
  ["LT 202 DA", "Transcam", "tiers", "grand", [11000, 11000, 11000]],
  ["LT 305 DB", "OLA Flotte", "propre", "moyen", [8000, 8000, 8000]],
  ["LT 306 DB", "OLA Flotte", "propre", "moyen", [8000, 8000, 8000]],
  ["LT 410 DC", "OLA Flotte", "propre", "petit", [6000, 6000]],
];

/** permis, nom, transporteur */
const DRIVERS: [string, string, string][] = [
  ["CM-L14-0001", "Jean Mbarga", "Transcam"],
  ["CM-L14-0002", "Paul Etoa", "Transcam"],
  ["CM-L14-0003", "Samuel Njoya", "OLA Flotte"],
  ["CM-L14-0004", "Martin Fotso", "OLA Flotte"],
  ["CM-L14-0005", "Alain Biyong", "OLA Flotte"],
  ["CM-L14-0006", "Hervé Kamga", "OLA Flotte"],
];

export function referentialWorkbooks(): Record<"depots" | "stations" | "trucks" | "drivers", Buffer> {
  const stationRows: Cell[][] = [];
  for (const [code, name, lat, lon, size, products] of STATIONS) {
    products.forEach((product, index) =>
      stationRows.push(
        index === 0
          ? [
              code,
              name,
              "Littoral",
              "Douala",
              lat,
              lon,
              "lun-dim 06:00-20:00",
              size,
              40,
              null,
              null,
              null,
              "oui",
              product,
              40000,
              4000,
            ]
          : [
              code,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              product,
              40000,
              4000,
            ],
      ),
    );
  }
  const truckRows: Cell[][] = [];
  for (const [plate, carrier, kind, size, compartments] of TRUCKS) {
    compartments.forEach((capacity, index) =>
      truckRows.push(
        index === 0
          ? [
              plate,
              carrier,
              kind,
              size,
              compartments.reduce((a, b) => a + b, 0),
              35,
              "disponible",
              650,
              null,
              1,
              capacity,
              "tous",
            ]
          : [plate, null, null, null, null, null, null, null, null, index + 1, capacity, "tous"],
      ),
    );
  }
  return {
    depots: buildXlsx([
      {
        name: "Dépôts",
        rows: [
          [
            "Code dépôt",
            "Nom",
            "Exploitant",
            "Latitude",
            "Longitude",
            "Adresse",
            "Horaires d'ouverture",
            "Attente moyenne (min)",
            "Chargements max par camion et par jour",
            "Actif",
          ],
          [
            DEPOT,
            "SCDP Douala",
            "SCDP",
            4.0435,
            9.7043,
            "Zone portuaire, Douala",
            "lun-dim 05:00-20:00",
            30,
            2,
            "oui",
          ],
        ],
      },
    ]),
    stations: buildXlsx([
      {
        name: "Stations",
        rows: [
          [
            "Code station",
            "Nom",
            "Région",
            "Ville",
            "Latitude",
            "Longitude",
            "Horaires de réception",
            "Gabarit max",
            "Temps de dépotage (min)",
            "Contact",
            "Téléphone",
            "E-mail",
            "Active",
            "Produit",
            "Capacité cuve (L)",
            "Stock de sécurité (L)",
          ],
          ...stationRows,
        ],
      },
    ]),
    trucks: buildXlsx([
      {
        name: "Camions",
        rows: [
          [
            "Immatriculation",
            "Transporteur",
            "Type de transporteur",
            "Gabarit",
            "Capacité totale (L)",
            "Vitesse moyenne (km/h)",
            "Statut",
            "Coût au km (FCFA)",
            "Notes",
            "Compartiment",
            "Capacité compartiment (L)",
            "Produits autorisés",
          ],
          ...truckRows,
        ],
      },
    ]),
    drivers: buildXlsx([
      {
        name: "Chauffeurs",
        rows: [
          [
            "Numéro de permis",
            "Nom complet",
            "Téléphone",
            "Expiration du permis",
            "Habilitation matières dangereuses",
            "Expiration de l'habilitation",
            "Transporteur",
            "Statut",
            "Camion habituel",
          ],
          ...DRIVERS.map(([license, name, carrier]): Cell[] => [
            license,
            name,
            null,
            "2031-12-31",
            "oui",
            "2031-12-31",
            carrier,
            "disponible",
            null,
          ]),
        ],
      },
    ]),
  };
}

/** Commandes de la journée : station, produit, volume, priorité, fenêtre, commentaire. */
const ORDERS: [string, string, number, string, string | null, string | null, string | null][] = [
  ["L14-AKWA", "SUPER", 10000, "normal", null, null, null],
  ["L14-MAKEP", "GASOIL", 10000, "normal", null, null, null],
  ["L14-BONAP", "SUPER", 7500, "normal", null, null, null],
  ["L14-BONAB", "GASOIL", 20000, "normal", null, null, null],
  ["L14-LOGBA", "SUPER", 10000, "normal", null, null, null],
  ["L14-DEIDO", "SUPER", 7500, "normal", null, null, null],
  ["L14-YASSA", "GASOIL", 7500, "normal", null, null, null],
  ["L14-BONAM", "SUPER", 7500, "normal", null, null, null],
  ["L14-NDOKO", "GASOIL", 15000, "urgent", "07:00", "12:00", "Rupture annoncée"],
  ["L14-KOTTO", "SUPER", 7500, "normal", null, null, null],
  ["L14-BASSA", "GASOIL", 5500, "normal", null, null, null],
  ["L14-BEPAN", "SUPER", 5500, "normal", null, null, null],
  ["L14-PK14", "GASOIL", 10000, "normal", null, null, null],
  ["L14-VILLA", "SUPER", 10000, "normal", null, null, null],
  ["L14-PK14", "PETROLE", 5000, "normal", null, null, "Non livrée ce jour-là"],
];

interface ManualTrip {
  truck: string;
  driver: string;
  km: number;
  depart: string;
  back: string;
  /** station, produit, volume livré, arrivée, départ */
  stops: [string, string, number, string, string][];
}

/** Tournées telles que le dispatcher les a faites : par habitude de chauffeur, sans regroupement par zone. */
const MANUAL_TRIPS: ManualTrip[] = [
  {
    truck: "LT 201 DA",
    driver: "Jean Mbarga",
    km: 41,
    depart: "06:30",
    back: "10:55",
    stops: [
      ["L14-AKWA", "SUPER", 10000, "06:45", "07:25"],
      ["L14-MAKEP", "GASOIL", 10000, "07:55", "08:35"],
      ["L14-BONAP", "SUPER", 7500, "09:25", "10:05"],
    ],
  },
  {
    truck: "LT 202 DA",
    driver: "Paul Etoa",
    km: 46,
    depart: "06:40",
    back: "10:20",
    stops: [
      ["L14-BONAB", "GASOIL", 20000, "07:10", "07:55"],
      ["L14-LOGBA", "SUPER", 10000, "08:50", "09:30"],
    ],
  },
  {
    truck: "LT 305 DB",
    driver: "Samuel Njoya",
    km: 52,
    depart: "06:45",
    back: "11:30",
    stops: [
      ["L14-DEIDO", "SUPER", 7500, "07:05", "07:45"],
      ["L14-YASSA", "GASOIL", 7500, "08:35", "09:15"],
      ["L14-BONAM", "SUPER", 7500, "10:05", "10:45"],
    ],
  },
  {
    truck: "LT 306 DB",
    driver: "Martin Fotso",
    km: 29,
    depart: "07:00",
    back: "10:05",
    stops: [
      ["L14-NDOKO", "GASOIL", 15000, "07:25", "08:10"],
      ["L14-KOTTO", "SUPER", 7500, "08:40", "09:20"],
    ],
  },
  {
    truck: "LT 410 DC",
    driver: "Alain Biyong",
    km: 22,
    depart: "07:10",
    back: "09:50",
    stops: [
      ["L14-BASSA", "GASOIL", 5500, "07:40", "08:15"],
      ["L14-BEPAN", "SUPER", 5500, "08:45", "09:20"],
    ],
  },
  {
    truck: "LT 201 DA",
    driver: "Jean Mbarga",
    km: 44,
    depart: "11:40",
    back: "15:10",
    stops: [
      ["L14-PK14", "GASOIL", 10000, "12:25", "13:05"],
      ["L14-VILLA", "SUPER", 10000, "13:45", "14:25"],
    ],
  },
];

const TRIP_HEADERS = [
  "Tournée",
  "Camion",
  "Chauffeur",
  "Dépôt",
  "Ordre",
  "Code station",
  "Produit",
  "Volume livré (L)",
  "Km réels",
  "Heure départ dépôt",
  "Heure retour dépôt",
  "Heure arrivée station",
  "Heure départ station",
];

/** Classeur « journée de référence » ; `broken` y glisse deux erreurs (rapport ligne par ligne). */
export function referenceDayWorkbook(day: string, options: { broken?: boolean } = {}): Buffer {
  const tripRows: Cell[][] = [];
  MANUAL_TRIPS.forEach((trip, t) =>
    trip.stops.forEach(([station, product, volume, arrival, departure], s) =>
      tripRows.push([
        t + 1,
        s === 0 ? trip.truck : null,
        s === 0 ? trip.driver : null,
        s === 0 ? DEPOT : null,
        s + 1,
        station,
        product,
        volume,
        s === 0 ? trip.km : null,
        s === 0 ? trip.depart : null,
        s === 0 ? trip.back : null,
        arrival,
        departure,
      ]),
    ),
  );
  if (options.broken) {
    tripRows[1][5] = "L14-INCONNUE";
    tripRows[3][1] = "LT 999 ZZ";
  }
  return buildXlsx([
    { name: "Journée", rows: [["Date", day]] },
    {
      name: "Commandes",
      rows: [
        [
          "Code station",
          "Produit",
          "Volume demandé (L)",
          "Priorité",
          "Fenêtre début",
          "Fenêtre fin",
          "Commentaire",
        ],
        ...ORDERS,
      ],
    },
    { name: "Tournées", rows: [TRIP_HEADERS, ...tripRows] },
  ]);
}

/* ------------------------------------------------------------------ appels à l'API */

const tokens = new Map<string, Promise<string>>();

/** Jeton d'accès d'un compte ; mémorisé, car la connexion est limitée en fréquence par l'API (429). */
export function login(account: { email: string; password: string }): Promise<string> {
  const cached = tokens.get(account.email);
  if (cached) return cached;
  const pending = (async () => {
    const response = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: account.email, password: account.password }),
    });
    if (!response.ok) {
      tokens.delete(account.email);
      throw new Error(`Connexion refusée pour ${account.email} (${response.status})`);
    }
    return ((await response.json()) as { access_token: string }).access_token;
  })();
  tokens.set(account.email, pending);
  return pending;
}

async function call<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) },
  });
  if (!response.ok)
    throw new Error(`${init.method ?? "GET"} ${path} → ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

function upload(file: Buffer, filename: string, fields: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(file)], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    filename,
  );
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

/**
 * Applique un lot d'import puis attend qu'il soit lisible comme « appliqué » : la réponse de
 * `POST /imports/{id}/apply` peut arriver avant que la transaction soit visible d'une autre requête.
 */
async function applyBatch(token: string, batchId: string): Promise<void> {
  await call(token, `/imports/${batchId}/apply`, { method: "POST" });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const batch = await call<{ status: string }>(token, `/imports/${batchId}`);
    if (batch.status === "applied") return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Lot ${batchId} : application non confirmée`);
}

/** Comptes `dispatcher` et `manager` du lot (créés une fois ; 409 = déjà là). */
export async function ensureUsers(admin: string): Promise<void> {
  for (const account of [DISPATCHER, MANAGER]) {
    const response = await fetch(`${API}/users`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
      body: JSON.stringify(account),
    });
    if (!response.ok && response.status !== 409) {
      throw new Error(`Création de ${account.email} → ${response.status} ${await response.text()}`);
    }
  }
}

/** Dépôt, stations, camions, chauffeurs : prévisualisation puis application (création ou mise à jour). */
export async function seedReferentials(admin: string): Promise<void> {
  const books = referentialWorkbooks();
  for (const kind of ["depots", "stations", "trucks", "drivers"] as const) {
    const batch = await call<{ id: string; error_count: number; report?: unknown }>(
      admin,
      `/imports/${kind}/preview`,
      { method: "POST", body: upload(books[kind], `l14_${kind}.xlsx`) },
    );
    if (batch.error_count > 0) {
      throw new Error(`Import ${kind} refusé : ${JSON.stringify(batch.report).slice(0, 800)}`);
    }
    await applyBatch(admin, batch.id);
  }
}

export interface PlanRow {
  id: string;
  day: string;
  kind: string;
  status: string;
  version: number;
}

export async function listPlans(token: string, day: string): Promise<PlanRow[]> {
  return (await call<{ items: PlanRow[] }>(token, `/plans?day=${day}&limit=200`)).items;
}

/** Importe la journée de référence (remplace celle qui existerait) et renvoie l'identifiant du plan A. */
export async function importReferenceDay(
  token: string,
  day: string,
  fields: { prep_time_min?: number; label?: string } = {},
): Promise<string> {
  const result = await call<{ plan_id: string }>(token, "/reference-days/import", {
    method: "POST",
    body: upload(referenceDayWorkbook(day), "journee_reference.xlsx", {
      day,
      replace: "true",
      prep_time_min: String(fields.prep_time_min ?? 105),
      label: fields.label ?? "Journée A — dispatch manuel",
    }),
  });
  return result.plan_id;
}

/** Rejoue le plan de référence avec le moteur (worker Celery requis) et renvoie l'identifiant du rejeu. */
export async function replay(token: string, planId: string, timeoutMs = 120_000): Promise<string> {
  const { task_id } = await call<{ task_id: string }>(token, `/plans/${planId}/replay`, { method: "POST" });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await call<{ state: string; plan_id: string | null; error: string | null }>(
      token,
      `/tasks/${task_id}`,
    );
    if (task.state === "succeeded" && task.plan_id) return task.plan_id;
    if (task.state === "failed") throw new Error(`Rejeu en échec : ${task.error}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Rejeu : délai dépassé (le worker Celery tourne-t-il ?)");
}

/** Mise en données complète : référentiels, comptes, journée A importée et rejouée. */
export async function seedComparison(day: string): Promise<{ planA: string; planB: string }> {
  const admin = await login(ADMIN);
  await ensureUsers(admin);
  await seedReferentials(admin);
  const dispatcher = await login(DISPATCHER);
  const planA = await importReferenceDay(dispatcher, day);
  const planB = await replay(dispatcher, planA);
  return { planA, planB };
}

/* ------------------------------------------------------------------ journée B (plan publié, en cours) */

interface PlanDetail {
  id: string;
  status: string;
  trips: {
    id: string;
    seq: number;
    status: string;
    truck_id: string;
    planned_depart_at: string;
    planned_return_at: string;
    stops: PlanStop[];
    loads: { compartment_id: string; product_id: string; planned_l: number }[];
  }[];
}
interface PlanStop {
  id: string;
  seq: number;
  planned_arrival_at: string;
  planned_departure_at: string;
  deliveries: { order_id: string; product_id: string; planned_l: number }[];
}

const shift = (iso: string, minutes: number) =>
  new Date(new Date(iso).getTime() + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Journée B : les mêmes commandes, planifiées par le moteur, plan publié et partiellement exécuté
 * (une tournée terminée, une en cours avec du retard) — pour le volet « Suivi de la journée B ».
 * Sans effet si un plan est déjà publié ce jour-là.
 */
export async function seedDayB(day: string): Promise<string> {
  const admin = await login(ADMIN);
  const existing = (await listPlans(admin, day)).find(
    (plan) => plan.kind === "computed" && plan.status === "published",
  );
  if (existing) {
    await progressDayB(admin, await call<PlanDetail>(admin, `/plans/${existing.id}`));
    return existing.id;
  }

  const batch = await call<{ id: string; error_count: number; report?: unknown }>(
    admin,
    "/imports/orders/preview",
    {
      method: "POST",
      body: upload(
        buildXlsx([
          {
            name: "Commandes",
            rows: [
              [
                "Date",
                "Code station",
                "Produit",
                "Volume (L)",
                "Priorité",
                "Fenêtre début",
                "Fenêtre fin",
                "Commentaire",
              ],
              ...ORDERS.map(([station, product, volume, priority, from, to]): Cell[] => [
                day,
                station,
                product,
                volume,
                priority === "urgent" ? "urgente" : "normale",
                from,
                to,
                null,
              ]),
            ],
          },
        ]),
        "l14_orders.xlsx",
        { day },
      ),
    },
  );
  if (batch.error_count > 0) {
    throw new Error(`Import des commandes refusé : ${JSON.stringify(batch.report).slice(0, 800)}`);
  }
  await applyBatch(admin, batch.id);
  const orders = await call<{ items: { id: string; status: string }[] }>(
    admin,
    `/orders?day=${day}&limit=200`,
  );
  const drafts = orders.items.filter((order) => order.status === "draft").map((order) => order.id);
  if (drafts.length > 0) {
    await call(admin, "/orders/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_ids: drafts }),
    });
  }
  const { task_id } = await call<{ task_id: string }>(admin, "/plans/compute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ day }),
  });
  let planId: string | null = null;
  for (let attempt = 0; attempt < 240 && !planId; attempt += 1) {
    const task = await call<{ state: string; plan_id: string | null; error: string | null }>(
      admin,
      `/tasks/${task_id}`,
    );
    if (task.state === "failed") throw new Error(`Calcul en échec : ${task.error}`);
    if (task.state === "succeeded") planId = task.plan_id;
    else await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!planId) throw new Error("Calcul : délai dépassé");
  const plan = await call<PlanDetail>(admin, `/plans/${planId}/publish`, { method: "POST" });

  await progressDayB(admin, plan);
  return plan.id;
}

const jsonBody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** Tournée 1 : terminée à l'heure. Tournée 2 : partie 25 min en retard, premier arrêt livré. Rejouable. */
async function progressDayB(admin: string, plan: PlanDetail): Promise<void> {
  const trips = [...plan.trips].sort((x, y) => x.seq - y.seq).slice(0, 2);
  for (const [index, trip] of trips.entries()) {
    if (trip.status !== "planned") continue;
    const late = index === 0 ? 0 : 25;
    await call(admin, `/trips/${trip.id}/status`, jsonBody("PUT", { status: "at_depot" }));
    await call(
      admin,
      `/trips/${trip.id}/loading`,
      jsonBody("POST", {
        lines: trip.loads.map((load) => ({
          compartment_id: load.compartment_id,
          product_id: load.product_id,
          observed_l: load.planned_l,
          observed_temp_c: 28,
        })),
      }),
    );
    const current = await call<PlanDetail>(admin, `/plans/${plan.id}`);
    if (current.trips.find((row) => row.id === trip.id)?.status !== "loaded") {
      await call(admin, `/trips/${trip.id}/status`, jsonBody("PUT", { status: "loaded" }));
    }
    await call(
      admin,
      `/trips/${trip.id}/status`,
      jsonBody("PUT", { status: "in_progress", actual_depart_at: shift(trip.planned_depart_at, late) }),
    );
    const stops = [...trip.stops].sort((x, y) => x.seq - y.seq);
    for (const stop of index === 0 ? stops : stops.slice(0, 1)) {
      await call(
        admin,
        `/stops/${stop.id}/delivery`,
        jsonBody("PUT", {
          actual_arrival_at: shift(stop.planned_arrival_at, late),
          actual_departure_at: shift(stop.planned_departure_at, late),
          deliveries: stop.deliveries.map((line) => ({
            order_id: line.order_id,
            product_id: line.product_id,
            actual_l: line.planned_l,
          })),
        }),
      );
    }
    if (index === 0) {
      const after = await call<PlanDetail>(admin, `/plans/${plan.id}`);
      if (after.trips.find((row) => row.id === trip.id)?.status !== "completed") {
        await call(
          admin,
          `/trips/${trip.id}/status`,
          jsonBody("PUT", { status: "completed", actual_return_at: trip.planned_return_at }),
        );
      }
    }
  }
}

/**
 * Panne de camion sur la dernière tournée encore « planifiée » du plan publié du jour
 * (`POST /events/truck-breakdown`) : le serveur crée et publie une nouvelle version du plan.
 * Renvoie la version publiée après la panne.
 */
export async function declareBreakdown(day: string): Promise<{ planId: string; version: number }> {
  const admin = await login(ADMIN);
  const published = (await listPlans(admin, day))
    .filter((plan) => plan.kind === "computed" && plan.status === "published")
    .sort((x, y) => y.version - x.version)[0];
  if (!published) throw new Error(`Aucun plan publié le ${day}`);
  // Déjà fait lors d'un passage précédent : on ne recrée pas une panne à chaque exécution.
  if (published.version >= 2) return { planId: published.id, version: published.version };
  const plan = await call<PlanDetail>(admin, `/plans/${published.id}`);
  // Une tournée encore planifiée dont le camion n'en fait pas d'autre : sinon le camion en panne laisse une
  // violation bloquante (RM-04) sur son autre tournée et la nouvelle version reste en brouillon.
  const target = [...plan.trips]
    .sort((x, y) => y.seq - x.seq)
    .find(
      (trip) =>
        trip.status === "planned" &&
        plan.trips.filter((other) => other.truck_id === trip.truck_id).length === 1,
    );
  if (!target) throw new Error("Aucune tournée planifiée dont le camion ne fait qu'une tournée");
  // Le serveur dit quels camions peuvent reprendre la tournée (capacité, gabarit, disponibilité) ;
  // on essaie les camions admissibles l'un après l'autre : l'heure de la panne peut encore en écarter.
  const occurredAt = shift(target.planned_depart_at, -20);
  const options = await call<{
    trucks: { truck_id: string; eligible: boolean; suggested_driver_id: string | null }[];
  }>(admin, `/events/replacement-options?trip_id=${target.id}`);
  const eligible = options.trucks.filter((truck) => truck.eligible);
  if (eligible.length === 0) throw new Error("Aucun camion de remplacement admissible");
  let lastError: unknown = null;
  for (const replacement of eligible) {
    try {
      const result = await call<{ plan_id: string; plan_version: number; published: boolean }>(
        admin,
        "/events/truck-breakdown",
        jsonBody("POST", {
          trip_id: target.id,
          replacement_truck_id: replacement.truck_id,
          replacement_driver_id: replacement.suggested_driver_id,
          occurred_at: occurredAt,
          reason: "Fuite sur le circuit de freinage constatée au dépôt",
          publish: true,
        }),
      );
      if (!result.published) throw new Error("La version créée par la panne n'a pas pu être publiée");
      return { planId: result.plan_id, version: result.plan_version };
    } catch (error) {
      lastError = error;
      // Une version en brouillon existe désormais : inutile d'essayer un autre camion.
      if (error instanceof Error && error.message.includes("n'a pas pu être publiée")) break;
    }
  }
  throw lastError;
}

if (process.argv[1]?.endsWith("l14-seed.ts")) {
  const day = process.argv[2] ?? "2027-01-12";
  (process.argv[3] === "b"
    ? seedDayB(day).then((plan) => ({ planB: plan }))
    : process.argv[3] === "panne"
      ? declareBreakdown(day)
      : seedComparison(day)
  ).then(
    (plans) => console.log(JSON.stringify({ day, ...plans })),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
