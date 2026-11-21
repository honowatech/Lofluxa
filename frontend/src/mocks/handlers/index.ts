import type { HttpHandler } from "msw";

import { adminHandlers } from "./admin";
import { authHandlers } from "./auth";
import { options } from "./helpers";
import { importHandlers } from "./imports";
import { referentialHandlers } from "./referentials";

/**
 * `partial` : routes non encore livrées seulement (/auth et /me restent servis par la vraie API).
 * `full`    : tout est simulé, jetons et rôles compris.
 * Quand un lot livre ses routes, retirer ses doublures de la liste `partial`.
 */
export function createHandlers(mode: "partial" | "full", latencyMs = 0): HttpHandler[] {
  options.auth = mode === "full";
  options.latencyMs = latencyMs;
  const undelivered = [...importHandlers, ...referentialHandlers, ...adminHandlers];
  return mode === "full" ? [...authHandlers, ...undelivered] : undelivered;
}
