/**
 * Contrôle préalable des parcours contre la vraie API : exécuté une fois avant tous les fichiers `*.e2e.ts`
 * (dépendance du projet `e2e`). S'il échoue, aucun parcours n'est lancé et le message dit quoi démarrer.
 *
 *   1. API joignable, base de données et Redis en état ;
 *   2. limitation de débit désactivée (`TOURNEO_RATE_LIMIT_ENABLED=false`) : la suite se connecte bien plus
 *      de 10 fois par minute depuis une seule adresse ;
 *   3. worker Celery à l'écoute : calcul de plan, recalcul et rejeu sont des tâches de fond ;
 *   4. données communes en place (`l9-seed.ts`).
 *
 * Mise en route : voir `frontend/README.md`, section « Parcours de bout en bout ».
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, test as setup } from "@playwright/test";

import { API } from "./auth";
import { seedCommon } from "./l9-seed";

const BACKEND = fileURLToPath(new URL("../../backend", import.meta.url));
const START_API =
  "cd backend && TOURNEO_RATE_LIMIT_ENABLED=false uv run uvicorn app.main:app_instance --port 8000";
const START_WORKER = "cd backend && uv run celery -A app.worker.celery_app worker --loglevel=warning";

setup.describe.configure({ mode: "serial" });

setup("API joignable, base et Redis en état", async () => {
  let health: { status?: string; checks?: Record<string, string> };
  try {
    const response = await fetch(`${API}/health`);
    health = (await response.json()) as typeof health;
  } catch (error) {
    throw new Error(
      `API injoignable sur ${API} (${String(error)}).\n` +
        `Lancez d'abord ./scripts/dev_setup.sh, puis : ${START_API}`,
    );
  }
  expect(
    health.checks,
    `L'API répond mais une dépendance manque (${JSON.stringify(health)}). Relancez ./scripts/dev_setup.sh.`,
  ).toMatchObject({ database: "ok", redis: "ok" });
});

setup("limitation de débit désactivée pour les parcours", async () => {
  // Plafond par défaut : 10 connexions par minute et par adresse. Douze tentatives refusées (compte
  // inexistant, aucun effet sur les données) suffisent à savoir si la limitation est active.
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "controle-e2e@tourneo.invalid", password: "controle-e2e" }),
    });
    statuses.push(response.status);
    if (response.status === 429) break;
  }
  expect(
    statuses.includes(429),
    "L'API limite le débit des connexions (HTTP 429 obtenu) : la suite complète échouerait au hasard.\n" +
      `Arrêtez l'API en cours puis relancez-la ainsi (ou laissez Playwright la démarrer) :\n  ${START_API}\n` +
      "Attention : les connexions restent bloquées une minute sur l'API actuelle.",
  ).toBe(false);
});

setup("worker Celery à l'écoute", async () => {
  setup.setTimeout(60_000);
  const output = await new Promise<string>((resolve) => {
    execFile(
      "uv",
      ["run", "celery", "-A", "app.worker.celery_app", "inspect", "ping", "--timeout", "5"],
      { cwd: BACKEND, timeout: 45_000 },
      (error, stdout, stderr) => resolve(`${stdout}\n${stderr}\n${error ? String(error) : ""}`),
    );
  });
  expect(
    /pong/i.test(output),
    "Aucun worker Celery ne répond : les calculs de plan resteraient en attente.\n" +
      `Démarrez-le dans un autre terminal :\n  ${START_WORKER}\n\nRéponse de « celery inspect ping » :\n${output.trim()}`,
  ).toBe(true);
});

setup("données communes aux parcours (dépôts du fichier modèle)", async () => {
  console.log(`  ${await seedCommon()}`);
});
