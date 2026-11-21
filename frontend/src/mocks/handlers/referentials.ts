/**
 * Doublures des référentiels, alignées sur le lot L3 (`backend/app/referentials/router.py`) :
 * ordre fixe (pas de tri), `PUT` = `PATCH` = mise à jour partielle, cuves et compartiments acceptés en
 * ligne avec leur parent, doublon → 409 `duplicate`, suppression refusée → 409 `in_use`.
 */
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
  /** Champ d'ordre de la liste. */
  orderBy: string;
  /** Champ unique : `[champ, libellé du message]`. */
  unique: [string, string];
  search: string[];
  defaults: Record<string, unknown>;
  required: string[];
  decorate?: (row: Row) => Row;
  /** Message si la suppression est refusée (référence existante). */
  blockDelete?: (row: Row) => string | null;
}

const rowsOf = (name: Collection) => db[name] as unknown as Row[];
const now = () => new Date().toISOString();
const carrier = (id: unknown) => alive(db.carriers).find((c) => c.id === id);
const product = (id: unknown) => db.products.find((p) => p.id === id);

const decorateTank = (tank: Row) => ({
  ...tank,
  product_code: product(tank.product_id)?.code,
  product_label: product(tank.product_id)?.label,
});
const decorateCompartment = (c: Row) => ({
  ...c,
  allowed_product_codes: Array.isArray(c.allowed_product_ids)
    ? c.allowed_product_ids.map((id) => product(id)?.code)
    : null,
});

const CONFIGS: CrudConfig[] = [
  {
    name: "products",
    label: "Produit",
    orderBy: "code",
    unique: ["code", "Le code produit"],
    search: ["code", "label"],
    required: ["code", "label", "ref_density_15", "thermal_coeff"],
    defaults: { color: "#888888" },
    blockDelete: (row) =>
      db.stations.some((s) => !s.deleted_at && s.tanks.some((t) => t.product_id === row.id))
        ? "Ce produit est utilisé par des cuves de stations : il ne peut pas être supprimé."
        : null,
  },
  {
    name: "depots",
    label: "Dépôt",
    orderBy: "code",
    unique: ["code", "Le code dépôt"],
    search: ["code", "name", "address"],
    required: ["code", "name", "lat", "lon"],
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
    orderBy: "code",
    unique: ["code", "Le code station"],
    search: ["code", "name", "city", "region"],
    required: ["code", "name", "lat", "lon"],
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
    decorate: (row) => ({ ...row, tanks: ((row.tanks as Row[]) ?? []).map(decorateTank) }),
  },
  {
    name: "carriers",
    label: "Transporteur",
    orderBy: "name",
    unique: ["name", "Le nom de transporteur"],
    search: ["name", "contact"],
    required: ["name"],
    defaults: { type: "third_party", contact: null },
    blockDelete: (row) =>
      alive(db.trucks).some((t) => t.carrier_id === row.id) ||
      alive(db.drivers).some((d) => d.carrier_id === row.id)
        ? "Ce transporteur est rattaché à des camions ou à des chauffeurs : il ne peut pas être supprimé."
        : null,
  },
  {
    name: "trucks",
    label: "Camion",
    orderBy: "plate",
    unique: ["plate", "L'immatriculation"],
    search: ["plate", "notes"],
    required: ["plate", "size"],
    defaults: {
      carrier_id: null,
      avg_speed_kmh: null,
      status: "available",
      cost_per_km: null,
      notes: null,
      compartments: [],
    },
    decorate: (row) => ({
      ...row,
      carrier_name: carrier(row.carrier_id)?.name ?? null,
      carrier_type: carrier(row.carrier_id)?.type ?? null,
      compartments: [...((row.compartments as Row[]) ?? [])]
        .sort((a, b) => Number(a.position) - Number(b.position))
        .map(decorateCompartment),
    }),
  },
  {
    name: "drivers",
    label: "Chauffeur",
    orderBy: "full_name",
    unique: ["license_no", "Le numéro de permis"],
    search: ["full_name", "phone", "license_no"],
    required: ["full_name"],
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
      carrier_name: carrier(row.carrier_id)?.name ?? null,
      default_truck_plate: alive(db.trucks).find((t) => t.id === row.default_truck_id)?.plate ?? null,
    }),
  },
];

const strip = ({ deleted_at: _deleted, ...row }: Row) => row;

function check(config: CrudConfig, merged: Record<string, unknown>, selfId?: string) {
  const missing = config.required.filter(
    (field) => merged[field] === undefined || merged[field] === null || merged[field] === "",
  );
  if (missing.length)
    return validation(
      missing.map((field) => ({ field: `body.${field}`, message: "Champ obligatoire", type: "missing" })),
    );
  const [field, what] = config.unique;
  const value = merged[field];
  const other = value
    ? alive(rowsOf(config.name)).find(
        (row) => row.id !== selfId && String(row[field]).toLowerCase() === String(value).toLowerCase(),
      )
    : undefined;
  if (other) {
    return errorResponse(409, "duplicate", `${what} « ${String(value)} » est déjà utilisé.`, [
      { field, value: String(value), existing_id: other.id },
    ]);
  }
  return null;
}

/** Cuves en ligne : rapprochées par produit (comme `update_station`). */
function applyTanks(station: Row, wanted: Row[]): Response | null {
  const ids = wanted.map((t) => t.product_id);
  if (new Set(ids).size !== ids.length) {
    return errorResponse(409, "duplicate", "Une station ne peut avoir qu'une cuve par produit.", [
      { field: "tanks.product_id", value: String(ids[0]) },
    ]);
  }
  const bad = wanted.find((t) => Number(t.safety_stock_l ?? 0) > Number(t.capacity_l));
  if (bad) {
    return errorResponse(
      422,
      "validation_error",
      `Le stock de sécurité (${Number(bad.safety_stock_l)} L) dépasse la capacité de la cuve (${Number(bad.capacity_l)} L).`,
      [{ field: "safety_stock_l", value: bad.safety_stock_l }],
    );
  }
  const existing = (station.tanks as Row[]) ?? [];
  station.tanks = wanted.map((tank) => {
    const kept = existing.find((e) => e.product_id === tank.product_id);
    return {
      id: kept?.id ?? nextId(),
      station_id: station.id,
      product_id: tank.product_id,
      capacity_l: tank.capacity_l,
      safety_stock_l: tank.safety_stock_l ?? 0,
    };
  });
  return null;
}

/** Compartiments en ligne : rapprochés par position (comme `update_truck`), somme ≤ capacité totale. */
function applyCompartments(truck: Row, wanted: Row[] | undefined, total: number | null): Response | null {
  const list = wanted ?? (truck.compartments as Row[]) ?? [];
  const positions = list.map((c) => c.position);
  if (new Set(positions).size !== positions.length) {
    return errorResponse(409, "duplicate", "Deux compartiments ne peuvent pas avoir la même position.", [
      { field: "compartments.position", value: positions[0] },
    ]);
  }
  if (list.some((c) => Array.isArray(c.allowed_product_ids) && c.allowed_product_ids.length === 0)) {
    return errorResponse(
      422,
      "validation_error",
      "Liste de produits autorisés vide : indiquez null pour « tous produits ».",
      [{ field: "allowed_product_ids", value: [] }],
    );
  }
  const sum = list.reduce((acc, c) => acc + Number(c.capacity_l), 0);
  if (total === null) {
    if (list.length === 0) {
      return errorResponse(
        422,
        "validation_error",
        "Indiquez la capacité totale du camion ou la liste de ses compartiments.",
        [{ field: "total_capacity_l", value: null }],
      );
    }
    truck.total_capacity_l = sum;
  } else if (sum > total + 0.5) {
    return errorResponse(
      422,
      "validation_error",
      `La somme des capacités des compartiments (${sum} L) dépasse la capacité totale du camion (${total} L).`,
      [{ field: "total_capacity_l", value: total }],
    );
  }
  if (wanted) {
    const existing = (truck.compartments as Row[]) ?? [];
    truck.compartments = wanted.map((c) => ({
      id: existing.find((e) => e.position === c.position)?.id ?? nextId(),
      truck_id: truck.id,
      position: c.position,
      capacity_l: c.capacity_l,
      allowed_product_ids: c.allowed_product_ids ?? null,
    }));
  }
  return null;
}

function applyChildren(config: CrudConfig, row: Row, body: Record<string, unknown>): Response | null {
  if (config.name === "stations" && Array.isArray(body.tanks)) return applyTanks(row, body.tanks as Row[]);
  if (config.name === "trucks") {
    const total = (body.total_capacity_l ?? row.total_capacity_l ?? null) as number | null;
    return applyCompartments(
      row,
      Array.isArray(body.compartments) ? (body.compartments as Row[]) : undefined,
      total,
    );
  }
  return null;
}

function crud(config: CrudConfig): HttpHandler[] {
  const base = `${API}/${config.name}`;
  const decorate = (row: Row) => strip(config.decorate ? config.decorate(row) : row);
  const find = (id: unknown) => alive(rowsOf(config.name)).find((row) => row.id === id);
  const ordered = () =>
    alive(rowsOf(config.name)).sort((a, b) =>
      String(a[config.orderBy]).localeCompare(String(b[config.orderBy]), "fr", { numeric: true }),
    );

  const update = async ({ request, params }: { request: Request; params: Record<string, unknown> }) => {
    await wait();
    const user = authorize(request);
    if (user instanceof Response) return user;
    const row = find(params.id);
    if (!row) return notFound(config.label);
    const body = await readJson(request);
    const { id: _id, tanks: _tanks, compartments: _compartments, ...patch } = body;
    const invalid = check(config, { ...row, ...patch }, row.id);
    if (invalid) return invalid;
    // Tout ou rien : les sous-listes sont contrôlées sur une copie avant d'écrire.
    const draft: Row = structuredClone({ ...row, ...patch });
    const childError = applyChildren(config, draft, body);
    if (childError) return childError;
    Object.assign(row, draft, { updated_at: now() });
    return HttpResponse.json(decorate(row));
  };

  return [
    http.get(base, async ({ request }) => {
      await wait();
      const user = authenticate(request);
      if (user instanceof Response) return user;
      return HttpResponse.json(paginate(request, ordered().map(decorate), { search: config.search }));
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
      const { tanks: _tanks, compartments: _compartments, ...values } = body;
      const invalid = check(config, values);
      if (invalid) return invalid;
      const row: Row = {
        ...structuredClone(config.defaults),
        ...values,
        id: nextId(),
        created_at: now(),
        updated_at: now(),
      };
      const childError = applyChildren(config, row, body);
      if (childError) return childError;
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
      if (blocked) return errorResponse(409, "in_use", blocked);
      row.deleted_at = now();
      return new HttpResponse(null, { status: 204 });
    }),
  ];
}

/** Sous-routes de lecture (`/stations/{id}/tanks`, `/trucks/{id}/compartments`). */
function childLists(): HttpHandler[] {
  const list = (
    parent: "stations" | "trucks",
    field: "tanks" | "compartments",
    decorate: (row: Row) => Row,
  ) =>
    http.get(`${API}/${parent}/:parentId/${field}`, ({ request, params }) => {
      const user = authenticate(request);
      if (user instanceof Response) return user;
      const owner = alive(rowsOf(parent)).find((row) => row.id === params.parentId);
      return owner
        ? HttpResponse.json(paginate(request, ((owner[field] as Row[]) ?? []).map(decorate)))
        : notFound();
    });
  return [
    list("stations", "tanks", decorateTank as (row: Row) => Row),
    list("trucks", "compartments", decorateCompartment as (row: Row) => Row),
  ];
}

export const referentialHandlers: HttpHandler[] = [...childLists(), ...CONFIGS.flatMap(crud)];
