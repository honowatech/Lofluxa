/**
 * Aides de connexion des parcours du socle. L'aide commune à tous les lots est `./auth` (`openSession`,
 * `fetchTokens`, `submitLogin`) ; ce fichier la réexporte et garde les noms utilisés par les parcours du socle.
 */
import type { APIRequestContext } from "@playwright/test";

import { ADMIN, fetchTokens, type Credentials, type Tokens } from "./auth";

export { ADMIN, API, submitLogin, type Tokens } from "./auth";
/** Délai de test à prévoir quand une attente de limitation de débit est possible. */
export const PATIENT_TIMEOUT = 200_000;

/** Connexion par l'API (le premier argument n'est plus utilisé : conservé pour les appels existants). */
export function apiLogin(_request?: APIRequestContext, credentials: Credentials = ADMIN): Promise<Tokens> {
  return fetchTokens(credentials);
}
