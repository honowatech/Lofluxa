/**
 * Lot L14 — bout en bout contre la VRAIE API (aucune doublure) :
 * importer la journée de référence → rejouer avec le moteur → lire le verdict → exporter le PDF,
 * puis consultation par la direction.
 *
 * Prérequis : `./scripts/dev_setup.sh`, l'API et **un worker Celery** (le rejeu est une tâche de fond) :
 *   cd backend && uv run celery -A app.worker.celery_app worker --loglevel=warning
 * Les référentiels et les comptes du parcours sont créés par `l14-seed.ts` (imports idempotents).
 */
import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

import {
  ADMIN,
  DISPATCHER,
  ensureUsers,
  login as apiLogin,
  MANAGER,
  referenceDayWorkbook,
  seedReferentials,
} from "./l14-seed";

const DAY = "2027-01-13";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
let comparisonUrl = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const admin = await apiLogin(ADMIN);
  await ensureUsers(admin);
  await seedReferentials(admin);
});

async function login(page: Page, account: { email: string; password: string }) {
  await page.goto("/connexion");
  await page.getByLabel("Adresse e-mail").fill(account.email);
  await page.getByLabel("Mot de passe", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page.getByTestId("user-menu")).toBeVisible();
}

test("dispatcher : import de la journée A → rejeu → verdict → PDF", async ({ page }) => {
  test.setTimeout(240_000);
  await login(page, DISPATCHER);
  await page.goto(`/comparaison?day=${DAY}`);
  await expect(page.getByRole("heading", { level: 1, name: "Comparaison A / B" })).toBeVisible();
  await expect(page.getByTestId("mocks-badge")).toHaveCount(0);

  // 1. Import : un fichier fautif est d'abord contrôlé, le rapport cite feuille, ligne et colonne.
  await page.getByRole("button", { name: "Importer la journée A" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Importer une journée de référence" });
  const fileInput = dialog.getByLabel("Fichier de la journée");
  await fileInput.setInputFiles({
    name: "journee_erreurs.xlsx",
    mimeType: XLSX,
    buffer: referenceDayWorkbook(DAY, { broken: true }),
  });
  await dialog.getByRole("button", { name: "Contrôler le fichier" }).click();
  const report = dialog.getByTestId("reference-report");
  await expect(report.getByText(/Fichier rejeté : 2 erreur\(s\)/)).toBeVisible();
  await expect(report.getByRole("row").filter({ hasText: "Station inconnue : L14-INCONNUE." })).toContainText(
    "Tournées",
  );
  await expect(report.getByRole("row").filter({ hasText: "Camion inconnu : LT 999 ZZ." })).toContainText(
    "Camion",
  );
  await expect(dialog.getByRole("button", { name: "Importer la journée" })).toHaveCount(0);

  // 2. Fichier corrigé : contrôle, puis import (remplacement confirmé si le parcours a déjà tourné).
  await fileInput.setInputFiles({
    name: "journee_reference.xlsx",
    mimeType: XLSX,
    buffer: referenceDayWorkbook(DAY),
  });
  await dialog.getByLabel("Temps de préparation du plan manuel").fill("105");
  await dialog.getByLabel("Libellé").fill("Journée A — parcours e2e");
  await dialog.getByRole("button", { name: "Contrôler le fichier" }).click();
  await expect(report.getByText("Fichier valide pour la journée du 13/01/2027.")).toBeVisible();
  await expect(report.getByTestId("reference-summary")).toContainText(
    "15 commandes · 6 tournées · 14 arrêts",
  );
  await dialog.getByRole("button", { name: "Importer la journée" }).click();

  const replace = page.getByRole("alertdialog", { name: "Remplacer la journée de référence ?" });
  await expect(replace.or(page.getByText("Il manque le plan B"))).toBeVisible({ timeout: 30_000 });
  if (await replace.isVisible()) await replace.getByRole("button", { name: "Remplacer" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  // 3. La journée importée est le plan A ; il manque B : rejeu par le moteur, progression affichée.
  await expect(page.getByText("Il manque le plan B")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Plan A" }).locator("option:checked")).toContainText(
    "Journée de référence · v1 · Brouillon — Journée A — parcours e2e",
  );
  await page.getByRole("button", { name: "Rejouer avec le moteur" }).first().click();
  await expect(page.getByTestId("replay-progress")).toBeVisible();

  // 4. Verdict : ouvert automatiquement sur A ↔ rejeu, cohérent avec ce que renvoie l'API.
  const verdict = page.getByTestId("verdict");
  await expect(verdict).toBeVisible({ timeout: 180_000 });
  await expect(page).toHaveURL(/[?&]a=[0-9a-f-]{36}.*[?&]b=[0-9a-f-]{36}/);
  comparisonUrl = new URL(page.url()).pathname + new URL(page.url()).search;
  const query = new URL(page.url()).searchParams;
  const token = await page.evaluate(
    () => JSON.parse(window.localStorage.getItem("tourneo.tokens") ?? "{}").access_token as string,
  );
  const api = await page.request.get(`/api/v1/comparison?plan_a=${query.get("a")}&plan_b=${query.get("b")}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(api.ok()).toBe(true);
  const expected = (await api.json()) as {
    verdict: { message: string; success: boolean | null; no_blocking_violation: boolean };
    plan_b: { kind: string; parent_plan_id: string };
    routes_a: unknown[];
    routes_b: unknown[];
  };
  expect(expected.plan_b.kind).toBe("replay");
  expect(expected.plan_b.parent_plan_id).toBe(query.get("a"));
  await expect(verdict.getByTestId("verdict-message")).toHaveText(expected.verdict.message);
  await expect(verdict.getByTestId("verdict-status")).toHaveText(
    expected.verdict.success ? /^Objectif (kilométrique )?atteint/ : "Objectif non atteint",
  );
  await expect(verdict.locator("[data-met]")).toHaveCount(3);
  // Pas de serveur d'itinéraires dans cet environnement : les distances approchées sont signalées.
  await expect(verdict.getByTestId("verdict-approximate")).toContainText("Distances approchées");

  // 5. Indicateurs, cartes côte à côte et détail d'une tournée.
  const table = page.getByTestId("metrics-table");
  await expect(table.locator("tbody tr[data-metric]")).toHaveCount(20);
  await expect(table.locator('[data-metric="prep_time_s"]')).toContainText("(saisi)");
  await expect(table.locator('[data-metric="distance_actual_m"] td').nth(1)).toHaveText("—");
  await expect(page.getByRole("figure", { name: "Carte du plan A" })).toBeVisible();
  await expect(page.getByRole("figure", { name: "Carte du plan B" })).toBeVisible();
  const planA = page.getByTestId("plan-a");
  const planB = page.getByTestId("plan-b");
  await expect(planA.locator("tr[data-trip]")).toHaveCount(expected.routes_a.length);
  await expect(planB.locator("tr[data-trip]")).toHaveCount(expected.routes_b.length);
  await expect(planA.getByText("Commandes non servies (1)")).toBeVisible();
  await planB.getByRole("button", { name: "Tournée 1", exact: true }).click();
  await expect(planB.getByTestId("trip-detail")).toContainText("Départ prévu");

  // 6. Export PDF.
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Exporter le PDF" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`comparaison_AB_${DAY}.pdf`);
  const content = await readFile((await file.path()) as string);
  expect(content.subarray(0, 5).toString()).toBe("%PDF-");
  expect(content.length).toBeGreaterThan(10_000);
});

test("direction : consulte la comparaison partagée et exporte, sans import ni rejeu", async ({ page }) => {
  test.skip(!comparisonUrl, "dépend du parcours précédent");
  await login(page, MANAGER);
  await page.goto(comparisonUrl);
  await expect(page.getByTestId("verdict")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/réservés au dispatcher/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Importer la journée A" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Rejouer/ })).toHaveCount(0);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Exporter le PDF" }).click();
  expect((await download).suggestedFilename()).toBe(`comparaison_AB_${DAY}.pdf`);

  // Volet « Suivi de la journée B » : aucun plan publié ce jour-là, l'écran le dit.
  await page.getByRole("tab", { name: "Suivi de la journée B" }).click();
  await expect(page.getByTestId("dashboard-panel")).toBeVisible();
  await expect(page.getByText("Aucun plan publié pour ce jour")).toBeVisible();

  // Le serveur reste seul juge : l'import est refusé à ce rôle.
  const token = await page.evaluate(
    () => JSON.parse(window.localStorage.getItem("tourneo.tokens") ?? "{}").access_token as string,
  );
  const refused = await page.request.post("/api/v1/reference-days/import", {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      dry_run: "true",
      file: { name: "journee.xlsx", mimeType: XLSX, buffer: referenceDayWorkbook(DAY) },
    },
  });
  expect(refused.status()).toBe(403);
});
