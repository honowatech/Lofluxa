/**
 * Doublures de l'administration, alignées sur le lot L8 :
 * `/users` (+ `activate`, `deactivate`, `reset-password`), `GET/PUT /settings` (`{values}`), `GET /audit`.
 */
import { http, HttpResponse } from "msw";

import { PASSWORD_MIN_LENGTH } from "@/lib/config";
import { addDays, dayBoundsUtc } from "@/lib/format";
import type { Role, SettingValue } from "@/lib/types";
import { ROLES } from "@/lib/types";

import { db, nextId, SETTINGS_DEFAULTS, SETTINGS_SPECS, type MockUser } from "../db";
import { API, authorize, errorResponse, notFound, paginate, readJson, validation, wait } from "./helpers";

const publicUser = ({ password: _password, ...user }: MockUser) => user;
const stamp = () => new Date().toISOString();

function settingsPage() {
  const items = Object.entries(SETTINGS_DEFAULTS).map(([key, [fallback, description]]) => {
    const stored = db.settings[key];
    const value = stored?.value ?? fallback;
    const spec = SETTINGS_SPECS[key];
    return {
      key,
      value,
      default: fallback,
      description,
      type: spec.type,
      min: spec.min ?? null,
      max: spec.max ?? null,
      nullable: !!spec.nullable,
      is_default: value === fallback,
      updated_by: stored?.updated_by ?? null,
      updated_by_name: db.users.find((u) => u.id === stored?.updated_by)?.full_name ?? null,
      updated_at: stored?.updated_at ?? null,
    };
  });
  return { items, total: items.length, limit: 50, offset: 0 };
}

/** Mêmes messages que `admin/settings_spec.py` → `normalize`. */
function settingError(key: string, value: unknown): string | null {
  const spec = SETTINGS_SPECS[key];
  if (value === null || value === "") return spec.nullable ? null : "Une valeur est obligatoire.";
  if (spec.type === "int" || spec.type === "float") {
    if (typeof value !== "number" || Number.isNaN(value)) return "Valeur attendue : un nombre.";
    if (spec.type === "int" && !Number.isInteger(value)) return "Valeur attendue : un nombre entier.";
    if (spec.min !== undefined && value < spec.min)
      return `La valeur doit être supérieure ou égale à ${spec.min}.`;
    if (spec.max !== undefined && value > spec.max)
      return `La valeur doit être inférieure ou égale à ${spec.max}.`;
    return null;
  }
  if (typeof value !== "string") return "Valeur attendue : un texte.";
  if (spec.maxLength && value.length > spec.maxLength) return `${spec.maxLength} caractères au maximum.`;
  if (spec.type === "time" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))
    return "Format attendu : HH:MM (par exemple 06:00).";
  return null;
}

function passwordError(password: unknown) {
  return String(password ?? "").length < PASSWORD_MIN_LENGTH
    ? errorResponse(
        422,
        "validation_error",
        `Le mot de passe doit compter au moins ${PASSWORD_MIN_LENGTH} caractères.`,
        [
          {
            field: "password",
            message: `Le mot de passe doit compter au moins ${PASSWORD_MIN_LENGTH} caractères.`,
          },
        ],
      )
    : null;
}

const SELF_DEACTIVATION = () =>
  errorResponse(409, "self_deactivation", "Vous ne pouvez pas désactiver votre propre compte.");

export const adminHandlers = [
  /* ----------------------------------------------------------- utilisateurs */
  http.get(`${API}/users`, async ({ request }) => {
    await wait();
    const user = authorize(request);
    if (user instanceof Response) return user;
    const rows = [...db.users].sort((a, b) => a.full_name.localeCompare(b.full_name, "fr")).map(publicUser);
    return HttpResponse.json(paginate(request, rows, { search: ["email", "full_name"] }));
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
    if (details.length) return validation(details);
    const weak = passwordError(body.password);
    if (weak) return weak;
    if (db.users.some((u) => u.email === email)) {
      return errorResponse(409, "email_taken", "Un compte existe déjà avec cette adresse e-mail.", [
        { field: "email", message: "Adresse e-mail déjà utilisée." },
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
      created_at: stamp(),
      updated_at: stamp(),
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
      if (target.id === user.id && body.active === false) return SELF_DEACTIVATION();
      if (target.id === user.id && body.role && body.role !== target.role) {
        return errorResponse(409, "self_role_change", "Vous ne pouvez pas modifier votre propre rôle.");
      }
      if (typeof body.full_name === "string") target.full_name = body.full_name.trim();
      if (ROLES.includes(body.role as Role)) target.role = body.role as Role;
      if (typeof body.active === "boolean") target.active = body.active;
      target.updated_at = stamp();
      return HttpResponse.json(publicUser(target));
    }),
  ),

  ...(["activate", "deactivate"] as const).map((action) =>
    http.post(`${API}/users/:id/${action}`, async ({ request, params }) => {
      await wait();
      const user = authorize(request);
      if (user instanceof Response) return user;
      const target = db.users.find((u) => u.id === params.id);
      if (!target) return notFound("Utilisateur");
      if (action === "deactivate" && target.id === user.id) return SELF_DEACTIVATION();
      target.active = action === "activate";
      target.updated_at = stamp();
      return HttpResponse.json(publicUser(target));
    }),
  ),

  http.post(`${API}/users/:id/reset-password`, async ({ request, params }) => {
    await wait();
    const user = authorize(request);
    if (user instanceof Response) return user;
    const target = db.users.find((u) => u.id === params.id);
    if (!target) return notFound("Utilisateur");
    if (target.id === user.id) {
      return errorResponse(
        409,
        "self_password_reset",
        "Pour votre propre compte, utilisez le changement de mot de passe (PUT /me/password).",
      );
    }
    const body = await readJson(request);
    const weak = passwordError(body.password);
    if (weak) return weak;
    target.password = String(body.password);
    return new HttpResponse(null, { status: 204 });
  }),

  /* ------------------------------------------------------------- paramètres */
  http.get(`${API}/settings`, async ({ request }) => {
    await wait();
    const user = authorize(request, [...ROLES]);
    if (user instanceof Response) return user;
    return HttpResponse.json(settingsPage());
  }),

  http.put(`${API}/settings`, async ({ request }) => {
    await wait();
    const user = authorize(request);
    if (user instanceof Response) return user;
    const body = await readJson(request);
    const values = body.values as Record<string, unknown> | undefined;
    if (!values || typeof values !== "object" || Object.keys(values).length === 0) {
      return validation([{ field: "body.values", message: "Champ obligatoire", type: "missing" }]);
    }
    // Tout ou rien : une seule valeur refusée annule l'ensemble.
    const details = Object.entries(values)
      .map(([key, value]) => ({
        field: key,
        message: key in SETTINGS_DEFAULTS ? settingError(key, value) : "Paramètre inconnu.",
      }))
      .filter((detail): detail is { field: string; message: string } => detail.message !== null);
    if (details.length) {
      return errorResponse(
        422,
        "validation_error",
        "Paramètres refusés : aucune valeur n'a été enregistrée.",
        details,
      );
    }
    for (const [key, raw] of Object.entries(values)) {
      const value = (raw === "" ? null : raw) as SettingValue;
      const before = db.settings[key]?.value ?? SETTINGS_DEFAULTS[key][0];
      if (before === value) continue;
      db.settings[key] = { value, updated_at: stamp(), updated_by: user.id };
      db.audit.unshift({
        id: nextId(),
        table_name: "settings",
        row_id: key,
        action: "update",
        before: { value: before },
        after: { value },
        actor_id: user.id,
        actor_name: user.full_name,
        actor_email: user.email,
        at: stamp(),
      });
    }
    return HttpResponse.json(settingsPage());
  }),

  /* ------------------------------------------------------------------ audit */
  http.get(`${API}/audit`, async ({ request }) => {
    await wait();
    const user = authorize(request, ["manager"]);
    if (user instanceof Response) return user;
    const rows = [...db.audit].sort((a, b) => b.at.localeCompare(a.at));
    return HttpResponse.json(
      paginate(request, rows, {
        filters: {
          table: (row, value) => row.table_name === value,
          row_id: (row, value) => row.row_id === value,
          actor_id: (row, value) => row.actor_id === value,
          action: (row, value) => row.action === value,
          // Jours locaux, bornes incluses.
          date_from: (row, value) => row.at >= dayBoundsUtc(value).from,
          date_to: (row, value) => row.at < dayBoundsUtc(addDays(value, 0)).to,
        },
      }),
    );
  }),
];
