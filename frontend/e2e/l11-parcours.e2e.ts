/**
 * Parcours L11 contre la VRAIE API (aucune doublure) :
 * saisir les stocks en `supply` → créer, modifier et confirmer des commandes en `dispatcher` → lancer le calcul
 * du plan et attendre sa fin (un worker Celery doit tourner : `uv run celery -A app.worker.celery_app worker`).
 *
 * Chaque exécution travaille sur un jour J tiré au hasard : le parcours est relançable sur une base déjà utilisée.
 */
import { expect, test, type Page } from "@playwright/test";

import { DISPATCHER, ensureAccounts, ensureTemplates, MANAGER, openAs, SUPPLY } from "./l11-seed";

/** Jour ouvré de 2027 antérieur aux expirations des fichiers modèles (habilitations au 31/12/2027). */
function randomDay(): string {
  for (;;) {
    const date = new Date(Date.UTC(2027, 1, 1 + Math.floor(Math.random() * 300)));
    if (date.getUTCDay() !== 0) return date.toISOString().slice(0, 10);
  }
}
const DAY = randomDay();

async function createOrder(
  page: Page,
  order: { product: string; volume: string; priority?: string; windowStart?: string },
) {
  await page.getByRole("button", { name: "Nouvelle commande" }).click();
  const dialog = page.getByRole("dialog", { name: "Nouvelle commande" });
  await dialog.getByLabel(/^Station/).selectOption({ index: 1 });
  await dialog.getByLabel(/^Produit/).selectOption({ label: order.product });
  await dialog.getByLabel(/^Volume demandé/).fill(order.volume);
  if (order.priority) await dialog.getByLabel(/^Priorité/).selectOption({ label: order.priority });
  if (order.windowStart) await dialog.getByLabel(/^Au plus tôt/).fill(order.windowStart);
  await dialog.getByRole("button", { name: "Enregistrer" }).click();
  await expect(dialog).toBeHidden();
}

test.beforeAll(async ({ request }) => {
  const admin = await ensureAccounts(request);
  await ensureTemplates(request, admin);
});

test("stocks (supply) → commandes (dispatcher) → calcul du plan", async ({ page, request }) => {
  test.setTimeout(240_000);

  /* ------------------------------------------------------------ Supply : stocks du jour */
  await openAs(page, request, SUPPLY, `/disponibilite?day=${DAY}`);
  const grid = page.getByTestId("stocks-grid");
  const cells = grid.getByRole("textbox");
  await expect(cells.first()).toBeVisible();
  const count = await cells.count();
  expect(count).toBeGreaterThan(0);
  await expect(page.getByText(`0 / ${count} renseignés`)).toBeVisible();
  for (let index = 0; index < count; index += 1) await cells.nth(index).fill("90000");
  await expect(page.getByText(`${count} modifications non enregistrées`)).toBeVisible();
  // Entrée dans une cellule enregistre toute la grille.
  await cells.first().press("Enter");
  await expect(page.getByText("Tous les stocks sont renseignés")).toBeVisible();
  await expect(grid.getByText("Brice Supply").first()).toBeVisible();

  // Une correction remplace la valeur et s'ajoute à l'historique.
  await cells.first().fill("85000");
  await page.getByRole("button", { name: "Enregistrer (1)" }).click();
  await expect(page.getByText("1 stock enregistré", { exact: true })).toBeVisible();
  await page.getByTestId("day-history").click();
  const history = page.getByTestId("stock-history");
  await expect(history.getByRole("row")).toHaveCount(count + 2);
  await expect(history.getByText("Valeur courante")).toHaveCount(count);
  await history.getByRole("button", { name: "Fermer" }).first().click();

  // Camions et chauffeurs : lecture seule pour l'agent Supply.
  await page.getByRole("tab", { name: "Camions" }).click();
  await expect(page.getByText(/Lecture seule/)).toBeVisible();
  await expect(page.getByRole("grid", { name: "Camions du jour" })).toBeVisible();

  /* ------------------------------------------------------- Dispatcher : commandes du jour */
  await openAs(page, request, DISPATCHER, `/commandes?day=${DAY}`);
  const orders = page.getByRole("grid", { name: "Commandes du jour" });
  await createOrder(page, { product: "Gasoil", volume: "8000", windowStart: "730" });
  await createOrder(page, { product: "Super", volume: "6000", priority: "Urgente" });
  await createOrder(page, { product: "Gasoil", volume: "990000" });
  await expect(orders.getByRole("row")).toHaveCount(4);
  await expect(orders.getByRole("gridcell", { name: "07:30" })).toBeVisible();

  // Modification au clavier dans le tableau : saisie directe sur la cellule, Entrée pour valider.
  await orders.getByRole("gridcell", { name: /^8\s000\sL$/ }).click();
  await page.keyboard.type("9000");
  await page.keyboard.press("Enter");
  await expect(orders.getByRole("gridcell", { name: /^9\s000\sL$/ })).toBeVisible();

  // Confirmation en masse : résultat commande par commande, le volume hors cuve est refusé et expliqué.
  await page.getByRole("checkbox", { name: "Sélectionner toutes les lignes de la page" }).click();
  await page.getByRole("button", { name: "Confirmer", exact: true }).click();
  const report = page.getByTestId("bulk-confirm-report");
  await expect(report).toContainText("2 commandes confirmées, 1 refusée.");
  await expect(report.getByText(/supérieur au volume recevable par la cuve/)).toBeVisible();
  await report.getByRole("button", { name: "Fermer" }).first().click();
  await expect(orders.getByText("Confirmée")).toHaveCount(2);

  // Confirmation à l'unité de la commande refusée : bandeau d'explication, puis suppression du brouillon.
  await orders
    .getByRole("row")
    .filter({ hasText: "Brouillon" })
    .getByRole("button", { name: /^Actions/ })
    .click();
  await page.getByRole("menuitem", { name: "Confirmer" }).click();
  await expect(page.getByText(/Confirmation refusée/)).toBeVisible();
  await expect(page.getByText(/Volume maximal recevable/)).toBeVisible();
  await orders
    .getByRole("row")
    .filter({ hasText: "Brouillon" })
    .getByRole("button", { name: /^Actions/ })
    .click();
  await page.getByRole("menuitem", { name: "Supprimer" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Supprimer" }).click();
  await expect(orders.getByRole("row")).toHaveCount(3);
  await expect(page.getByTestId("total-status-confirmed")).toContainText(/15\s000\sL/);
  await expect(page.getByTestId("total-all")).toContainText("2 commandes");

  /* -------------------------------------------- Dispatcher : camions du jour (marquage) */
  await page.goto(`/disponibilite?day=${DAY}&tab=trucks`);
  const trucks = page.getByRole("grid", { name: "Camions du jour" });
  const firstTruck = trucks.getByRole("row").filter({ hasText: "Affectable" }).first();
  const plate = (await firstTruck.getByRole("gridcell").nth(1).innerText()).trim();
  await firstTruck.getByRole("button", { name: /^Actions/ }).click();
  await page.getByRole("menuitem", { name: "Marquer indisponible…" }).click();
  const mark = page.getByRole("dialog", { name: "Marquer indisponible pour la journée" });
  await mark.getByLabel(/^Motif du jour/).fill("Contrôle technique");
  await mark.getByRole("button", { name: "Marquer indisponible" }).click();
  const marked = trucks.getByRole("row").filter({ hasText: plate });
  await expect(marked).toContainText("RM-04");
  await expect(marked).toContainText("Contrôle technique");
  await marked.getByRole("button", { name: /^Actions/ }).click();
  await page.getByRole("menuitem", { name: "Rendre disponible" }).click();
  await expect(marked).toContainText("Affectable");

  /* ------------------------------------------------------- Dispatcher : calcul du plan */
  await page.goto(`/journee?day=${DAY}`);
  await expect(page.getByTestId("summary-orders")).toContainText("2 commandes");
  await expect(page.getByTestId("summary-stocks")).toContainText(`${count} / ${count} renseignés`);
  await page.getByRole("button", { name: "Calculer le plan" }).click();
  await expect(
    page.getByTestId("compute-progress").or(page.getByText("Calcul terminé")).first(),
  ).toBeVisible();
  // Le suivi survit à un rafraîchissement de la page ; à la fin, le plan produit est listé et accessible.
  await page.reload();
  const plans = page.getByRole("grid", { name: "Plans du jour" });
  await expect(plans.getByRole("row").filter({ hasText: "Plan calculé" })).toHaveCount(1, {
    timeout: 180_000,
  });
  await expect(page.getByTestId("compute-progress")).toHaveCount(0);
  const last = page.getByTestId("last-compute");
  await expect(last).toContainText("Awa Dispatcher");
  await expect(last).toContainText(/Distances (approchées|routières)/);
  await expect(plans.getByRole("link", { name: /^Ouvrir le plan/ })).toHaveAttribute(
    "href",
    new RegExp(`/plan\\?plan=[0-9a-f-]+&day=${DAY}`),
  );
  await expect(page.getByTestId("summary-orders")).toContainText("2 commandes");

  /* ------------------------------------------------------------ Direction : lecture seule */
  await openAs(page, request, MANAGER, `/journee?day=${DAY}`);
  await expect(page.getByText(/Lecture seule/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Calculer le plan|Recalculer/ })).toHaveCount(0);
  await expect(plans.getByRole("row").filter({ hasText: "Plan calculé" })).toHaveCount(1);
  await page.goto(`/commandes?day=${DAY}`);
  await expect(orders.getByRole("row")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Nouvelle commande" })).toHaveCount(0);
});
