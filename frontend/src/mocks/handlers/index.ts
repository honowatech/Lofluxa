import type { HttpHandler } from "msw";

import { adminHandlers } from "./admin";
import { authHandlers } from "./auth";
import { options } from "./helpers";
import { importHandlers } from "./imports";
import { referentialHandlers } from "./referentials";
import { createScreenHandlers } from "./screens";

/**
 * `partial` : seules les routes NON ENCORE LIVRÉES par le back-end sont simulées (liste `undelivered`) ;
 *             tout le reste va à la vraie API.
 * `full`    : tout est simulé, jetons et rôles compris (démonstration, captures et tests sans back-end) :
 *             routes du socle (authentification, référentiels, imports, administration) puis doublures des
 *             écrans de vague 2 (`screens.ts`).
 *
 * Toutes les routes des écrans livrés existent dans l'API réelle : `undelivered` est vide. Un écran dont
 * les routes n'existent pas encore y ajoute ses doublures, puis les en retire.
 */
export function createHandlers(mode: "partial" | "full", latencyMs = 0): HttpHandler[] {
  options.auth = mode === "full";
  options.latencyMs = latencyMs;
  const undelivered: HttpHandler[] = [];
  if (mode !== "full") return undelivered;
  return [
    ...authHandlers,
    ...importHandlers,
    ...referentialHandlers,
    ...adminHandlers,
    ...createScreenHandlers(),
    ...undelivered,
  ];
}
