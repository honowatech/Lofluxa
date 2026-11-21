/** Doublures de l'administration (lot L8) : CRUD /users, GET/PUT /settings, GET /audit. */
import { http, HttpResponse } from "msw";

import type { Role, SettingValue } from "@/lib/types";
import { ROLES } from "@/lib/types";

import { db, nextId, SETTINGS_DEFAULTS, type MockUser } from "../db";
import {
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

const publicUser = ({ password: _password, ...user }: MockUser) => user;

function settingsList() {
  return Object.entries(SETTINGS_DEFAULTS).map(([key, [default_value, description]]) => ({
    key,
    value: db.settings[key]?.value ?? default_value,
    default_value,
    description,
    updated_at: db.settings[key]?.updated_at ?? null,
    updated_by: db.settings[key]?.updated_by ?? null,
  }));
}

function settingError(key: string, value: unknown): string | null {
  const fallback = SETTINGS_DEFAULTS[key]?.[0];
  if (value === null) return key === "pdf_logo_url" ? null : "Valeur obligatoire";
  if (typeof fallback === "number") {
    if (typeof value !== "number" || Number.isNaN(value)) return "Nombre attendu";
    if (value < 0) return "La valeur doit être positive";
  } else if (typeof value !== "string") return "Texte attendu";
  if (key === "day_start_time" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value)))
    return "Heure attendue au format HH:MM";
  return null;
}

export const adminHandlers = [
  /* ----------------------------------------------------------- utilisateurs */
  http.get(`${API}/users`, async ({ request }) => {
    await wait();
    const user = authorize(request);
    if (user instanceof Response) return user;
    return HttpResponse.json(paginate(request, db.users.map(publicUser), { search: ["email", "full_name"] }));
  }),

  http.post(`${API}/users`, async ({ request }) => {
    await wait();
    const user = authorize(request);
    if (user instanceof Response) return user;
    const body = await readJson(request);
    const email = String(body.email ?? "")
      .trim()
      .toLowerCase();
    const details = [];
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      details.push({ field: "body.email", message: "Adresse e-mail invalide" });
    if (!String(body.full_name ?? "").trim())
      details.push({ field: "body.full_name", message: "Champ obligatoire" });
    if (!ROLES.includes(body.role as Role)) details.push({ field: "body.role", message: "Rôle inconnu" });
    if (String(body.password ?? "").length < 12)
      details.push({ field: "body.password", message: "12 caractères minimum" });
    if (details.length) return validation(details);
    if (db.users.some((u) => u.email === email)) {
      return errorResponse(409, "conflict", "Un compte existe déjà avec cette adresse e-mail.", [
        { field: "body.email", message: "Adresse déjà utilisée" },
      ]);
    }
    const created: MockUser = {
      id: nextId(),
      email,
      full_name: String(body.full_name).trim(),
      role: body.role as Role,
      active: body.active !== false,
      password: String(body.password),
      last_login_at: null,
      created_at: new Date().toISOString(),
    };
    db.users.push(created);
    return HttpResponse.json(publicUser(created), { status: 201 });
  }),

  ...(["put", "patch"] as const).map((method) =>
    http[method](`${API}/users/:id`, async ({ request, params }) => {
      await wait();
      const user = authorize(request);
      if (user instanceof Response) return user;
      const target = db.users.find((u) => u.id === params.id);
      if (!target) return notFound("Utilisateur");
      const body = await readJson(request);
      if (body.password !== undefined && String(body.password).length < 12) {
        return validation([{ field: "body.password", message: "12 caractères minimum" }]);
      }
      if (target.id === user.id && (body.active === false || (body.role && body.role !== target.role))) {
        return errorResponse(
          409,
          "conflict",
          "Vous ne pouvez pas désactiver votre propre compte ni changer votre propre rôle.",
        );
      }
      if (typeof body.full_name === "string") target.full_name = body.full_name.trim();
      if (ROLES.includes(body.role as Role)) target.role = body.role as Role;
      if (typeof body.active === "boolean") target.active = body.active;
      if (typeof body.password === "string") target.password = body.password;
      return HttpResponse.json(publicUser(target));
    }),
  ),

  /* ------------------------------------------------------------- paramètres */
  http.get(`${API}/settings`, async ({ request }) => {
    await wait();
    const user = authenticate(request);
    if (user instanceof Response) return user;
    const items = settingsList();
    return HttpResponse.json({ items, total: items.length, limit: items.length, offset: 0 });
  }),

  http.put(`${API}/settings`, async ({ request }) => {
    await wait();
    const user = authorize(request);
    if (user instanceof Response) return user;
    const body = await readJson(request);
    const details = Object.entries(body)
      .map(([key, value]) => ({
        field: `body.${key}`,
        message: key in SETTINGS_DEFAULTS ? settingError(key, value) : "Paramètre inconnu",
      }))
      .filter((detail): detail is { field: string; message: string } => detail.message !== null);
    if (details.length) return validation(details);
    for (const [key, value] of Object.entries(body)) {
      const before = db.settings[key]?.value ?? SETTINGS_DEFAULTS[key][0];
      if (before === value) continue;
      db.settings[key] = {
        value: value as SettingValue,
        updated_at: new Date().toISOString(),
        updated_by: user.id,
      };
      db.audit.unshift({
        id: nextId(),
        table_name: "settings",
        row_id: key,
        action: "update",
        before: { value: before },
        after: { value: value as SettingValue },
        actor_id: user.id,
        actor_name: user.full_name,
        at: new Date().toISOString(),
      });
    }
    const items = settingsList();
    return HttpResponse.json({ items, total: items.length, limit: items.length, offset: 0 });
  }),

  /* ------------------------------------------------------------------ audit */
  http.get(`${API}/audit`, async ({ request }) => {
    await wait();
    const user = authorize(request);
    if (user instanceof Response) return user;
    const rows = [...db.audit].sort((a, b) => b.at.localeCompare(a.at));
    return HttpResponse.json(
      paginate(request, rows, {
        filters: {
          table: (row, value) => row.table_name === value,
          row_id: (row, value) => row.row_id.includes(value),
          actor_id: (row, value) => row.actor_id === value,
          from: (row, value) => row.at >= value,
          to: (row, value) => row.at < value,
        },
      }),
    );
  }),
];
