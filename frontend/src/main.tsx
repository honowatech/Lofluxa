import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/app/App";
import { MOCKS_MODE } from "@/lib/config";

import "@/styles/index.css";

async function start() {
  // Doublures MSW des routes non encore livrées (VITE_MOCKS) : chargées à la demande, absentes sinon.
  if (MOCKS_MODE !== "off") {
    const { startMocks } = await import("@/mocks/browser");
    await startMocks(MOCKS_MODE);
  }
  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
