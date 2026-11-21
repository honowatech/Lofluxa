/**
 * Captures d'écran des écrans L11 (Journée, Commandes du jour, Disponibilité du jour) → `docs/captures/l11-*.png`.
 * Contre la VRAIE API, avec le jeu fictif `demo_douala` chargé par l'API : aucune doublure.
 *
 *   L11_CAPTURES=1 pnpm exec playwright test --project=e2e --trace off l11-captures
 *
 * Ignoré par `pnpm e2e` sans cette variable : les captures ne sont régénérées que sur demande. Le scénario
 * modifie le jour choisi (`L11_CAPTURE_DAY`, défaut 2027-01-14) : le relancer demande un jour encore vierge.
 */
import { expect, test, type Page } from "@playwright/test";

import {
  API,
  DISPATCHER,
  ensureAccounts,
  ensureDemo,
  ensureTemplates,
  login,
  MANAGER,
  openAs,
  SUPPLY,
} from "./l11-seed";

const DAY = process.env.L11_CAPTURE_DAY ?? "2027-01-14";
const OUT = "docs/captures";

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
test.skip(!process.env.L11_CAPTURES, "captures régénérées sur demande (L11_CAPTURES=1)");

const shot = async (page: Page, name: string) => {
  // Les notifications ne doivent pas masquer le contenu.
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png`, animations: "disabled" });
};

test("captures des écrans Journée, Commandes du jour et Disponibilité du jour", async ({ page, request }) => {
  test.setTimeout(300_000);
  const admin = await ensureAccounts(request);
  await ensureTemplates(request, admin);
  await ensureDemo(request, admin, DAY);

  // Deux commandes de plus pour illustrer le contrôle de volume F3.4 : un refus et un avertissement.
  const headers = { Authorization: `Bearer ${(await login(request, DISPATCHER)) as string}` };
  const list = async (resource: string) =>
    (
      (await (await request.get(`${API}${resource}`, { headers, params: { limit: 500 } })).json()) as {
        items: { id: string; code: string; tanks?: { product_id: string }[] }[];
      }
    ).items;
  const products = await list("/products");
  const stations = await list("/stations");
  const product = (code: string) => products.find((p) => p.code === code)?.id as string;
  const akwa = stations.find((s) => s.code === "DLA01") as (typeof stations)[number];
  const noKerosene = stations.find(
    (s) => s.code.startsWith("DLA") && !s.tanks?.some((tank) => tank.product_id === product("PETROLE")),
  ) as (typeof stations)[number];
  const base = { day: DAY, priority: "normal", window_start: null, window_end: null };
  await request.post(`${API}/orders`, {
    headers,
    data: {
      ...base,
      station_id: akwa.id,
      product_id: product("GASOIL"),
      requested_l: 42000,
      comment: "Groupe électrogène du marché",
    },
  });
  await request.post(`${API}/orders`, {
    headers,
    data: {
      ...base,
      station_id: noKerosene.id,
      product_id: product("PETROLE"),
      requested_l: 2500,
      comment: null,
    },
  });

  /* ------------------------------------------------------------ Supply : stocks dépôt */
  await openAs(page, request, SUPPLY, `/disponibilite?day=${DAY}`);
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
  await cells.nth(2).fill("70000");
  await cells.nth(2).blur();
  await shot(page, "l11-07-disponibilite-stocks");
  await page.getByRole("button", { name: "Annuler les modifications" }).click();
  await page.getByTestId("day-history").click();
  await expect(page.getByTestId("stock-history").getByText("Valeur courante").first()).toBeVisible();
  await shot(page, "l11-08-disponibilite-stocks-historique");
  await page.getByTestId("stock-history").getByRole("button", { name: "Fermer" }).first().click();

  /* ------------------------------------------------------- Dispatcher : commandes du jour */
  await openAs(page, request, DISPATCHER, `/commandes?day=${DAY}`);
  const orders = page.getByRole("grid", { name: "Commandes du jour" });
  await expect(orders.getByRole("row")).toHaveCount(23);

  await page.getByRole("button", { name: "Nouvelle commande" }).click();
  const form = page.getByRole("dialog", { name: "Nouvelle commande" });
  await form.getByLabel(/^Station/).selectOption({ label: "DLA03 — OLA Bonapriso" });
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
    .filter({ hasText: "LT-403-AC" })
    .getByRole("button", { name: /^Actions/ })
    .click();
  await page.getByRole("menuitem", { name: "Marquer indisponible…" }).click();
  const mark = page.getByRole("dialog", { name: "Marquer indisponible pour la journée" });
  await mark.getByLabel(/^Motif du jour/).fill("Visite technique annuelle");
  await mark.getByRole("button", { name: "Marquer indisponible" }).click();
  await expect(trucks.getByRole("row").filter({ hasText: "LT-403-AC" })).toContainText("RM-04");
  await shot(page, "l11-09-disponibilite-camions");

  await page.getByRole("tab", { name: "Chauffeurs" }).click();
  const drivers = page.getByRole("grid", { name: "Chauffeurs du jour" });
  const assign = async (driver: string, plate: RegExp) => {
    const cell = drivers.getByRole("row").filter({ hasText: driver }).getByRole("gridcell").nth(3);
    await cell.click();
    await page.keyboard.press("Enter");
    const select = cell.getByRole("combobox");
    const option = await select.getByRole("option", { name: plate }).first().getAttribute("value");
    await select.selectOption(option as string);
    await page.keyboard.press("Enter");
  };
  await assign("Yves Mbarga", /^LT 123 AB/);
  await expect(drivers.getByRole("row").filter({ hasText: "Yves Mbarga" })).toContainText("jour");
  await assign("Paul Tchoupo", /^LT 123 AB/);
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
  await openAs(page, request, MANAGER, `/commandes?day=${DAY}`);
  await expect(page.getByText(/Lecture seule/)).toBeVisible();
  await expect(orders.getByRole("row").nth(1)).toBeVisible();
  await shot(page, "l11-12-commandes-lecture-seule");
});
