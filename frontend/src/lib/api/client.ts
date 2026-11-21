/**
 * Client HTTP de l'API Tournéo.
 *
 *   const page = await api<Page<Station>>("/stations", { query: { limit: 50, offset: 0 } });
 *   await api("/stations", { method: "POST", body: input });
 *
 * - préfixe `/api/v1` ajouté automatiquement ;
 * - jeton d'accès joint à chaque requête ;
 * - sur 401 : rafraîchissement transparent (une seule requête de rafraîchissement, même si
 *   plusieurs appels échouent en même temps), puis nouvel essai ; si le rafraîchissement
 *   échoue, la session est fermée et l'utilisateur renvoyé à l'écran de connexion ;
 * - toute réponse en erreur lève une `ApiError` (code, message, details, rule_code).
 */
import { fr } from "@/i18n/fr";
import { getTokens, setTokens } from "@/lib/auth/tokens";
import { API_BASE } from "@/lib/config";
import type { ApiErrorBody, TokenPair } from "@/lib/types";

import { ApiError } from "./errors";

export type QueryValue = string | number | boolean | null | undefined | (string | number)[];
export type Query = Record<string, QueryValue>;

export interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Query;
  /** Objet sérialisé en JSON, ou `FormData` (envoi multipart). */
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** `false` pour les routes publiques (connexion, rafraîchissement). */
  auth?: boolean;
}

export function buildUrl(path: string, query?: Query): string {
  const url = path.startsWith("http") || path.startsWith(API_BASE) ? path : `${API_BASE}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) value.forEach((v) => params.append(key, String(v)));
    else params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

let sessionExpiredHandler: (() => void) | null = null;
/** Enregistré par le magasin de session : appelé quand le rafraîchissement échoue. */
export function onSessionExpired(handler: () => void): void {
  sessionExpiredHandler = handler;
}

let refreshInFlight: Promise<boolean> | null = null;

/** Rafraîchit les jetons ; requêtes concurrentes mutualisées. Renvoie `false` si la session est perdue. */
export function refreshTokens(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  const tokens = getTokens();
  if (!tokens) return Promise.resolve(false);
  refreshInFlight = (async () => {
    try {
      const response = await fetch(buildUrl("/auth/refresh"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ refresh_token: tokens.refresh_token }),
      });
      if (!response.ok) return false;
      const pair = (await response.json()) as TokenPair;
      setTokens({ access_token: pair.access_token, refresh_token: pair.refresh_token });
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> = {};
  try {
    const text = await response.text();
    if (text) {
      const parsed = JSON.parse(text) as Partial<ApiErrorBody> & { detail?: unknown };
      body = parsed;
      // Réponse FastAPI brute (hors enveloppe) : `{detail: "…"}`.
      if (!parsed.message && typeof parsed.detail === "string") body = { message: parsed.detail };
    }
  } catch {
    // Corps non JSON (ex. erreur 502 du proxy) : message générique ci-dessous.
  }
  if (!body.message) {
    body.message =
      response.status >= 500
        ? fr.errors.server
        : response.status === 403
          ? fr.errors.forbidden
          : response.status === 404
            ? fr.errors.notFound
            : fr.errors.unknown;
  }
  return new ApiError(response.status, body);
}

/** Requête brute authentifiée (avec rafraîchissement sur 401). Lève `ApiError` si la réponse est en erreur. */
export async function apiFetch(path: string, options: ApiOptions = {}): Promise<Response> {
  const { method = "GET", query, body, signal, headers = {}, auth = true } = options;
  const url = buildUrl(path, query);

  let tokenUsed: string | null = null;
  const send = (): Promise<Response> => {
    const finalHeaders: Record<string, string> = { Accept: "application/json", ...headers };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      finalHeaders["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const tokens = auth ? getTokens() : null;
    tokenUsed = tokens?.access_token ?? null;
    if (tokens) finalHeaders.Authorization = `Bearer ${tokens.access_token}`;
    return fetch(url, { method, headers: finalHeaders, body: payload, signal });
  };

  let response: Response;
  try {
    response = await send();
    if (response.status === 401 && auth && getTokens()) {
      // Si un autre appel a déjà rafraîchi les jetons pendant celui-ci, on rejoue sans rafraîchir de nouveau.
      const alreadyRefreshed = getTokens()?.access_token !== tokenUsed;
      if (alreadyRefreshed || (await refreshTokens())) {
        response = await send();
      } else {
        setTokens(null);
        sessionExpiredHandler?.();
        throw new ApiError(401, { code: "session_expired", message: fr.errors.sessionExpired });
      }
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, { code: "network_error", message: fr.errors.network });
  }

  if (!response.ok) throw await toApiError(response);
  return response;
}

/** Appel JSON typé. `T = void` pour les réponses 204. */
export async function api<T = void>(path: string, options: ApiOptions = {}): Promise<T> {
  const response = await apiFetch(path, options);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  const type = response.headers.get("content-type") ?? "";
  return (type.includes("json") ? JSON.parse(text) : text) as T;
}
