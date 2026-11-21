/**
 * Captures de l'écran Plan de tournées → `docs/captures/l12-*.png`, sur la VRAIE API avec des plans réalistes
 * (jeux `demo_douala` et `demo_scale`, créés par l'API pour des jours neufs).
 *
 *   L12_CAPTURES=1 pnpm exec playwright test --project=e2e --trace off l12-shots
 *
 * Ignoré par `pnpm e2e` (sans la variable) : les captures ne sont régénérées qu'à la demande.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

import { ADMIN, Api, freshDay, seedPlan } from "./l12-seed";

test.skip(!process.env.L12_CAPTURES, "captures régénérées à la demande (L12_CAPTURES=1)");
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
test.setTimeout(300_000);

const OUT = "docs/captures";
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${OUT}/l12-${name}.png`, animations: "disabled" });

interface ApiTrip {
  id: string;
  seq: number;
  truck_capacity_l: number;
  planned_l: number;
  stops: { id: string; planned_l: number }[];
}

async function login(page: Page) {
  await page.goto("/connexion");
  await page.getByLabel("Adresse e-mail").fill(ADMIN.email);
  await page.getByLabel("Mot de passe", { exact: true }).fill(ADMIN.password);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page.getByTestId("user-menu")).toBeVisible();
}

async function startDrag(page: Page, handle: Locator, target: Locator) {
  const from = await handle.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error("Élément à glisser ou cible introuvable");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x - 30, from.y + from.height / 2, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
}

const saved = (page: Page) => expect(page.getByTestId("plan-sync")).toHaveAttribute("data-state", "saved");
/** Masque les notifications déjà affichées (par style : leurs nœuds appartiennent à React, on n'y touche pas). */
const hideToasts = (page: Page) =>
  page.evaluate(() =>
    document
      .querySelectorAll<HTMLElement>("[data-sonner-toast]")
      .forEach((toast) => toast.style.setProperty("display", "none", "important")),
  );

test("captures : plan réaliste, édition, violation, publication, versions", async ({ page }) => {
  // Pénurie de gasoil : plusieurs tournées et des commandes non servies.
  const day = freshDay();
  const { planId } = await seedPlan({ fixture: "demo_douala", day, stocks: { GASOIL: 30000 } });
  const api = await Api.login();
  const plan = await api.call<{ trips: ApiTrip[] }>("GET", `/plans/${planId}`);
  // Tournée la plus chargée (cible) et plus gros arrêt d'une autre tournée : le déplacement déborde le camion (RM-05).
  const target = [...plan.trips].sort(
    (a, b) => a.truck_capacity_l - a.planned_l - (b.truck_capacity_l - b.planned_l),
  )[0];
  const source = plan.trips
    .filter((trip) => trip.id !== target.id && trip.stops.length > 1)
    .sort((a, b) => b.planned_l - a.planned_l)[0];
  const moved = [...source.stops].sort((a, b) => b.planned_l - a.planned_l)[0];

  await login(page);
  await page.goto(`/plan?day=${day}`);
  const list = page.getByRole("region", { name: "Liste des tournées" });
  const detail = page.getByRole("region", { name: "Détail de la tournée" });
  await expect(list.locator("[data-trip-card]")).toHaveCount(plan.trips.length);
  await page.waitForTimeout(1200);
  await shot(page, "01-plan-vue-ensemble");

  await list.getByRole("button", { name: `Afficher la tournée ${source.seq}` }).click();
  await page.locator(".maplibregl-marker, [data-stop]").nth(2).hover();
  await page.waitForTimeout(400);
  await shot(page, "02-tournee-selectionnee-detail");

  // Glisser-déposer en cours, puis violation bloquante après dépôt.
  const row = detail.locator(`[data-stop-row="${moved.id}"]`);
  await startDrag(page, row.getByRole("button").first(), list.locator(`[data-trip-card="${target.id}"]`));
  await shot(page, "03-glisser-deposer-arret");
  await page.mouse.up();
  await saved(page);
  await expect(
    page.getByTestId("violations-panel").locator('[data-severity="blocking"]').first(),
  ).toBeVisible();
  await page.mouse.move(700, 500);
  await shot(page, "04-violation-bloquante-publication-desactivee");

  await page.getByRole("radio", { name: "Tableau" }).click();
  await page.getByTestId("violations-panel").locator("button").first().click();
  await shot(page, "05-vue-tableau");
  await page
    .locator("table [data-stop-row]")
    .nth(1)
    .getByRole("button", { name: /vers une autre tournée/ })
    .click();
  await expect(page.getByRole("menu")).toBeVisible();
  await shot(page, "06-deplacer-au-clavier-menu");
  await page.keyboard.press("Escape");
  await page.getByRole("radio", { name: "Carte" }).click();

  // Verrouillage d'une tournée intacte, puis « Recalculer en conservant ».
  const untouched = plan.trips.find((trip) => trip.id !== source.id && trip.id !== target.id) ?? source;
  await list.getByRole("button", { name: `Verrouiller la tournée ${untouched.seq}`, exact: true }).click();
  await saved(page);
  await page.getByRole("button", { name: "Recalculer en conservant" }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await shot(page, "07-recalculer-confirmation");
  await page.getByRole("alertdialog").getByRole("button", { name: "Recalculer" }).click();
  await expect(page.getByTestId("recompute-progress")).toContainText(/\d+ %/);
  await page.waitForTimeout(1500);
  await shot(page, "08-recalcul-en-cours");
  await expect(page.getByTestId("recompute-progress")).toHaveCount(0, { timeout: 120_000 });
  await hideToasts(page);

  // Publication.
  await page.getByRole("button", { name: "Publier", exact: true }).click();
  await expect(page.getByRole("alertdialog", { name: "Publier ce plan ?" })).toBeVisible();
  await shot(page, "09-publier-confirmation");
  await page.getByRole("alertdialog").getByRole("button", { name: "Publier" }).click();
  await expect(page.getByText("Publié", { exact: true })).toBeVisible();
  await list.locator("[data-trip-button]").first().click();
  await page.waitForTimeout(600);
  await shot(page, "10-plan-publie-feuilles-de-route");
  await hideToasts(page);

  // Modification du plan publié : nouvelle version brouillon.
  await list
    .getByRole("button", { name: /^Verrouiller la tournée \d+$/ })
    .first()
    .click();
  await expect(page.getByText(/Nouvelle version brouillon/).first()).toBeVisible();
  await saved(page);
  await page.waitForTimeout(500);
  await shot(page, "11-nouvelle-version-brouillon");
  await hideToasts(page);
  await page.getByRole("button", { name: "Historique" }).click();
  await expect(page.getByTestId("version-1")).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, "12-historique-versions");
});

test("captures : commande urgente non servie (RM-15), plan de 30 tournées, aucun plan", async ({ page }) => {
  const urgentDay = freshDay();
  await seedPlan({ fixture: "demo_douala", day: urgentDay, stocks: { GASOIL: 0 } });
  await login(page);
  await page.goto(`/plan?day=${urgentDay}`);
  await expect(page.getByTestId("unserved-banner")).toContainText("urgente");
  await page.getByRole("button", { name: /Tout afficher/ }).click();
  await page.locator("[data-trip-button]").first().click();
  await page.waitForTimeout(1200);
  await shot(page, "13-commande-urgente-non-servie");

  const scaleDay = freshDay();
  await seedPlan({ fixture: "demo_scale", day: scaleDay });
  await page.goto(`/plan?day=${scaleDay}`);
  await expect(page.locator("[data-trip-card]").nth(20)).toBeVisible();
  await page.locator("[data-trip-button]").nth(3).click();
  await page.waitForTimeout(1500);
  await shot(page, "14-plan-30-tournees-carte");
  await page.getByRole("radio", { name: "Tableau" }).click();
  await page.waitForTimeout(500);
  await shot(page, "15-plan-30-tournees-tableau");

  await page.goto("/plan?day=2031-03-03");
  await expect(page.getByText("Aucun plan pour cette journée")).toBeVisible();
  await shot(page, "16-aucun-plan");
});
