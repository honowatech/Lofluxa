import { defineConfig, devices } from "@playwright/test";

/**
 * Deux projets :
 *  - `e2e`      : bout en bout contre la VRAIE API (aucune doublure) — `pnpm e2e`
 *  - `captures` : captures d'écran des écrans livrés, sur doublures complètes — `pnpm captures`
 * Les serveurs sont démarrés au besoin (ou réutilisés s'ils tournent déjà).
 * Prérequis de `e2e` : `./scripts/dev_setup.sh` (PostgreSQL, Redis, migrations, compte admin du seed), une API
 * sans limitation de débit et un worker Celery — vérifiés avant le premier parcours (projet `prerequis`).
 */
const REAL = "http://localhost:5173";
const MOCKED = "http://localhost:5174";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 60_000,
  use: { locale: "fr-FR", timezoneId: "Africa/Douala", trace: "off" },
  projects: [
    // Contrôle préalable (API, limitation de débit désactivée, worker Celery) : voir `e2e/prerequis.setup.ts`.
    { name: "prerequis", testMatch: /prerequis\.setup\.ts/ },
    {
      name: "e2e",
      testMatch: /.*\.e2e\.ts/,
      dependencies: ["prerequis"],
      use: { ...devices["Desktop Chrome"], baseURL: REAL },
    },
    {
      name: "captures",
      testMatch: /captures\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: MOCKED,
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
      },
    },
  ],
  webServer: [
    {
      command: "cd ../backend && uv run uvicorn app.main:app_instance --port 8000",
      // La suite complète se connecte bien plus de 10 fois par minute depuis une seule adresse : l'API lancée
      // par les parcours tourne sans limitation de débit (variable réelle du back-end). Si une API tourne déjà,
      // c'est SON réglage qui s'applique : `e2e/prerequis.setup.ts` le vérifie et dit quoi relancer.
      // La limitation elle-même reste testée : côté serveur par le back-end, côté écran par doublure
      // (`e2e/login.e2e.ts`, `src/app/app.test.tsx`).
      env: { TOURNEO_RATE_LIMIT_ENABLED: "false" },
      url: "http://localhost:8000/api/v1/health",
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: "pnpm exec vite --port 5173 --strictPort",
      url: REAL,
      env: { VITE_MOCKS: "off" },
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: "pnpm exec vite --port 5174 --strictPort",
      url: MOCKED,
      env: { VITE_MOCKS: "full", VITE_TILES_URL: "" },
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
