/** Démarrage des doublures dans le navigateur (`VITE_MOCKS=partial|full`). */
import { setupWorker } from "msw/browser";

import { createHandlers } from "./handlers";

export async function startMocks(mode: "partial" | "full"): Promise<void> {
  const worker = setupWorker(...createHandlers(mode, 120));
  await worker.start({
    onUnhandledRequest: "bypass",
    quiet: true,
    serviceWorker: { url: "/mockServiceWorker.js" },
  });
}
