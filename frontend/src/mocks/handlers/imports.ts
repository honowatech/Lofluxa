/**
 * Doublures des imports, alignées sur le lot L3 (`backend/app/imports/`) :
 * `preview` (201) → lot avec `can_apply` et rapport `{summary, issues, items}` ; `apply` → 409
 * `import_has_errors` / `already_applied`.
 * Simplification assumée : un CSV est analysé d'après des en-têtes techniques (`code;name;lat;lon`) et non
 * les en-têtes français des vrais modèles ; un .xlsx (non lisible ici) donne un rapport d'exemple, avec
 * des lignes en erreur si le nom du fichier contient « erreur ». Le parcours réel est couvert par Playwright.
 */
import { http, HttpResponse } from "msw";

import type { ImportBatch, ImportIssue, ImportItem, ImportKind } from "@/lib/types";

import { db, nextId } from "../db";
import {
  alive,
  API,
  authenticate,
  authorize,
  errorResponse,
  notFound,
  readUpload,
  validation,
  wait,
} from "./helpers";

interface KindConfig {
  collection: "stations" | "trucks" | "drivers" | "depots";
  key: string;
  label: string;
  columns: string[];
  required: string[];
  numeric: string[];
  labels: Record<string, string>;
  defaults: Record<string, unknown>;
  sample: Record<string, unknown>[];
}

const KINDS: Partial<Record<ImportKind, KindConfig>> = {
  stations: {
    collection: "stations",
    key: "code",
    label: "name",
    columns: ["code", "name", "region", "city", "lat", "lon", "max_truck_size", "unload_time_min"],
    required: ["code", "name", "lat", "lon"],
    numeric: ["lat", "lon", "unload_time_min"],
    labels: {
      code: "Code",
      name: "Nom",
      region: "Région",
      city: "Ville",
      lat: "Latitude",
      lon: "Longitude",
      max_truck_size: "Gabarit max",
      unload_time_min: "Temps de dépotage",
    },
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
    sample: [
      {
        code: "DLA-001",
        name: "OLA Akwa Boulevard",
        region: "Littoral",
        city: "Douala Akwa",
        lat: 4.0502,
        lon: 9.6958,
        max_truck_size: "large",
      },
      {
        code: "DLA-031",
        name: "OLA Bonamoussadi Carrefour",
        region: "Littoral",
        city: "Douala",
        lat: 4.0871,
        lon: 9.7412,
        max_truck_size: "medium",
      },
      {
        code: "DLA-002",
        name: "OLA Bonanjo",
        region: "Littoral",
        city: "Douala",
        lat: 4.0429,
        lon: 9.6869,
        max_truck_size: "large",
      },
    ],
  },
  depots: {
    collection: "depots",
    key: "code",
    label: "name",
    columns: ["code", "name", "operator", "lat", "lon", "avg_wait_min", "max_loadings_per_truck_day"],
    required: ["code", "name", "lat", "lon"],
    numeric: ["lat", "lon", "avg_wait_min", "max_loadings_per_truck_day"],
    labels: { code: "Code", name: "Nom", operator: "Exploitant", lat: "Latitude", lon: "Longitude" },
    defaults: {
      operator: "scdp",
      address: null,
      opening_hours: {},
      avg_wait_min: null,
      max_loadings_per_truck_day: null,
      active: true,
    },
    sample: [{ code: "DEP-EDE", name: "Dépôt Edéa", operator: "internal", lat: 3.8012, lon: 10.1298 }],
  },
  trucks: {
    collection: "trucks",
    key: "plate",
    label: "plate",
    columns: ["plate", "size", "total_capacity_l", "avg_speed_kmh", "cost_per_km"],
    required: ["plate", "size", "total_capacity_l"],
    numeric: ["total_capacity_l", "avg_speed_kmh", "cost_per_km"],
    labels: { plate: "Immatriculation", size: "Gabarit", total_capacity_l: "Capacité totale" },
    defaults: {
      carrier_id: null,
      avg_speed_kmh: null,
      status: "available",
      cost_per_km: null,
      notes: null,
      compartments: [],
    },
    sample: [{ plate: "LT 915 BC", size: "medium", total_capacity_l: 20000 }],
  },
  drivers: {
    collection: "drivers",
    key: "license_no",
    label: "full_name",
    columns: ["full_name", "phone", "license_no", "license_expiry", "hazmat_cert", "hazmat_expiry"],
    required: ["full_name", "license_no"],
    numeric: [],
    labels: { full_name: "Nom complet", license_no: "N° de permis", license_expiry: "Expiration du permis" },
    defaults: {
      phone: null,
      license_expiry: null,
      hazmat_cert: false,
      hazmat_expiry: null,
      carrier_id: null,
      status: "available",
      default_truck_id: null,
    },
    sample: [
      { full_name: "Luc Abega", license_no: "CE-220981", license_expiry: "2027-09-15", hazmat_cert: true },
    ],
  },
};

function parseCsv(text: string): Record<string, string>[] {
  const lines = text
    .replace(/^\ufeff/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];
  const separator = lines[0].includes(";") ? ";" : ",";
  const header = lines[0].split(separator).map((cell) => cell.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(separator);
    return Object.fromEntries(header.map((name, index) => [name, (cells[index] ?? "").trim()]));
  });
}

function analyse(config: KindConfig, records: Record<string, unknown>[]) {
  const issues: ImportIssue[] = [];
  const items: ImportItem[] = [];
  const valid: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const existing = alive(db[config.collection] as { deleted_at?: string | null }[]) as unknown as Record<
    string,
    unknown
  >[];

  records.forEach((record, index) => {
    const row = index + 2;
    const before = issues.length;
    const data: Record<string, unknown> = {};
    const issue = (column: string, message: string) =>
      issues.push({
        row,
        column: config.labels[column] ?? column,
        value: record[column] === undefined ? null : String(record[column]),
        message,
        severity: "error",
      });

    for (const [column, raw] of Object.entries(record))
      if (raw !== "" && raw !== null && raw !== undefined) data[column] = raw;
    for (const column of config.required)
      if (data[column] === undefined) issue(column, "Valeur obligatoire manquante.");
    for (const column of config.numeric) {
      if (data[column] === undefined) continue;
      const value = Number(String(data[column]).replace(",", "."));
      if (Number.isNaN(value)) issue(column, "Nombre attendu.");
      else data[column] = value;
    }
    if (typeof data.lat === "number" && Math.abs(data.lat) > 90)
      issue("lat", "Latitude hors bornes (−90 à 90).");
    const key = String(data[config.key] ?? "").toLowerCase();
    if (key) {
      if (seen.has(key)) issue(config.key, "Doublon dans le fichier.");
      seen.add(key);
    }
    if (issues.length > before) return;

    const current = existing.find((entry) => String(entry[config.key] ?? "").toLowerCase() === key);
    const changes = current
      ? Object.entries(data)
          .filter(([field, value]) => current[field] !== value)
          .map(([field, value]) => ({
            field,
            label: config.labels[field] ?? field,
            before: current[field] ?? null,
            after: value,
          }))
      : [];
    items.push({
      row,
      key: String(data[config.key]),
      label: String(data[config.label]),
      action: !current ? "create" : changes.length ? "update" : "unchanged",
      changes,
    });
    valid.push(data);
  });

  const count = (action: ImportItem["action"]) => items.filter((item) => item.action === action).length;
  const errorRows = new Set(issues.map((entry) => entry.row)).size;
  return {
    issues,
    items,
    valid,
    errorRows,
    summary: {
      created: count("create"),
      updated: count("update"),
      unchanged: count("unchanged"),
      errors: issues.length,
      warnings: 0,
    },
  };
}

type StoredBatch = (typeof db.imports)[number];
const publicBatch = ({ records: _records, ...batch }: StoredBatch): ImportBatch => batch;

export const importHandlers = [
  http.get(`${API}/imports/templates/:kind`, ({ request, params }) => {
    const user = authenticate(request);
    if (user instanceof Response) return user;
    const config = KINDS[params.kind as ImportKind];
    if (!config)
      return errorResponse(
        404,
        "unknown_import_kind",
        `L'import « ${String(params.kind)} » n'est pas disponible.`,
      );
    const example = config.sample[0];
    const csv = `\ufeff${config.columns.join(";")}\n${config.columns.map((c) => example[c] ?? "").join(";")}\n`;
    return new HttpResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${String(params.kind)}.csv"`,
      },
    });
  }),

  http.post(`${API}/imports/:kind/preview`, async ({ request, params }) => {
    await wait();
    const user = authorize(request);
    if (user instanceof Response) return user;
    const kind = params.kind as ImportKind;
    const config = KINDS[kind];
    if (!config)
      return errorResponse(404, "unknown_import_kind", `L'import « ${String(kind)} » n'est pas disponible.`);
    const file = (await readUpload(request)).files.file;
    if (!file) return validation([{ field: "body.file", message: "Fichier manquant", type: "missing" }]);

    let records: Record<string, unknown>[];
    if (file.name.toLowerCase().endsWith(".csv")) {
      records = parseCsv(file.text);
    } else {
      records = structuredClone(config.sample);
      if (file.name.toLowerCase().includes("erreur")) {
        records.push({ ...config.sample[0], [config.key]: "", [config.label]: "" });
        records.push({ ...config.sample[0], ...(config.numeric[0] ? { [config.numeric[0]]: "abc" } : {}) });
      }
    }
    const report = analyse(config, records);
    const id = nextId();
    const batch: StoredBatch = {
      id,
      batch_id: id,
      kind,
      filename: file.name,
      status: "previewed",
      row_count: records.length,
      error_count: report.errorRows,
      can_apply: report.issues.length === 0 && records.length > 0,
      created_at: new Date().toISOString(),
      created_by: user.id,
      report: { summary: report.summary, issues: report.issues, items: report.items },
      records: report.valid,
    };
    db.imports.push(batch);
    return HttpResponse.json(publicBatch(batch), { status: 201 });
  }),

  http.post(`${API}/imports/:batchId/apply`, async ({ request, params }) => {
    await wait();
    const user = authorize(request);
    if (user instanceof Response) return user;
    const batch = db.imports.find((b) => b.id === params.batchId);
    if (!batch) return notFound("Lot d'import");
    if (batch.status === "applied") {
      return errorResponse(
        409,
        "already_applied",
        "Ce lot a déjà été appliqué : il ne peut pas l'être une seconde fois.",
      );
    }
    if (batch.error_count > 0) {
      return errorResponse(
        409,
        "import_has_errors",
        "Ce lot contient des erreurs : corrigez le fichier et relancez la prévisualisation.",
      );
    }
    const config = KINDS[batch.kind] as KindConfig;
    const target = db[config.collection] as unknown as Record<string, unknown>[];
    const stamp = new Date().toISOString();
    for (const data of batch.records) {
      const key = String(data[config.key] ?? "").toLowerCase();
      const existing = target.find(
        (entry) => !entry.deleted_at && String(entry[config.key] ?? "").toLowerCase() === key,
      );
      if (existing) Object.assign(existing, data, { updated_at: stamp });
      else
        target.push({
          ...structuredClone(config.defaults),
          ...data,
          id: nextId(),
          created_at: stamp,
          updated_at: stamp,
        });
    }
    batch.status = "applied";
    batch.can_apply = false;
    return HttpResponse.json(publicBatch(batch));
  }),
];
