/** Serveur MSW des tests Vitest (mode `full` : jetons et rôles simulés). */
import { setupServer } from "msw/node";

import { createHandlers } from "./handlers";

export const server = setupServer(...createHandlers("full"));
