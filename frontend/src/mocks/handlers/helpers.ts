import { delay, HttpResponse } from "msw";

import type { ApiErrorDetail, Page, Role } from "@/lib/types";

import { db, type MockUser } from "../db";

export const API = "*/api/v1";

/** Options des doublures : `auth` = simuler aussi /auth et /me et contrôler les jetons et les rôles. */
export interface MockOptions {
  auth: boolean;
  latencyMs: number;
}
export const options: MockOptions = { auth: true, latencyMs: 0 };

export const wait = () => (options.latencyMs > 0 ? delay(options.latencyMs) : Promise.resolve());

export function errorResponse(status: number, code: string, message: string, details: ApiErrorDetail[] = []) {
  return HttpResponse.json({ code, message, details }, { status });
}
export const notFound = (what = "Élément") => errorResponse(404, "not_found", `${what} introuvable.`);
export const forbidden = () => errorResponse(403, "forbidden", "Votre rôle ne permet pas cette action.");
export const validation = (details: ApiErrorDetail[]) =>
  errorResponse(422, "validation_error", "Requête invalide.", details);

/* ----------------------------------------------------------------- jetons */

export const ACCESS_TTL_MS = 15 * 60_000;
export const REFRESH_TTL_MS = 7 * 24 * 3600_000;

export function makeToken(
  type: "access" | "refresh",
  userId: string,
  ttlMs = type === "access" ? ACCESS_TTL_MS : REFRESH_TTL_MS,
): string {
  return `mock.${type}.${userId}.${Date.now() + ttlMs}`;
}

export function readToken(token: string | null | undefined, type: "access" | "refresh"): MockUser | null {
  const [prefix, kind, userId, expiry] = (token ?? "").split(".");
  if (prefix !== "mock" || kind !== type || Number(expiry) < Date.now()) return null;
  const user = db.users.find((u) => u.id === userId);
  return user && user.active ? user : null;
}

/** Utilisateur de la requête, ou réponse 401. En mode `partial`, le jeton vient de la vraie API : non contrôlé. */
export function authenticate(request: Request): MockUser | Response {
  if (!options.auth) return db.users[0];
  const header = request.headers.get("authorization") ?? "";
  const user = readToken(header.replace(/^Bearer\s+/i, ""), "access");
  return user ?? errorResponse(401, "unauthorized", "Authentification requise.");
}

/** Contrôle d'écriture : `admin` passe partout. */
export function authorize(request: Request, roles: Role[] = []): MockUser | Response {
  const user = authenticate(request);
  if (user instanceof Response) return user;
  if (options.auth && user.role !== "admin" && !roles.includes(user.role)) return forbidden();
  return user;
}

/* ------------------------------------------------------------------ listes */

const RESERVED = new Set(["limit", "offset", "sort", "q"]);

export function paginate<T extends object>(
  request: Request,
  rows: T[],
  config: {
    search?: (keyof T & string)[];
    filters?: Record<string, (row: T, value: string) => boolean>;
  } = {},
): Page<T> {
  const url = new URL(request.url);
  const params = url.searchParams;
  let out = [...rows];

  const q = params.get("q")?.trim().toLowerCase();
  if (q && config.search) {
    out = out.filter((row) =>
      config.search?.some((field) =>
        String(row[field] ?? "")
          .toLowerCase()
          .includes(q),
      ),
    );
  }
  for (const [key, value] of params.entries()) {
    if (RESERVED.has(key) || value === "") continue;
    const custom = config.filters?.[key];
    if (custom) out = out.filter((row) => custom(row, value));
    else out = out.filter((row) => !(key in row) || String((row as Record<string, unknown>)[key]) === value);
  }

  const sort = params.get("sort");
  if (sort) {
    const desc = sort.startsWith("-");
    const field = desc ? sort.slice(1) : sort;
    out.sort((a, b) => {
      const x = (a as Record<string, unknown>)[field];
      const y = (b as Record<string, unknown>)[field];
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      const result =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x).localeCompare(String(y), "fr", { numeric: true });
      return desc ? -result : result;
    });
  }

  const limit = Math.min(500, Math.max(1, Number(params.get("limit") ?? 50)));
  const offset = Math.max(0, Number(params.get("offset") ?? 0));
  return { items: out.slice(offset, offset + limit), total: out.length, limit, offset };
}

export const alive = <T extends { deleted_at?: string | null }>(rows: T[]): T[] =>
  rows.filter((row) => !row.deleted_at);

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/* ---------------------------------------------------------------- multipart */

export interface Upload {
  fields: Record<string, string>;
  files: Record<string, { name: string; text: string }>;
}

/**
 * Lecture d'un corps multipart sans `request.formData()` (qui ne répond pas sous jsdom avec MSW) :
 * découpage sur la frontière, contenu des fichiers décodé en UTF-8.
 */
export async function readUpload(request: Request): Promise<Upload> {
  const out: Upload = { fields: {}, files: {} };
  const boundary = /boundary=("?)([^";]+)\1/.exec(request.headers.get("content-type") ?? "")?.[2];
  if (!boundary) return out;
  const raw = new TextDecoder("latin1").decode(await request.arrayBuffer());
  const utf8 = (binary: string) =>
    new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  for (const part of raw.split(`--${boundary}`)) {
    const separator = part.indexOf("\r\n\r\n");
    if (separator < 0) continue;
    const head = utf8(part.slice(0, separator));
    const content = part.slice(separator + 4).replace(/\r\n$/, "");
    const name = /name="([^"]*)"/.exec(head)?.[1];
    if (!name) continue;
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (filename !== undefined) out.files[name] = { name: filename, text: utf8(content) };
    else out.fields[name] = utf8(content);
  }
  return out;
}
