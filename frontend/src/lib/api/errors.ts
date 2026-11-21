import { fr } from "@/i18n/fr";
import type { ApiErrorBody, ApiErrorDetail, Violation } from "@/lib/types";

/**
 * Erreur typée de l'API : reprend l'enveloppe `{code, message, details[]}` du back-end.
 * `message` est en français et destiné à l'utilisateur : on peut l'afficher tel quel.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ApiErrorDetail[];
  /** Délai d'attente demandé par le serveur (en-tête `Retry-After`, secondes) — 429 `rate_limited`. */
  readonly retryAfter: number | null;
  /**
   * Corps brut de la réponse d'erreur, tel que reçu (objet JSON, ou `null` si la réponse n'en avait pas).
   * Pour lire des champs hors enveloppe : `(error.body as { warnings?: Issue[] } | null)?.warnings`.
   */
  readonly body: unknown;

  constructor(status: number, body: Partial<ApiErrorBody>, retryAfter: number | null = null, raw?: unknown) {
    super(body.message || fr.errors.unknown);
    this.name = "ApiError";
    this.status = status;
    this.code = body.code || `http_${status}`;
    this.details = Array.isArray(body.details) ? body.details : [];
    this.retryAfter = retryAfter;
    this.body = raw === undefined ? body : raw;
  }

  /** Codes RM-xx portés par l'erreur, sans doublon, dans l'ordre. */
  get ruleCodes(): string[] {
    return [...new Set(this.details.map((d) => d.rule_code).filter((c): c is string => !!c))];
  }

  /** Premier code RM-xx (cas courant : une seule règle en cause). */
  get rule_code(): string | undefined {
    return this.ruleCodes[0];
  }

  /** Détails mis au format attendu par `ViolationsPanel`. */
  get violations(): Violation[] {
    return this.details
      .filter((d) => d.rule_code)
      .map((d) => ({
        rule_code: d.rule_code as string,
        severity: d.severity ?? "blocking",
        message: d.message ?? this.message,
        trip_id: (d.trip_id as string | undefined) ?? null,
        stop_id: (d.stop_id as string | undefined) ?? null,
        order_id: (d.order_id as string | undefined) ?? null,
      }));
  }

  /**
   * Erreurs par champ (422 de validation, 409 `duplicate`) : `{ "email": "…" }`.
   * Le préfixe `body.` de FastAPI est retiré pour correspondre aux noms des champs de formulaire.
   * Un détail sans message propre (ex. doublon : `{field, value}`) reprend le message de l'erreur.
   */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const d of this.details) {
      if (!d.field) continue;
      const name = d.field.replace(/^(body|query|path)\./, "");
      if (!(name in out)) out[name] = d.message || this.message;
    }
    return out;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isConflict(): boolean {
    return this.status === 409;
  }
  get isValidation(): boolean {
    return this.status === 422;
  }
  get isRateLimited(): boolean {
    return this.status === 429;
  }
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** Message affichable pour n'importe quelle erreur attrapée. */
export function errorMessage(error: unknown): string {
  if (isApiError(error)) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fr.errors.unknown;
}
