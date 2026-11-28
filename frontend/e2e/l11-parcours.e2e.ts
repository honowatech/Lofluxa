/**
 * Parcours L11 contre la VRAIE API (aucune doublure) :
 * saisir les stocks en `supply` → créer, modifier et confirmer des commandes en `dispatcher` → lancer le calcul
 * du plan et attendre sa fin → lecture seule en `manager`.
 *
 * Données : `l11-seed.ts` (tout est préfixé `L11`, créé par l'API, rejouable sur une base remplie par les autres
 * lots). Chaque exécution travaille sur un jour J encore vierge.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";

import { openSession, type Credentials } from "./auth";
import { Api, DISPATCHER, freshDay, MANAGER, NAMES, seedL11, STATION, SUPPLY, TRUCK } from "./l11-seed";

let DAY = "";

test.beforeAll(async () => {
  await seedL11();
  DAY = await freshDay(await Api.as(DISPATCHER));
});

/** Un onglet par rôle : la session est déposée avant le premier chargement (`e2e/auth.ts`). */
async function pageAs(browser: Browser, credentials: Credentials): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await openSession(page, credentials);
  return page;
}

async function createOrder(
  page: Page,
  order: { product: string; volume: string; priority?: string; windowStart?: string },
) {
  await page.getByRole("button", { name: "Nouvelle commande" }).click();
  const dialog = page.getByRole("dialog", { name: "Nouvelle commande" });
  // La station est choisie par son code, jamais par son rang dans la liste.
  await dialog.getByLabel(/^Station/).selectOption({ label: `${STATION.code} — ${STATION.name}` });
  await dialog.getByLabel(/^Produit/).selectOption({ label: order.product });
  await dialog.getByLabel(/^Volume demandé/).fill(order.volume);
  if (order.priority) await dialog.getByLabel(/^Priorité/).selectOption({ label: order.priority });
  if (order.windowStart) await dialog.getByLabel(/^Au plus tôt/).fill(order.windowStart);
  await dialog.getByRole("button", { name: "Enregistrer" }).click();
  await expect(dialog).toBeHidden();
}

test("stocks (supply) → commandes (dispatcher) → calcul du plan", async ({ browser }) => {
  test.setTimeout(300_000);
  let count = 0;

  await test.step("Supply : stocks du jour", async () => {
    const page = await pageAs(browser, SUPPLY);
    await page.goto(`/disponibilite?day=${DAY}`);
    const grid = page.getByTestId("stocks-grid");
    const cells = grid.getByRole("textbox");
    await expect(cells.first()).toBeVisible();
    count = await cells.count();
    expect(count).toBeGreaterThan(0);
    await expect(page.getByText(`0 / ${count} renseignés`)).toBeVisible();
    for (let index = 0; index < count; index += 1) await cells.nth(index).fill("90000");
    await expect(page.getByText(`${count} modifications non enregistrées`)).toBeVisible();
    // Entrée dans une cellule enregistre toute la grille.
    await cells.first().press("Enter");
    await expect(page.getByText("Tous les stocks sont renseignés")).toBeVisible();
    await expect(grid.getByText(NAMES.supply).first()).toBeVisible();

    // Une correction remplace la valeur et s'ajoute à l'historique.
    await cells.first().fill("85000");
    await page.getByRole("button", { name: "Enregistrer (1)" }).click();
    await expect(page.getByText("1 stock enregistré", { exact: true })).toBeVisible();
    await page.getByTestId("day-history").click();
    const history = page.getByTestId("stock-history");
    await expect(history.getByRole("row")).toHaveCount(count + 2);
    await expect(history.getByText("Valeur courante")).toHaveCount(count);
    await history.getByRole("button", { name: "Fermer" }).first().click();

    // Effacer une saisie : confirmation obligatoire, le stock redevient « non renseigné » ; puis ressaisie.
    await cells.last().fill("");
    await page.getByRole("button", { name: "Enregistrer (1)" }).click();
    await page
      .getByRole("alertdialog", { name: "Effacer la saisie ?" })
      .getByRole("button", { name: "Effacer" })
      .click();
    await expect(page.getByText(`${count - 1} / ${count} renseignés`)).toBeVisible();
    await expect(grid.getByText(/Non renseigné — effacé à/)).toBeVisible();
    await cells.last().fill("90000");
    await cells.last().press("Enter");
    await expect(page.getByText("Tous les stocks sont renseignés")).toBeVisible();

    // Camions et chauffeurs : lecture seule pour l'agent Supply.
    await page.getByRole("tab", { name: "Camions" }).click();
    await expect(page.getByText(/Lecture seule/)).toBeVisible();
    await expect(page.getByRole("grid", { name: "Camions du jour" })).toBeVisible();
    await page.context().close();
  });

  const page = await pageAs(browser, DISPATCHER);
  const orders = page.getByRole("grid", { name: "Commandes du jour" });

  await test.step("Dispatcher : commandes du jour", async () => {
    await page.goto(`/commandes?day=${DAY}`);
    await createOrder(page, { product: "Gasoil", volume: "8000", windowStart: "730" });
    await createOrder(page, { product: "Super", volume: "6000", priority: "Urgente" });
    await createOrder(page, { product: "Gasoil", volume: "990000" });
    await expect(orders.getByRole("row")).toHaveCount(4);
    await expect(orders.getByRole("gridcell", { name: "07:30" })).toBeVisible();

    // Le volume hors cuve est signalé sur la ligne dès le brouillon, avant toute confirmation.
    await expect(orders.getByTestId("order-warning")).toHaveAttribute("data-code", "exceeds_tank_capacity");
    await expect(page.getByText(/1 commande dépasse le volume recevable/)).toBeVisible();

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
    const draft = orders.getByRole("row").filter({ hasText: "Brouillon" });
    await draft.getByRole("button", { name: /^Actions/ }).click();
    await page.getByRole("menuitem", { name: "Confirmer" }).click();
    await expect(page.getByText(/Confirmation refusée/)).toBeVisible();
    await expect(page.getByText(/Volume maximal recevable/)).toBeVisible();
    await draft.getByRole("button", { name: /^Actions/ }).click();
    await page.getByRole("menuitem", { name: "Supprimer" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Supprimer" }).click();
    await expect(orders.getByRole("row")).toHaveCount(3);
    await expect(page.getByTestId("total-status-confirmed")).toContainText(/15\s000\sL/);
    await expect(page.getByTestId("total-all")).toContainText("2 commandes");
  });

  await test.step("Dispatcher : l'import des commandes impose le jour J", async () => {
    const csv = (day: string) =>
      Buffer.from(
        "Date;Code station;Produit;Volume (L);Priorité;Fenêtre début;Fenêtre fin;Commentaire\n" +
          `${day};${STATION.code};PETROLE;5000;normale;;;Import L11\n`,
      );
    const preview = async (name: string, day: string) => {
      await page.getByRole("button", { name: "Importer" }).click();
      const dialog = page.getByRole("dialog", { name: "Importer — commandes" });
      await dialog
        .getByLabel("Choisir un fichier")
        .setInputFiles({ name, mimeType: "text/csv", buffer: csv(day) });
      await dialog.getByRole("button", { name: "Prévisualiser" }).click();
      return dialog;
    };
    // Une ligne datée d'un autre jour est refusée : le jour J de l'écran est transmis à l'API.
    let dialog = await preview("l11-autre-jour.csv", "2029-12-31");
    await expect(dialog.getByText(/La date ne correspond pas à la journée importée/).first()).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Import bloqué/ })).toBeDisabled();
    await dialog.getByRole("button", { name: "Annuler" }).click();
    // La même ligne datée du jour J est acceptée (rien n'est appliqué ici).
    dialog = await preview("l11-jour-j.csv", DAY);
    await expect(dialog.getByTestId("import-summary")).toContainText("0 en erreur");
    await dialog.getByRole("button", { name: "Annuler" }).click();
    await expect(orders.getByRole("row")).toHaveCount(3);
  });

  await test.step("Dispatcher : camion marqué indisponible puis rendu disponible", async () => {
    await page.goto(`/disponibilite?day=${DAY}&tab=trucks`);
    const truck = page
      .getByRole("grid", { name: "Camions du jour" })
      .getByRole("row")
      .filter({ hasText: TRUCK });
    await expect(truck).toContainText("Affectable");
    await truck.getByRole("button", { name: /^Actions/ }).click();
    await page.getByRole("menuitem", { name: "Marquer indisponible…" }).click();
    const mark = page.getByRole("dialog", { name: "Marquer indisponible pour la journée" });
    await mark.getByLabel(/^Motif du jour/).fill("Contrôle technique");
    await mark.getByRole("button", { name: "Marquer indisponible" }).click();
    await expect(truck).toContainText("RM-04");
    await expect(truck).toContainText("Contrôle technique");
    await truck.getByRole("button", { name: /^Actions/ }).click();
    await page.getByRole("menuitem", { name: "Rendre disponible" }).click();
    await expect(truck).toContainText("Affectable");
  });

  const plans = page.getByRole("grid", { name: "Plans du jour" });
  await test.step("Dispatcher : calcul du plan", async () => {
    await page.goto(`/journee?day=${DAY}`);
    await expect(page.getByTestId("summary-orders")).toContainText("2 commandes");
    await expect(page.getByTestId("summary-stocks")).toContainText(`${count} / ${count} renseignés`);
    await page.getByRole("button", { name: "Calculer le plan" }).click();
    await expect(
      page.getByTestId("compute-progress").or(page.getByText("Calcul terminé")).first(),
    ).toBeVisible();
    // Le suivi survit à un rafraîchissement de la page ; à la fin, le plan produit est listé et accessible.
    await page.reload();
    await expect(plans.getByRole("row").filter({ hasText: "Plan calculé" })).toHaveCount(1, {
      timeout: 200_000,
    });
    await expect(page.getByTestId("compute-progress")).toHaveCount(0);
    const last = page.getByTestId("last-compute");
    await expect(last).toContainText(NAMES.dispatcher);
    await expect(last).toContainText(/Distances (approchées|routières)/);
    await expect(plans.getByRole("link", { name: /^Ouvrir le plan/ })).toHaveAttribute(
      "href",
      new RegExp(`/plan\\?plan=[0-9a-f-]+&day=${DAY}`),
    );
    await page.context().close();
  });

  await test.step("Direction : lecture seule", async () => {
    const reader = await pageAs(browser, MANAGER);
    await reader.goto(`/journee?day=${DAY}`);
    await expect(reader.getByText(/Lecture seule/)).toBeVisible();
    await expect(reader.getByRole("button", { name: /Calculer le plan|Recalculer/ })).toHaveCount(0);
    await expect(
      reader
        .getByRole("grid", { name: "Plans du jour" })
        .getByRole("row")
        .filter({ hasText: "Plan calculé" }),
    ).toHaveCount(1);
    await reader.goto(`/commandes?day=${DAY}`);
    await expect(reader.getByRole("grid", { name: "Commandes du jour" }).getByRole("row")).toHaveCount(3);
    await expect(reader.getByRole("button", { name: "Nouvelle commande" })).toHaveCount(0);
    await reader.context().close();
  });
});
