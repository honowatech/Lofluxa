/**
 * Lot L14 — captures de l'écran Comparaison A / B, sur la vraie API et un jeu réaliste (Douala) :
 *   L14_CAPTURES=1 pnpm exec playwright test --project=e2e --trace off e2e/l14-captures.e2e.ts
 * Ignoré sans `L14_CAPTURES` (un simple `pnpm e2e` ne réécrit pas les images). Worker Celery requis.
 */
import { expect, test, type Page } from "@playwright/test";

import {
  declareBreakdown,
  DISPATCHER,
  listPlans,
  login as apiLogin,
  MANAGER,
  referenceDayWorkbook,
  seedComparison,
  seedDayB,
} from "./l14-seed";

const DAY_A = "2027-01-12";
const DAY_B = "2027-01-28";
const OUT = "docs/captures";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
test.skip(!process.env.L14_CAPTURES, "captures : lancer avec L14_CAPTURES=1");

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${OUT}/l14-${name}.png`, animations: "disabled" });

/** La zone de contenu défile dans la coquille : on agrandit la fenêtre pour une capture de page entière. */
async function fullShot(page: Page, name: string) {
  const height = await page.evaluate(() => (document.querySelector("#contenu")?.scrollHeight ?? 820) + 60);
  await page.setViewportSize({ width: 1440, height: Math.min(height, 4000) });
  await page.waitForTimeout(600);
  await shot(page, name);
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function login(page: Page, account: { email: string; password: string }) {
  await page.goto("/connexion");
  await page.getByLabel("Adresse e-mail").fill(account.email);
  await page.getByLabel("Mot de passe", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page.getByTestId("user-menu")).toBeVisible();
}

test("captures de l'écran Comparaison A / B", async ({ page }) => {
  test.setTimeout(480_000);
  const { planA, planB } = await seedComparison(DAY_A);
  const publishedB = await seedDayB(DAY_B);
  const pair = (a: string, b: string, db = DAY_A) =>
    `/comparaison?day=${DAY_A}&a=${a}&b=${b}&da=${DAY_A}&db=${db}`;

  await login(page, DISPATCHER);

  // Verdict favorable : journée A contre son rejeu (présélection automatique).
  await page.goto(`/comparaison?day=${DAY_A}`);
  await expect(page.getByTestId("verdict")).toBeVisible();
  await expect(page.getByTestId("plan-b").locator("tr[data-trip]").first()).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, "01-verdict-favorable");
  await fullShot(page, "02-page-entiere");

  // Cartes côte à côte, une tournée du plan B détaillée.
  await page
    .getByTestId("plan-b")
    .locator("tr[data-trip]")
    .getByRole("button", { name: "Tournée 1", exact: true })
    .click();
  await page.getByRole("heading", { name: "Tournées sur la carte" }).scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const main = document.querySelector("#contenu");
    const target = document.querySelector("#maps-heading");
    if (main && target) main.scrollTop += target.getBoundingClientRect().top - 70;
  });
  await page.waitForTimeout(500);
  await shot(page, "03-cartes-detail-tournee");

  // Résultat défavorable, affiché avec la même force : les deux plans inversés.
  await page.goto(pair(planB, planA));
  await expect(page.getByTestId("verdict")).toHaveAttribute("data-outcome", "failure");
  await page.waitForTimeout(800);
  await shot(page, "04-verdict-defavorable");

  // Deux plans quelconques : journée A (12/01) contre le plan publié et exécuté de la journée B (20/01).
  await page.goto(pair(planA, publishedB, DAY_B));
  await expect(page.getByTestId("verdict")).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, "05-journee-a-contre-journee-b");

  // Import de la journée de référence : rapport d'erreurs, puis fichier valide.
  await page.goto(`/comparaison?day=${DAY_A}`);
  await expect(page.getByTestId("verdict")).toBeVisible();
  await page.getByRole("button", { name: "Importer la journée A" }).click();
  const dialog = page.getByRole("dialog", { name: "Importer une journée de référence" });
  await dialog.getByLabel("Fichier de la journée").setInputFiles({
    name: "journee_2027-01-12_brouillon.xlsx",
    mimeType: XLSX,
    buffer: referenceDayWorkbook(DAY_A, { broken: true }),
  });
  await dialog.getByRole("button", { name: "Contrôler le fichier" }).click();
  await expect(dialog.getByTestId("reference-report")).toBeVisible();
  await shot(page, "06-import-rapport-erreurs");

  await dialog.getByLabel("Fichier de la journée").setInputFiles({
    name: "journee_2027-01-12.xlsx",
    mimeType: XLSX,
    buffer: referenceDayWorkbook(DAY_A),
  });
  await dialog.getByLabel("Temps de préparation du plan manuel").fill("105");
  await dialog.getByLabel("Libellé").fill("Journée A — dispatch manuel");
  await dialog.getByRole("button", { name: "Contrôler le fichier" }).click();
  await expect(dialog.getByText(/Fichier valide/)).toBeVisible();
  await shot(page, "07-import-controle-valide");
  await dialog.getByRole("button", { name: "Importer la journée" }).click();
  const replace = page.getByRole("alertdialog", { name: "Remplacer la journée de référence ?" });
  await expect(replace).toBeVisible();
  await shot(page, "08-import-remplacement-confirme");
  await replace.getByRole("button", { name: "Annuler" }).click();
  await dialog.getByRole("button", { name: "Annuler" }).click();

  // Rejeu en cours.
  await page.getByRole("button", { name: "Rejouer à nouveau" }).click();
  await expect(page.getByTestId("replay-progress")).toBeVisible();
  await page.waitForTimeout(1500);
  await shot(page, "09-rejeu-en-cours");
  await expect(page.getByTestId("replay-progress")).toBeHidden({ timeout: 180_000 });

  // Suivi de la journée B, après une panne de camion (nouvelle version publiée).
  await declareBreakdown(DAY_B);
  await page.goto(`/comparaison?day=${DAY_B}&vue=suivi`);
  await expect(page.getByTestId("dashboard-trips")).toBeVisible();
  await page.waitForTimeout(500);
  await shot(page, "10-suivi-journee-b");

  // Direction : lecture et export seulement.
  await page.getByTestId("user-menu").click();
  await page.getByRole("menuitem", { name: "Se déconnecter" }).click();
  await login(page, MANAGER);
  const latest = (await listPlans(await apiLogin(MANAGER), DAY_A)).find(
    (plan) => plan.kind === "replay" && plan.status !== "archived",
  );
  await page.goto(pair(planA, latest?.id ?? planB));
  await expect(page.getByTestId("verdict")).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, "11-direction-lecture-seule");
});
