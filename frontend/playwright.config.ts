import { defineConfig, devices } from "@playwright/test";

/**
 * Deux projets :
 *  - `e2e`      : bout en bout contre la VRAIE API (aucune doublure) — `pnpm e2e`
 *  - `captures` : captures d'écran des écrans livrés, sur doublures complètes — `pnpm captures`
 * Les serveurs sont démarrés au besoin (ou réutilisés s'ils tournent déjà).
 * Prérequis de `e2e` : `./scripts/dev_setup.sh` (PostgreSQL, Redis, migrations, compte admin du seed).
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
    { name: "e2e", testMatch: /.*\.e2e\.ts/, use: { ...devices["Desktop Chrome"], baseURL: REAL } },
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
