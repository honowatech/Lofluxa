/**
 * Base en mémoire des doublures MSW : jeu de données fictif autour de Douala.
 * Formes identiques aux modèles du back-end (snake_case, `lat` / `lon`, UUID, horodatages UTC).
 * `resetDb()` remet le jeu initial (appelé entre les tests).
 */
import { addDays, todayLocal } from "@/lib/format";
import type {
  AuditEntry,
  Carrier,
  Depot,
  Driver,
  ImportBatch,
  OpeningHours,
  Product,
  Role,
  SettingValue,
  Station,
  Truck,
  User,
} from "@/lib/types";

let counter = 0;
/** UUID déterministe et lisible : `00000000-0000-4000-8000-00000000002a`. */
export function nextId(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
}

const NOW = () => new Date().toISOString();
const WEEK: OpeningHours = {
  mon: [["06:00", "18:00"]],
  tue: [["06:00", "18:00"]],
  wed: [["06:00", "18:00"]],
  thu: [["06:00", "18:00"]],
  fri: [["06:00", "18:00"]],
  sat: [["06:00", "13:00"]],
  sun: [],
};
const SPLIT: OpeningHours = {
  ...WEEK,
  mon: [
    ["06:00", "12:00"],
    ["14:00", "18:00"],
  ],
};

/** Clés et défauts : miroir de backend/app/core/settings_store.py → DEFAULTS. */
export const SETTINGS_DEFAULTS: Record<string, [SettingValue, string]> = {
  default_avg_speed_kmh: [40.0, "Vitesse moyenne par défaut des camions (km/h)"],
  max_service_hours: [11.0, "Durée maximale de service d'un chauffeur par jour (heures) — RM-11"],
  default_depot_wait_min: [90, "Temps d'attente moyen au dépôt avant chargement (minutes)"],
  depot_loading_time_min: [45, "Durée d'un chargement au dépôt (minutes)"],
  default_unload_time_min: [45, "Temps de dépotage par défaut en station (minutes)"],
  default_max_loadings_per_truck_day: [2, "Nombre max de chargements par camion et par jour — RM-14"],
  compartment_safety_margin_pct: [2.0, "Marge de sécurité sur la capacité des compartiments (%) — RM-05"],
  loading_tolerance_pct: [2.0, "Tolérance d'écart volume chargé / planifié (%) — RM-13"],
  window_tolerance_min: [30, "Dépassement de fenêtre toléré en avertissement (minutes) — RM-10"],
  partial_delivery_min_pct: [50.0, "Part minimale livrable d'une commande (%) — RM-16"],
  day_start_time: ["06:00", "Heure de début de journée (heure locale)"],
  timezone: ["Africa/Douala", "Fuseau horaire d'affichage"],
  objective_distance_weight: [1.0, "Objectif : poids de la distance totale"],
  objective_vehicle_fixed_cost_km: [40.0, "Objectif : coût fixe par véhicule utilisé (km équivalents)"],
  objective_unserved_penalty_normal_km: [500.0, "Objectif : pénalité commande normale non servie (km)"],
  objective_unserved_penalty_urgent_km: [5000.0, "Objectif : pénalité commande urgente non servie (km)"],
  solver_time_limit_s: [45, "Limite de temps du solveur (secondes)"],
  solver_no_improvement_s: [10, "Arrêt anticipé du solveur sans amélioration (secondes)"],
  solver_seed: [42, "Graine du solveur (reproductibilité)"],
  haversine_factor: [1.3, "Coefficient appliqué à la distance à vol d'oiseau si OSRM est indisponible"],
  ab_success_threshold_pct: [10.0, "Seuil de réussite du test A/B : gain kilométrique minimal (%)"],
  company_name: ["OLA Energy Cameroun", "Nom affiché en en-tête des documents PDF"],
  pdf_logo_url: [null, "Logo des documents PDF (URL ou chemin de fichier ; vide = nom en texte)"],
};

export interface MockUser extends User {
  password: string;
}

export interface Db {
  products: (Product & { deleted_at?: string | null })[];
  depots: (Depot & { deleted_at?: string | null })[];
  stations: (Station & { deleted_at?: string | null })[];
  carriers: (Carrier & { deleted_at?: string | null })[];
  trucks: (Truck & { deleted_at?: string | null })[];
  drivers: (Driver & { deleted_at?: string | null })[];
  users: MockUser[];
  settings: Record<string, { value: SettingValue; updated_at: string | null; updated_by: string | null }>;
  audit: AuditEntry[];
  imports: (ImportBatch & { applied_rows?: Record<string, unknown>[] })[];
}

const STATION_SEED: [string, string, string, string, number, number][] = [
  ["DLA-001", "OLA Akwa Boulevard", "Littoral", "Douala", 4.0502, 9.6958],
  ["DLA-002", "OLA Bonanjo", "Littoral", "Douala", 4.0429, 9.6869],
  ["DLA-003", "OLA Bonapriso", "Littoral", "Douala", 4.0261, 9.6996],
  ["DLA-004", "OLA Deido", "Littoral", "Douala", 4.0647, 9.7068],
  ["DLA-005", "OLA Bali", "Littoral", "Douala", 4.0379, 9.6975],
  ["DLA-006", "OLA New Bell", "Littoral", "Douala", 4.0328, 9.7153],
  ["DLA-007", "OLA Bonabéri Rond-Point", "Littoral", "Douala", 4.0739, 9.6641],
  ["DLA-008", "OLA Ndokoti", "Littoral", "Douala", 4.0447, 9.7412],
  ["DLA-009", "OLA Bépanda", "Littoral", "Douala", 4.0683, 9.7256],
  ["DLA-010", "OLA Makepe", "Littoral", "Douala", 4.0794, 9.7531],
  ["DLA-011", "OLA Bonamoussadi", "Littoral", "Douala", 4.0892, 9.7376],
  ["DLA-012", "OLA Kotto", "Littoral", "Douala", 4.0957, 9.7498],
  ["DLA-013", "OLA Logpom", "Littoral", "Douala", 4.0921, 9.7672],
  ["DLA-014", "OLA Logbessou", "Littoral", "Douala", 4.1004, 9.7849],
  ["DLA-015", "OLA PK8", "Littoral", "Douala", 4.0578, 9.7694],
  ["DLA-016", "OLA PK14", "Littoral", "Douala", 4.0612, 9.8187],
  ["DLA-017", "OLA Yassa", "Littoral", "Douala", 4.0019, 9.8046],
  ["DLA-018", "OLA Village", "Littoral", "Douala", 4.0185, 9.7631],
  ["DLA-019", "OLA Nyalla", "Littoral", "Douala", 4.0297, 9.7903],
  ["DLA-020", "OLA Japoma", "Littoral", "Douala", 3.9921, 9.8312],
  ["DLA-021", "OLA Bassa Zone Industrielle", "Littoral", "Douala", 4.0356, 9.7528],
  ["DLA-022", "OLA Ndogbong", "Littoral", "Douala", 4.0531, 9.7549],
  ["DLA-023", "OLA Cité SIC", "Littoral", "Douala", 4.0625, 9.7391],
  ["DLA-024", "OLA Bonabéri Sodiko", "Littoral", "Douala", 4.0858, 9.6412],
  ["LIT-101", "OLA Edéa Centre", "Littoral", "Edéa", 3.7986, 10.1332],
  ["LIT-102", "OLA Mbanga", "Littoral", "Mbanga", 4.5016, 9.5679],
  ["LIT-103", "OLA Nkongsamba", "Littoral", "Nkongsamba", 4.9547, 9.9404],
  ["SUD-201", "OLA Tiko", "Sud-Ouest", "Tiko", 4.0751, 9.3601],
  ["SUD-202", "OLA Limbé Mile 4", "Sud-Ouest", "Limbé", 4.0424, 9.2157],
  ["SUD-203", "OLA Buea Molyko", "Sud-Ouest", "Buea", 4.1527, 9.2893],
];

const DRIVER_NAMES = [
  "Jean-Paul Mbarga",
  "Samuel Eto Nkoulou",
  "Aboubakar Hamadou",
  "Pierre Ngando",
  "Emmanuel Tchoua",
  "Joseph Fotso",
  "Ibrahim Njoya",
  "Martin Essomba",
  "Alain Kamga",
  "Bertrand Ewane",
  "Christian Biyong",
  "Daniel Mouelle",
  "Fabrice Tagne",
  "Georges Ondoa",
];

function seed(): Db {
  counter = 0;
  const today = todayLocal();
  const created = "2026-11-02T08:00:00Z";
  const stamp = { created_at: created, updated_at: created };

  const products: Db["products"] = [
    {
      id: nextId(),
      code: "SUPER",
      label: "Super sans plomb",
      ref_density_15: 0.745,
      thermal_coeff: 0.00123,
      color: "#1d6fb8",
      ...stamp,
    },
    {
      id: nextId(),
      code: "GASOIL",
      label: "Gasoil",
      ref_density_15: 0.845,
      thermal_coeff: 0.00084,
      color: "#8a6a12",
      ...stamp,
    },
    {
      id: nextId(),
      code: "PETROLE",
      label: "Pétrole lampant",
      ref_density_15: 0.8,
      thermal_coeff: 0.0009,
      color: "#7a4fc4",
      ...stamp,
    },
  ];
  const [superP, gasoil, petrole] = products;

  const depots: Db["depots"] = [
    {
      id: nextId(),
      code: "SCDP-DLA",
      name: "SCDP Douala Bessengué",
      operator: "scdp",
      lat: 4.0551,
      lon: 9.7083,
      address: "Zone portuaire, Douala",
      opening_hours: WEEK,
      avg_wait_min: null,
      max_loadings_per_truck_day: null,
      active: true,
      ...stamp,
    },
    {
      id: nextId(),
      code: "DEP-BON",
      name: "Dépôt interne Bonabéri",
      operator: "internal",
      lat: 4.0786,
      lon: 9.6532,
      address: "Bonabéri, Douala IV",
      opening_hours: SPLIT,
      avg_wait_min: 40,
      max_loadings_per_truck_day: 3,
      active: true,
      ...stamp,
    },
    {
      id: nextId(),
      code: "TIERS-LIM",
      name: "Dépôt tiers Limbé",
      operator: "third_party",
      lat: 4.0121,
      lon: 9.1987,
      address: null,
      opening_hours: {},
      avg_wait_min: 120,
      max_loadings_per_truck_day: 1,
      active: false,
      ...stamp,
    },
  ];

  const stations: Db["stations"] = STATION_SEED.map(([code, name, region, city, lat, lon], index) => {
    const id = nextId();
    const sizes = ["large", "large", "medium", "large", "small"] as const;
    const tanks = [superP, gasoil, ...(index % 4 === 0 ? [petrole] : [])].map((product, t) => ({
      id: nextId(),
      station_id: id,
      product_id: product.id,
      product_code: product.code,
      capacity_l: [30000, 40000, 15000][t] + (index % 3) * 5000,
      safety_stock_l: [3000, 4000, 1500][t],
    }));
    return {
      id,
      code,
      name,
      region,
      city,
      lat,
      lon,
      opening_hours: index % 5 === 0 ? {} : index % 3 === 0 ? SPLIT : WEEK,
      max_truck_size: sizes[index % sizes.length],
      unload_time_min: index % 4 === 0 ? 30 + (index % 3) * 15 : null,
      contact_name: index % 2 === 0 ? `Gérant ${name.replace("OLA ", "")}` : null,
      contact_phone:
        index % 2 === 0
          ? `+237 6 99 ${String(10 + index).padStart(2, "0")} 45 ${String(20 + index).padStart(2, "0")}`
          : null,
      contact_email: null,
      active: index !== 22,
      tanks,
      ...stamp,
    };
  });

  const carriers: Db["carriers"] = [
    { id: nextId(), name: "OLA Flotte propre", type: "own", contact: "Service Fleet — poste 214", ...stamp },
    {
      id: nextId(),
      name: "Transports Wouri SARL",
      type: "third_party",
      contact: "M. Ndjock — +237 6 77 10 20 30",
      ...stamp,
    },
    { id: nextId(), name: "Sanaga Logistique", type: "third_party", contact: null, ...stamp },
  ];

  const truckSpecs: [string, number, "small" | "medium" | "large", number[], Truck["status"]][] = [
    ["LT 482 AB", 0, "large", [9000, 9000, 9000, 6000], "available"],
    ["LT 519 CD", 0, "large", [10000, 10000, 8000, 5000], "available"],
    ["LT 733 EF", 0, "large", [9000, 9000, 9000, 6000], "maintenance"],
    ["LT 120 GH", 0, "medium", [7000, 7000, 6000], "available"],
    ["LT 266 JK", 0, "medium", [8000, 6000, 6000], "available"],
    ["LT 904 LM", 1, "large", [12000, 9000, 9000, 6000], "available"],
    ["LT 357 NP", 1, "medium", [7000, 7000, 6000], "broken"],
    ["LT 641 QR", 1, "small", [5000, 4000], "available"],
    ["LT 088 ST", 1, "small", [4500, 4500], "available"],
    ["CE 215 UV", 2, "large", [10000, 10000, 8000, 5000], "reserved"],
    ["CE 772 WX", 2, "medium", [7000, 7000, 6000], "available"],
    ["CE 430 YZ", 2, "small", [5000, 4000], "available"],
  ];
  const trucks: Db["trucks"] = truckSpecs.map(([plate, carrierIndex, size, compartments, status], index) => {
    const id = nextId();
    return {
      id,
      plate,
      carrier_id: carriers[carrierIndex].id,
      carrier_name: carriers[carrierIndex].name,
      size,
      total_capacity_l: compartments.reduce((sum, c) => sum + c, 0),
      avg_speed_kmh: index % 3 === 0 ? 38 : null,
      status,
      cost_per_km: index % 2 === 0 ? 650 + index * 10 : null,
      notes: status === "broken" ? "Boîte de vitesses — retour atelier prévu" : null,
      compartments: compartments.map((capacity_l, position) => ({
        id: nextId(),
        truck_id: id,
        position: position + 1,
        capacity_l,
        allowed_product_ids:
          position === compartments.length - 1 && index % 4 === 0 ? [gasoil.id, petrole.id] : null,
      })),
      ...stamp,
    };
  });

  const statuses: Driver["status"][] = [
    "available",
    "available",
    "available",
    "rest",
    "available",
    "leave",
    "available",
    "sick",
  ];
  const drivers: Db["drivers"] = DRIVER_NAMES.map((full_name, index) => {
    const carrier = carriers[index % carriers.length];
    const truck = trucks.find((t, i) => t.carrier_id === carrier.id && i % 3 === index % 3);
    // Quelques documents expirés ou proches de l'expiration, relatifs au jour courant.
    const licenseOffset = index === 2 ? -12 : index === 5 ? 9 : 200 + index * 37;
    const hazmatOffset = index === 7 ? -3 : index === 9 ? 21 : 150 + index * 29;
    return {
      id: nextId(),
      full_name,
      phone: `+237 6 7${index} ${String(11 + index * 3).padStart(2, "0")} ${String(40 + index).padStart(2, "0")} 0${index % 10}`,
      license_no: `CE-${String(100234 + index * 713)}`,
      license_expiry: addDays(today, licenseOffset),
      hazmat_cert: index !== 11,
      hazmat_expiry: index === 11 ? null : index === 4 ? null : addDays(today, hazmatOffset),
      carrier_id: carrier.id,
      carrier_name: carrier.name,
      status: statuses[index % statuses.length],
      default_truck_id: truck?.id ?? null,
      default_truck_plate: truck?.plate ?? null,
      ...stamp,
    };
  });

  const userSpecs: [string, string, Role, boolean, string][] = [
    ["admin@honowa.tech", "Administrateur Honowa", "admin", true, "admin-dev-only"],
    ["dispatch@ola.example", "Brice Ekambi", "dispatcher", true, "demo-dev-only"],
    ["fleet@ola.example", "Rosine Ngo Bassa", "fleet", true, "demo-dev-only"],
    ["supply@ola.example", "Hervé Mbah", "supply", true, "demo-dev-only"],
    ["direction@ola.example", "Mme Medjo", "manager", true, "demo-dev-only"],
    ["ancien.dispatch@ola.example", "Thierry Owona", "dispatcher", false, "demo-dev-only"],
  ];
  const users: MockUser[] = userSpecs.map(([email, full_name, role, active, password], index) => ({
    id: nextId(),
    email,
    full_name,
    role,
    active,
    password,
    last_login_at: index === 5 ? null : new Date(Date.now() - (index + 1) * 5.3 * 3600_000).toISOString(),
    created_at: created,
  }));

  const settings: Db["settings"] = Object.fromEntries(
    Object.entries(SETTINGS_DEFAULTS).map(([key, [value]]) => [
      key,
      { value, updated_at: null, updated_by: null },
    ]),
  );
  settings.window_tolerance_min = { value: 20, updated_at: "2026-11-18T09:12:00Z", updated_by: users[0].id };

  const actor = (index: number) => users[index % 2 === 0 ? 1 : 0];
  const audit: AuditEntry[] = [];
  const pushAudit = (
    hoursAgo: number,
    table_name: string,
    row_id: string,
    action: AuditEntry["action"],
    before: AuditEntry["before"],
    after: AuditEntry["after"],
    who: MockUser | null,
  ) =>
    audit.push({
      id: nextId(),
      table_name,
      row_id,
      action,
      before,
      after,
      actor_id: who?.id ?? null,
      actor_name: who?.full_name ?? null,
      at: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
    });
  pushAudit(2, "settings", "window_tolerance_min", "update", { value: 30 }, { value: 20 }, users[0]);
  pushAudit(
    5,
    "plans",
    nextId(),
    "update",
    { status: "draft", version: 3 },
    { status: "published", version: 3, published_at: NOW() },
    users[1],
  );
  pushAudit(
    6,
    "trips",
    nextId(),
    "update",
    { driver_id: drivers[0].id, locked: false },
    { driver_id: drivers[3].id, locked: true },
    users[1],
  );
  pushAudit(
    7,
    "stocks",
    nextId(),
    "insert",
    null,
    { depot_id: depots[0].id, product_id: gasoil.id, day: today, available_l: 420000 },
    users[3],
  );
  pushAudit(8, "stocks", nextId(), "update", { available_l: 180000 }, { available_l: 150000 }, users[3]);
  pushAudit(
    26,
    "loadings",
    nextId(),
    "insert",
    null,
    { trip_id: nextId(), temperature_c: 29.5, density: 0.8412, loaded_l: 33000, volume_15_l: 32598 },
    users[2],
  );
  pushAudit(
    30,
    "plans",
    nextId(),
    "insert",
    null,
    { day: addDays(today, -1), kind: "computed", status: "draft", version: 1 },
    null,
  );
  pushAudit(31, "trips", nextId(), "delete", { truck_id: trucks[6].id, status: "planned" }, null, users[1]);
  for (let i = 0; i < 40; i += 1) {
    pushAudit(
      34 + i * 3,
      i % 3 === 0 ? "trips" : i % 3 === 1 ? "stocks" : "plans",
      nextId(),
      "update",
      { version: i + 1, total_km: 412.5 + i },
      { version: i + 2, total_km: 398.1 + i },
      actor(i),
    );
  }

  return { products, depots, stations, carriers, trucks, drivers, users, settings, audit, imports: [] };
}

export let db: Db = seed();

export function resetDb(): void {
  db = seed();
}
