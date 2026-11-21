import type { HttpHandler } from "msw";

import { adminHandlers } from "./admin";
import { authHandlers } from "./auth";
import { options } from "./helpers";
import { importHandlers } from "./imports";
import { referentialHandlers } from "./referentials";

/**
 * `partial` : seules les routes NON ENCORE LIVRÉES par le back-end sont simulées (liste `undelivered`) ;
 *             tout le reste va à la vraie API.
 * `full`    : tout est simulé, jetons et rôles compris (démonstration et tests sans back-end).
 *
 * Les routes d'authentification, de référentiels, d'imports et d'administration sont livrées (lots L3
 * et L8) : `undelivered` est donc vide. Un écran de vague 2 y ajoute ses propres doublures tant que
 * ses routes n'existent pas, puis les en retire.
 */
export function createHandlers(mode: "partial" | "full", latencyMs = 0): HttpHandler[] {
  options.auth = mode === "full";
  options.latencyMs = latencyMs;
  const undelivered: HttpHandler[] = [];
  const delivered = [...authHandlers, ...importHandlers, ...referentialHandlers, ...adminHandlers];
  return mode === "full" ? [...delivered, ...undelivered] : undelivered;
}
