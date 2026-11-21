/** Doublures des référentiels (lot L3) : CRUD /products /depots /stations(+tanks) /carriers /trucks(+compartments) /drivers. */
import { http, HttpResponse, type HttpHandler } from "msw";

import { db, nextId } from "../db";
import {
  alive,
  API,
  authenticate,
  authorize,
  errorResponse,
  notFound,
  paginate,
  readJson,
  validation,
  wait,
} from "./helpers";

type Collection = "products" | "depots" | "stations" | "carriers" | "trucks" | "drivers";
type Row = Record<string, unknown> & { id: string; deleted_at?: string | null };

interface CrudConfig {
  name: Collection;
  label: string;
  /** Champ unique et obligatoire (code, immatriculation, nom). */
  key: string;
  search: string[];
  defaults: Record<string, unknown>;
  required?: string[];
  decorate?: (row: Row) => Row;
  /** Renvoie un message si la suppression est refusée (référence existante). */
  blockDelete?: (row: Row) => string | null;
}

const rowsOf = (name: Collection) => db[name] as unknown as Row[];
const now = () => new Date().toISOString();

const carrierName = (id: unknown) => alive(db.carriers).find((c) => c.id === id)?.name ?? null;
const truckPlate = (id: unknown) => alive(db.trucks).find((t) => t.id === id)?.plate ?? null;
const productCode = (id: unknown) => db.products.find((p) => p.id === id)?.code;

const CONFIGS: CrudConfig[] = [
  {
    name: "products",
    label: "Produit",
    key: "code",
    search: ["code", "label"],
    required: ["label"],
    defaults: { color: "#888888" },
    blockDelete: (row) =>
      db.stations.some((s) => !s.deleted_at && s.tanks.some((t) => t.product_id === row.id))
        ? "Ce produit est utilisé par des cuves de stations : suppression impossible."
        : null,
  },
  {
    name: "depots",
    label: "Dépôt",
    key: "code",
    search: ["code", "name", "address"],
    required: ["name", "lat", "lon"],
    defaults: {
      operator: "scdp",
      address: null,
      opening_hours: {},
      avg_wait_min: null,
      max_loadings_per_truck_day: null,
      active: true,
    },
  },
  {
    name: "stations",
    label: "Station",
    key: "code",
    search: ["code", "name", "city", "region"],
    required: ["name", "lat", "lon"],
    defaults: {
      region: null,
      city: null,
      opening_hours: {},
      max_truck_size: "large",
      unload_time_min: null,
      contact_name: null,
      contact_phone: null,
      contact_email: null,
      active: true,
      tanks: [],
    },
    decorate: (row) => ({
      ...row,
      tanks: ((row.tanks as Row[]) ?? []).map((tank) => ({
        ...tank,
        product_code: productCode(tank.product_id),
      })),
    }),
  },
  {
    name: "carriers",
    label: "Transporteur",
    key: "name",
    search: ["name", "contact"],
    defaults: { type: "third_party", contact: null },
    blockDelete: (row) =>
      alive(db.trucks).some((t) => t.carrier_id === row.id) ||
      alive(db.drivers).some((d) => d.carrier_id === row.id)
        ? "Ce transporteur est rattaché à des camions ou à des chauffeurs : suppression impossible."
        : null,
  },
  {
    name: "trucks",
    label: "Camion",
    key: "plate",
    search: ["plate", "notes", "carrier_name"],
    required: ["size", "total_capacity_l"],
    defaults: {
      carrier_id: null,
      avg_speed_kmh: null,
      status: "available",
      cost_per_km: null,
      notes: null,
      compartments: [],
    },
    decorate: (row) => ({ ...row, carrier_name: carrierName(row.carrier_id) }),
  },
  {
    name: "drivers",
    label: "Chauffeur",
    key: "full_name",
    search: ["full_name", "phone", "license_no", "carrier_name"],
    defaults: {
      phone: null,
      license_no: null,
      license_expiry: null,
      hazmat_cert: false,
      hazmat_expiry: null,
      carrier_id: null,
      status: "available",
      default_truck_id: null,
    },
    decorate: (row) => ({
      ...row,
      carrier_name: carrierName(row.carrier_id),
      default_truck_plate: truckPlate(row.default_truck_id),
    }),
  },
];

const strip = ({ deleted_at: _deleted, ...row }: Row) => row;

function checkBody(config: CrudConfig, body: Record<string, unknown>, current?: Row) {
  const merged = { ...current, ...body };
  const missing = [config.key, ...(config.required ?? [])].filter(
    (field) => merged[field] === undefined || merged[field] === null || merged[field] === "",
  );
  if (missing.length)
    return validation(
      missing.map((field) => ({ field: `body.${field}`, message: "Champ obligatoire", type: "missing" })),
    );
  // Chauffeurs : l'unicité porte sur le numéro de permis, pas sur le nom.
  const uniqueField = config.name === "drivers" ? "license_no" : config.key;
  const value = merged[uniqueField];
  if (
    value &&
    alive(rowsOf(config.name)).some(
      (row) =>
        row.id !== current?.id && String(row[uniqueField]).toLowerCase() === String(value).toLowerCase(),
    )
  ) {
    return errorResponse(409, "conflict", `${config.label} : « ${String(value)} » existe déjà.`, [
      { field: `body.${uniqueField}`, message: "Valeur déjà utilisée" },
    ]);
  }
  return null;
}

function crud(config: CrudConfig): HttpHandler[] {
  const base = `${API}/${config.name}`;
  const decorate = (row: Row) => strip(config.decorate ? config.decorate(row) : row);
  const find = (id: unknown) => alive(rowsOf(config.name)).find((row) => row.id === id);

  const update = async ({ request, params }: { request: Request; params: Record<string, unknown> }) => {
    await wait();
    const user = authorize(request);
    if (user instanceof Response) return user;
    const row = find(params.id);
    if (!row) return notFound(config.label);
    const body = await readJson(request);
    const invalid = checkBody(config, body, row);
    if (invalid) return invalid;
    const { id: _id, tanks: _tanks, compartments: _compartments, ...patch } = body;
    Object.assign(row, patch, { updated_at: now() });
    return HttpResponse.json(decorate(row));
  };

  return [
    http.get(base, async ({ request }) => {
      await wait();
      const user = authenticate(request);
      if (user instanceof Response) return user;
      const rows = alive(rowsOf(config.name)).map(decorate);
      return HttpResponse.json(paginate(request, rows, { search: config.search }));
    }),
    http.get(`${base}/:id`, ({ request, params }) => {
      const user = authenticate(request);
      if (user instanceof Response) return user;
      const row = find(params.id);
      return row ? HttpResponse.json(decorate(row)) : notFound(config.label);
    }),
    http.post(base, async ({ request }) => {
      await wait();
      const user = authorize(request);
      if (user instanceof Response) return user;
      const body = await readJson(request);
      const invalid = checkBody(config, body);
      if (invalid) return invalid;
      const row: Row = {
        ...structuredClone(config.defaults),
        ...body,
        id: nextId(),
        created_at: now(),
        updated_at: now(),
      };
      rowsOf(config.name).push(row);
      return HttpResponse.json(decorate(row), { status: 201 });
    }),
    http.put(`${base}/:id`, update),
    http.patch(`${base}/:id`, update),
    http.delete(`${base}/:id`, async ({ request, params }) => {
      await wait();
      const user = authorize(request);
      if (user instanceof Response) return user;
      const row = find(params.id);
      if (!row) return notFound(config.label);
      const blocked = config.blockDelete?.(row);
      if (blocked) return errorResponse(409, "conflict", blocked);
      row.deleted_at = now();
      return new HttpResponse(null, { status: 204 });
    }),
  ];
}

/** Sous-ressources : cuves d'une station, compartiments d'un camion. */
function children(
  parent: "stations" | "trucks",
  field: "tanks" | "compartments",
  label: string,
  uniqueField: string,
): HttpHandler[] {
  const base = `${API}/${parent}/:parentId/${field}`;
  const parentKey = parent === "stations" ? "station_id" : "truck_id";
  const list = (parentId: unknown): Row[] | null => {
    const owner = alive(db[parent] as unknown as Row[]).find((row) => row.id === parentId);
    return owner ? (owner[field] as Row[]) : null;
  };
  const conflict = (rows: Row[], body: Record<string, unknown>, selfId?: unknown) =>
    rows.some((row) => row.id !== selfId && row[uniqueField] === body[uniqueField])
      ? errorResponse(409, "conflict", `${label} : doublon sur ${uniqueField}.`, [
          { field: `body.${uniqueField}`, message: "Valeur déjà utilisée" },
        ])
      : null;
  const decorate = (row: Row) =>
    field === "tanks" ? { ...row, product_code: productCode(row.product_id) } : row;

  const update = async ({ request, params }: { request: Request; params: Record<string, unknown> }) => {
    const user = authorize(request);
    if (user instanceof Response) return user;
    const rows = list(params.parentId);
    const row = rows?.find((r) => r.id === params.id);
    if (!rows || !row) return notFound(label);
    const body = await readJson(request);
    const invalid = conflict(rows, { ...row, ...body }, row.id);
    if (invalid) return invalid;
    Object.assign(row, body, { id: row.id, [parentKey]: params.parentId });
    return HttpResponse.json(decorate(row));
  };

  return [
    http.get(base, ({ request, params }) => {
      const user = authenticate(request);
      if (user instanceof Response) return user;
      const rows = list(params.parentId);
      return rows ? HttpResponse.json(paginate(request, rows.map(decorate))) : notFound();
    }),
    http.post(base, async ({ request, params }) => {
      const user = authorize(request);
      if (user instanceof Response) return user;
      const rows = list(params.parentId);
      if (!rows) return notFound();
      const body = await readJson(request);
      const invalid = conflict(rows, body);
      if (invalid) return invalid;
      const row: Row = { ...body, id: nextId(), [parentKey]: params.parentId as string };
      rows.push(row);
      if (field === "compartments") rows.sort((a, b) => Number(a.position) - Number(b.position));
      return HttpResponse.json(decorate(row), { status: 201 });
    }),
    http.put(`${base}/:id`, update),
    http.patch(`${base}/:id`, update),
    http.delete(`${base}/:id`, ({ request, params }) => {
      const user = authorize(request);
      if (user instanceof Response) return user;
      const rows = list(params.parentId);
      const index = rows?.findIndex((r) => r.id === params.id) ?? -1;
      if (!rows || index < 0) return notFound(label);
      rows.splice(index, 1);
      return new HttpResponse(null, { status: 204 });
    }),
  ];
}

export const referentialHandlers: HttpHandler[] = [
  ...children("stations", "tanks", "Cuve", "product_id"),
  ...children("trucks", "compartments", "Compartiment", "position"),
  ...CONFIGS.flatMap(crud),
];
