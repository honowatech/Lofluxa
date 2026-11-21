/**
 * Doublures des imports (lot L3) : prévisualiser → appliquer, fichiers modèles.
 * Un CSV est réellement analysé ; un .xlsx (non lisible ici) renvoie un rapport d'exemple,
 * avec des lignes en erreur si le nom du fichier contient « erreur ».
 */
import { http, HttpResponse } from "msw";

import type { ImportKind } from "@/lib/types";

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
  columns: string[];
  required: string[];
  numeric: string[];
  sample: Record<string, unknown>[];
}

const KINDS: Partial<Record<ImportKind, KindConfig>> = {
  stations: {
    collection: "stations",
    key: "code",
    columns: ["code", "name", "region", "city", "lat", "lon", "max_truck_size", "unload_time_min"],
    required: ["code", "name", "lat", "lon"],
    numeric: ["lat", "lon", "unload_time_min"],
    sample: [
      {
        code: "DLA-001",
        name: "OLA Akwa Boulevard",
        region: "Littoral",
        city: "Douala",
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
        code: "DLA-032",
        name: "OLA Youpwé",
        region: "Littoral",
        city: "Douala",
        lat: 4.0098,
        lon: 9.7061,
        max_truck_size: "small",
      },
    ],
  },
  depots: {
    collection: "depots",
    key: "code",
    columns: ["code", "name", "operator", "lat", "lon", "avg_wait_min", "max_loadings_per_truck_day"],
    required: ["code", "name", "lat", "lon"],
    numeric: ["lat", "lon", "avg_wait_min", "max_loadings_per_truck_day"],
    sample: [{ code: "DEP-EDE", name: "Dépôt Edéa", operator: "internal", lat: 3.8012, lon: 10.1298 }],
  },
  trucks: {
    collection: "trucks",
    key: "plate",
    columns: ["plate", "size", "total_capacity_l", "avg_speed_kmh", "cost_per_km"],
    required: ["plate", "size", "total_capacity_l"],
    numeric: ["total_capacity_l", "avg_speed_kmh", "cost_per_km"],
    sample: [
      { plate: "LT 482 AB", size: "large", total_capacity_l: 33000 },
      { plate: "LT 915 BC", size: "medium", total_capacity_l: 20000 },
    ],
  },
  drivers: {
    collection: "drivers",
    key: "license_no",
    columns: ["full_name", "phone", "license_no", "license_expiry", "hazmat_cert", "hazmat_expiry"],
    required: ["full_name", "license_no"],
    numeric: [],
    sample: [
      {
        full_name: "Jean-Paul Mbarga",
        license_no: "CE-100234",
        license_expiry: "2028-03-01",
        hazmat_cert: true,
      },
      { full_name: "Luc Abega", license_no: "CE-220981", license_expiry: "2027-09-15", hazmat_cert: true },
    ],
  },
};

type ReportRow = {
  row: number;
  status: "ok" | "error";
  action: string | null;
  errors: { field: string | null; message: string }[];
  data: Record<string, unknown>;
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

function buildReport(config: KindConfig, records: Record<string, unknown>[]): ReportRow[] {
  const seen = new Set<string>();
  const existing = alive(db[config.collection] as { deleted_at?: string | null }[]) as unknown as Record<
    string,
    unknown
  >[];
  return records.map((record, index) => {
    const errors: ReportRow["errors"] = [];
    const data: Record<string, unknown> = { ...record };
    for (const field of config.required) {
      if (record[field] === undefined || record[field] === null || record[field] === "")
        errors.push({ field, message: "Valeur obligatoire manquante" });
    }
    for (const field of config.numeric) {
      const raw = record[field];
      if (raw === undefined || raw === null || raw === "") continue;
      const value = Number(String(raw).replace(",", "."));
      if (Number.isNaN(value)) errors.push({ field, message: `Nombre attendu, reçu « ${String(raw)} »` });
      else data[field] = value;
    }
    if (typeof data.lat === "number" && Math.abs(data.lat) > 90)
      errors.push({ field: "lat", message: "Latitude hors bornes (−90 à 90)" });
    const key = String(record[config.key] ?? "").toLowerCase();
    if (key) {
      if (seen.has(key))
        errors.push({
          field: config.key,
          message: `Doublon dans le fichier : « ${String(record[config.key])} »`,
        });
      seen.add(key);
    }
    const found = existing.some((row) => String(row[config.key] ?? "").toLowerCase() === key);
    return {
      row: index + 2,
      status: errors.length ? "error" : "ok",
      action: errors.length ? null : found ? "update" : "create",
      errors,
      data,
    };
  });
}

export const importHandlers = [
  http.get(`${API}/imports/templates/:kind`, ({ request, params }) => {
    const user = authenticate(request);
    if (user instanceof Response) return user;
    const config = KINDS[params.kind as ImportKind];
    if (!config) return notFound("Modèle");
    const example = config.sample[0];
    const csv = `\ufeff${config.columns.join(";")}\n${config.columns.map((c) => example[c] ?? "").join(";")}\n`;
    return new HttpResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="modele_${String(params.kind)}.csv"`,
      },
    });
  }),

  http.post(`${API}/imports/:kind/preview`, async ({ request, params }) => {
    await wait();
    const user = authorize(request);
    if (user instanceof Response) return user;
    const kind = params.kind as ImportKind;
    const config = KINDS[kind];
    if (!config) return errorResponse(404, "not_found", `Type d'import inconnu : ${String(kind)}.`);
    const file = (await readUpload(request)).files.file;
    if (!file) return validation([{ field: "body.file", message: "Fichier manquant", type: "missing" }]);

    let records: Record<string, unknown>[];
    if (file.name.toLowerCase().endsWith(".csv")) {
      records = parseCsv(file.text);
    } else {
      records = structuredClone(config.sample);
      if (file.name.toLowerCase().includes("erreur")) {
        records.push({ ...config.sample[0], [config.key]: "", [config.required[1]]: "" });
        records.push({
          ...config.sample[0],
          [config.key]: config.sample[0][config.key],
          ...(config.numeric[0] ? { [config.numeric[0]]: "abc" } : {}),
        });
      }
    }
    const rows = buildReport(config, records);
    const batch = {
      id: nextId(),
      kind,
      filename: file.name,
      status: "previewed" as const,
      row_count: rows.length,
      error_count: rows.filter((row) => row.status === "error").length,
      report: { rows },
      created_at: new Date().toISOString(),
    };
    db.imports.push({ ...batch, rows: rows as never });
    return HttpResponse.json(batch);
  }),

  http.post(`${API}/imports/:batchId/apply`, async ({ request, params }) => {
    await wait();
    const user = authorize(request);
    if (user instanceof Response) return user;
    const batch = db.imports.find((b) => b.id === params.batchId);
    if (!batch) return notFound("Lot d'import");
    if (batch.status === "applied") return errorResponse(409, "conflict", "Ce lot a déjà été appliqué.");
    if (batch.error_count > 0)
      return errorResponse(409, "conflict", "Le lot contient des lignes en erreur : corrigez le fichier.");
    const config = KINDS[batch.kind] as KindConfig;
    const target = db[config.collection] as unknown as Record<string, unknown>[];
    for (const row of batch.rows) {
      const data = row.data ?? {};
      const existing = target.find(
        (t) =>
          !t.deleted_at &&
          String(t[config.key] ?? "").toLowerCase() === String(data[config.key] ?? "").toLowerCase(),
      );
      if (existing) Object.assign(existing, data, { updated_at: new Date().toISOString() });
      else {
        const defaults: Record<string, unknown> =
          config.collection === "stations"
            ? {
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
              }
            : config.collection === "depots"
              ? {
                  operator: "scdp",
                  address: null,
                  opening_hours: {},
                  avg_wait_min: null,
                  max_loadings_per_truck_day: null,
                  active: true,
                }
              : config.collection === "trucks"
                ? {
                    carrier_id: null,
                    avg_speed_kmh: null,
                    status: "available",
                    cost_per_km: null,
                    notes: null,
                    compartments: [],
                  }
                : {
                    phone: null,
                    license_expiry: null,
                    hazmat_cert: false,
                    hazmat_expiry: null,
                    carrier_id: null,
                    status: "available",
                    default_truck_id: null,
                  };
        target.push({
          ...defaults,
          ...data,
          id: nextId(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
    }
    batch.status = "applied";
    return HttpResponse.json({
      id: batch.id,
      kind: batch.kind,
      filename: batch.filename,
      status: batch.status,
      row_count: batch.row_count,
      error_count: 0,
      report: { rows: batch.rows },
    });
  }),
];
