/**
 * Captures d'écran des écrans L11 (Journée, Commandes du jour, Disponibilité du jour) → `docs/captures/l11-*.png`.
 * Contre la VRAIE API, avec le jeu fictif `demo_douala` chargé par l'API : aucune doublure.
 *
 *   L11_CAPTURES=1 pnpm exec playwright test --project=e2e --trace off l11-captures
 *
 * Ignoré par `pnpm e2e` sans cette variable : les captures ne sont régénérées que sur demande. Le scénario
 * travaille sur un jour encore vierge de 2028 (ou `L11_CAPTURE_DAY`) : il est relançable tel quel.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";

import { openSession, type Credentials } from "./auth";
import {
  Api,
  DISPATCHER,
  DRIVER_FREE,
  DRIVER_OTHER,
  freshDay,
  MANAGER,
  NAME_TAG,
  seedDemoOrders,
  seedL11,
  STATION,
  STATION_NO_KEROSENE,
  SUPPLY,
  TAG,
  TRUCK_SMALL,
} from "./l11-seed";

const OUT = "docs/captures";
/** Camion demandé par deux chauffeurs dans la capture du conflit d'affectation. */
const PLATE = new RegExp(`^${TAG}402-AB`);

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
test.skip(!process.env.L11_CAPTURES, "captures régénérées sur demande (L11_CAPTURES=1)");

const shot = async (page: Page, name: string) => {
  // Les notifications ne doivent pas masquer le contenu.
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png`, animations: "disabled" });
};

/** Un onglet par rôle : la session est déposée avant le premier chargement (`e2e/auth.ts`). */
async function pageAs(browser: Browser, credentials: Credentials): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await openSession(page, credentials);
  return page;
}

test("captures des écrans Journée, Commandes du jour et Disponibilité du jour", async ({ browser }) => {
  test.setTimeout(300_000);
  const seed = await seedL11();
  const dispatcher = await Api.as(DISPATCHER);
  // Jour encore vierge (ou celui demandé par `L11_CAPTURE_DAY`) : les 20 commandes de `demo_douala`, plus deux
  // commandes qui illustrent le contrôle de volume F3.4 — un refus et un avertissement.
  const DAY = process.env.L11_CAPTURE_DAY ?? (await freshDay(dispatcher));
  await seedDemoOrders(seed, DAY);
  const extra = { day: DAY, priority: "normal", window_start: null, window_end: null };
  await dispatcher.call("POST", "/orders", {
    ...extra,
    station_id: seed.stations.get(STATION.code),
    product_id: seed.products.get("GASOIL"),
    requested_l: 42000,
    comment: "Groupe électrogène du marché",
  });
  await dispatcher.call("POST", "/orders", {
    ...extra,
    station_id: seed.stations.get(STATION_NO_KEROSENE.code),
    product_id: seed.products.get("PETROLE"),
    requested_l: 2500,
    comment: null,
  });

  /* ------------------------------------------------------------ Supply : stocks dépôt */
  let page = await pageAs(browser, SUPPLY);
  await page.goto(`/disponibilite?day=${DAY}`);
  const cells = page.getByTestId("stocks-grid").getByRole("textbox");
  await expect(cells.first()).toBeVisible();
  const volumes = ["64000", "9000", "71000", "180000", "24000", "150000"];
  const count = await cells.count();
  // Le dernier stock reste à saisir : il apparaît comme manquant sur l'écran Journée.
  for (let index = 0; index < count - 1; index += 1)
    await cells.nth(index).fill(volumes[index % volumes.length]);
  await page.getByRole("button", { name: /^Enregistrer/ }).click();
  await expect(page.getByText(`${count - 1} / ${count} renseignés`)).toBeVisible();
  await cells.first().fill("66500");
  await page.getByRole("button", { name: "Enregistrer (1)" }).click();
  await expect(page.getByText("1 stock enregistré", { exact: true })).toBeVisible();
  // Une saisie effacée puis reprise : l'historique en garde la trace.
  await cells.nth(1).fill("");
  await page.getByRole("button", { name: "Enregistrer (1)" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Effacer" }).click();
  await expect(page.getByText("1 saisie effacée", { exact: true })).toBeVisible();
  await cells.nth(1).fill("9500");
  await page.getByRole("button", { name: "Enregistrer (1)" }).click();
  await expect(page.getByText(`${count - 1} / ${count} renseignés`)).toBeVisible();
  await cells.nth(2).fill("70000");
  await cells.nth(2).blur();
  await shot(page, "l11-07-disponibilite-stocks");
  await page.getByRole("button", { name: "Annuler les modifications" }).click();
  await page.getByTestId("day-history").click();
  await expect(page.getByTestId("stock-history").getByText("Valeur courante").first()).toBeVisible();
  await shot(page, "l11-08-disponibilite-stocks-historique");
  await page.getByTestId("stock-history").getByRole("button", { name: "Fermer" }).first().click();

  /* ------------------------------------------------------- Dispatcher : commandes du jour */
  await page.context().close();
  page = await pageAs(browser, DISPATCHER);
  await page.goto(`/commandes?day=${DAY}`);
  const orders = page.getByRole("grid", { name: "Commandes du jour" });
  await expect(orders.getByRole("row")).toHaveCount(23);

  await page.getByRole("button", { name: "Nouvelle commande" }).click();
  const form = page.getByRole("dialog", { name: "Nouvelle commande" });
  await form.getByLabel(/^Station/).selectOption({ label: `${TAG}DLA03 — OLA Bonapriso` });
  await form.getByLabel(/^Produit/).selectOption({ label: "Gasoil" });
  await form.getByLabel(/^Volume demandé/).fill("8000");
  await form.getByLabel(/^Priorité/).selectOption({ label: "Urgente" });
  await form.getByLabel(/^Au plus tôt/).fill("0700");
  await form.getByLabel(/^Au plus tard/).fill("1030");
  await form.getByLabel(/^Commentaire/).fill("Rupture annoncée par le gérant");
  await form.getByLabel(/^Commentaire/).blur();
  await shot(page, "l11-05-commande-formulaire");
  await form.getByRole("button", { name: "Enregistrer" }).click();
  await expect(orders.getByRole("row")).toHaveCount(24);

  // Trois brouillons restent à confirmer ; le reste part en confirmation en masse.
  await page.getByRole("checkbox", { name: "Sélectionner toutes les lignes de la page" }).click();
  for (const index of [9, 14, 19]) await orders.getByRole("row").nth(index).getByRole("checkbox").click();
  await page.getByRole("button", { name: "Confirmer", exact: true }).click();
  const report = page.getByTestId("bulk-confirm-report");
  await expect(report).toContainText(/refusée/);
  await shot(page, "l11-06-commandes-confirmation-en-masse");
  await report.getByRole("button", { name: "Fermer" }).first().click();
  await orders
    .getByRole("row")
    .filter({ hasText: "Brouillon" })
    .nth(1)
    .getByRole("button", { name: /^Actions/ })
    .click();
  await page.getByRole("menuitem", { name: "Annuler la commande" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Annuler la commande" }).click();
  await expect(orders.getByText("Annulée")).toBeVisible();
  await page.keyboard.press("Escape");
  await orders
    .getByRole("gridcell", { name: /^7\s000\sL$/ })
    .first()
    .click();
  await shot(page, "l11-04-commandes");

  /* ------------------------------------------ Dispatcher : camions et chauffeurs du jour */
  await page.goto(`/disponibilite?day=${DAY}&tab=trucks`);
  const trucks = page.getByRole("grid", { name: "Camions du jour" });
  await trucks
    .getByRole("row")
    .filter({ hasText: TRUCK_SMALL })
    .getByRole("button", { name: /^Actions/ })
    .click();
  await page.getByRole("menuitem", { name: "Marquer indisponible…" }).click();
  const mark = page.getByRole("dialog", { name: "Marquer indisponible pour la journée" });
  await mark.getByLabel(/^Motif du jour/).fill("Visite technique annuelle");
  await mark.getByRole("button", { name: "Marquer indisponible" }).click();
  await expect(trucks.getByRole("row").filter({ hasText: TRUCK_SMALL })).toContainText("RM-04");
  // La base de développement porte aussi les données des autres lots : la capture montre le jeu L11.
  await page.getByRole("searchbox").fill(TAG);
  await shot(page, "l11-09-disponibilite-camions");

  await page.getByRole("tab", { name: "Chauffeurs" }).click();
  const drivers = page.getByRole("grid", { name: "Chauffeurs du jour" });
  await page.getByRole("searchbox").fill(NAME_TAG.trim());
  await expect(drivers.getByRole("row").filter({ hasText: DRIVER_FREE })).toBeVisible();
  const assign = async (driver: string, plate: RegExp) => {
    const cell = drivers.getByRole("row").filter({ hasText: driver }).getByRole("gridcell").nth(3);
    await cell.click();
    await page.keyboard.press("Enter");
    const select = cell.getByRole("combobox");
    const option = await select.getByRole("option", { name: plate }).first().getAttribute("value");
    await select.selectOption(option as string);
    await page.keyboard.press("Enter");
  };
  await assign(DRIVER_FREE, PLATE);
  await expect(drivers.getByRole("row").filter({ hasText: DRIVER_FREE })).toContainText("jour");
  await assign(DRIVER_OTHER, PLATE);
  await expect(page.getByRole("alertdialog", { name: "Camion déjà affecté" })).toBeVisible();
  await shot(page, "l11-11-disponibilite-chauffeurs-conflit");
  await page.getByRole("alertdialog").getByRole("button", { name: "Ne rien changer" }).click();
  await page.keyboard.press("Escape");
  await shot(page, "l11-10-disponibilite-chauffeurs");

  /* ------------------------------------------------------------ Dispatcher : journée */
  await page.goto(`/journee?day=${DAY}`);
  await expect(page.getByTestId("summary-orders")).toContainText("commandes");
  await shot(page, "l11-01-journee-preparation");
  await page.getByRole("button", { name: "Calculer le plan" }).click();
  const progress = page.getByTestId("compute-progress");
  await progress.waitFor({ timeout: 5_000 }).catch(() => undefined);
  if (await progress.isVisible())
    await page.screenshot({ path: `${OUT}/l11-02-journee-calcul-en-cours.png` });
  await expect(page.getByText("Calcul terminé")).toBeVisible({ timeout: 180_000 });
  await expect(
    page.getByRole("grid", { name: "Plans du jour" }).getByRole("row").filter({ hasText: "Plan calculé" }),
  ).toHaveCount(1);
  await shot(page, "l11-03-journee-plan-calcule");

  /* ------------------------------------------------------------ Direction : lecture seule */
  await page.context().close();
  page = await pageAs(browser, MANAGER);
  await page.goto(`/commandes?day=${DAY}`);
  await expect(page.getByText(/Lecture seule/)).toBeVisible();
  await expect(page.getByRole("grid", { name: "Commandes du jour" }).getByRole("row").nth(1)).toBeVisible();
  await shot(page, "l11-12-commandes-lecture-seule");
});
