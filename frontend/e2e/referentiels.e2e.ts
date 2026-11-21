/**
 * Bout en bout contre la VRAIE API (aucune doublure) — écrans Référentiels et Administration :
 *  1. créer un dépôt et une station (avec une cuve) → les voir dans le tableau et sur la carte ;
 *  2. importer le fichier modèle `data/templates/stations.xlsx` : prévisualiser → appliquer ;
 *  3. modifier un paramètre → le retrouver dans le journal d'audit, puis le rétablir.
 * Les données créées sont supprimées à la fin (par l'API) : le test est rejouable.
 */
import path from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { ADMIN, API, apiLogin, PATIENT_TIMEOUT, type Tokens } from "./l9-auth";

test.setTimeout(PATIENT_TIMEOUT);

// Les tests sont lancés depuis `frontend/` (pnpm e2e).
const TEMPLATE = path.resolve(process.cwd(), "../data/templates/stations.xlsx");
const suffix = Date.now().toString(36).toUpperCase().slice(-5);
const DEPOT = { code: `E2E-D-${suffix}`, name: `Dépôt de test ${suffix}` };
const STATION = { code: `E2E-S-${suffix}`, name: `Station de test ${suffix}` };

/**
 * Une seule connexion pour tout le fichier : le serveur limite les connexions à 10 par minute et par adresse.
 * Les pages reçoivent ces jetons dans leur stockage local, comme après une connexion à l'écran.
 */
let session: Tokens | null = null;
async function getSession(request: APIRequestContext) {
  session ??= await apiLogin(request);
  return session;
}

/** Supprime par l'API les lignes dont le code est dans la liste (nettoyage). */
async function removeByCode(request: APIRequestContext, resource: "stations" | "depots", codes: string[]) {
  const headers = { Authorization: `Bearer ${(await getSession(request)).access_token}` };
  const page = await (await request.get(`${API}/${resource}?limit=500`, { headers })).json();
  for (const row of page.items as { id: string; code: string }[]) {
    if (codes.includes(row.code)) await request.delete(`${API}/${resource}/${row.id}`, { headers });
  }
}

async function login(page: Page) {
  const tokens = await getSession(page.request);
  await page.addInitScript(
    (value) => window.localStorage.setItem("tourneo.tokens", value),
    JSON.stringify(tokens),
  );
  await page.goto("/journee");
  await expect(page.getByTestId("user-menu")).toBeVisible();
  await expect(page.getByTestId("mocks-badge")).toHaveCount(0);
}

test.describe.configure({ mode: "serial" });
const importedCodes: string[] = [];

test.afterAll(async ({ request }) => {
  await removeByCode(request, "stations", [STATION.code, ...importedCodes]);
  await removeByCode(request, "depots", [DEPOT.code]);
});

test("créer un dépôt et une station, les voir dans le tableau et sur la carte", async ({ page }) => {
  await login(page);

  // Dépôt.
  await page.goto("/referentiels?tab=depots");
  await page.getByRole("button", { name: "Nouveau dépôt" }).click();
  let dialog = page.getByRole("dialog", { name: "Nouveau dépôt" });
  await dialog.getByLabel(/^Code/).fill(DEPOT.code);
  await dialog.getByLabel(/^Nom/).fill(DEPOT.name);
  await dialog.getByLabel(/^Latitude/).fill("4,0551");
  await dialog.getByLabel(/^Longitude/).fill("9,7083");
  await dialog.getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByText(`« ${DEPOT.name} » créé`)).toBeVisible();
  const depots = page.getByRole("grid", { name: "Dépôts" });
  await expect(depots.getByRole("gridcell", { name: DEPOT.code, exact: true })).toBeVisible();
  await expect(
    page.getByRole("figure", { name: "Dépôts" }).locator(".tn-marker--depot").first(),
  ).toBeVisible();

  // Le code est unique : le refus du serveur (409 `duplicate`) s'affiche sous le champ, rien n'est créé.
  await page.getByRole("button", { name: "Nouveau dépôt" }).click();
  dialog = page.getByRole("dialog", { name: "Nouveau dépôt" });
  await dialog.getByLabel(/^Code/).fill(DEPOT.code);
  await dialog.getByLabel(/^Nom/).fill("Doublon");
  await dialog.getByLabel(/^Latitude/).fill("4");
  await dialog.getByLabel(/^Longitude/).fill("9");
  await dialog.getByRole("button", { name: "Enregistrer" }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "déjà" }).first()).toBeVisible();
  await expect(dialog.getByLabel(/^Code/)).toHaveAttribute("aria-invalid", "true");
  await dialog.getByRole("button", { name: "Annuler" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Abandonner" }).click();

  // Station avec une cuve, envoyée en une seule requête.
  await page.goto("/referentiels?tab=stations");
  await page.getByRole("button", { name: "Nouvelle station" }).click();
  dialog = page.getByRole("dialog", { name: "Nouvelle station" });
  await dialog.getByLabel(/^Code/).fill(STATION.code);
  await dialog.getByLabel(/^Nom/).first().fill(STATION.name);
  await dialog.getByLabel(/^Ville/).fill("Douala");
  await dialog.getByLabel(/^Latitude/).fill("4,0502");
  await dialog.getByLabel(/^Longitude/).fill("9,6958");
  await dialog.getByRole("button", { name: "Ajouter une cuve" }).click();
  const tank = dialog.getByRole("group", { name: "Cuves 1" });
  await tank.getByLabel("Capacité").fill("30000");
  await tank.getByLabel("Stock de sécurité").fill("3000");
  const created = page.waitForResponse(
    (r) => r.url().endsWith("/api/v1/stations") && r.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Enregistrer" }).click();
  const body = await (await created).json();
  expect(body.tanks).toHaveLength(1);
  expect(body.tanks[0]).toMatchObject({ capacity_l: 30000, safety_stock_l: 3000 });

  const stations = page.getByRole("grid", { name: "Stations" });
  const row = stations.getByRole("row").filter({ hasText: STATION.code });
  await expect(row).toContainText(STATION.name);
  await expect(row).toContainText("30 000 L");
  // Carte : le marqueur de la station créée existe, et le survol de la ligne le met en évidence.
  const marker = page.locator(`[data-marker-id="${body.id}"]`);
  await expect(marker).toBeVisible();
  await row.hover();
  await expect(marker).toHaveClass(/tn-marker--selected/);

  // Recherche et tri locaux (l'API n'a pas de tri).
  await page.getByRole("searchbox").fill(STATION.code);
  await expect(stations.getByRole("row")).toHaveCount(2);
});

test("importer le fichier modèle des stations : prévisualiser puis appliquer", async ({ page }) => {
  await login(page);
  await page.goto("/referentiels?tab=stations");
  await page.getByRole("button", { name: "Importer" }).click();
  const dialog = page.getByRole("dialog", { name: "Importer — stations" });

  // Le fichier modèle se télécharge depuis la boîte.
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Télécharger le fichier modèle" }).click();
  expect((await download).suggestedFilename()).toBe("stations.xlsx");

  await dialog.getByLabel("Choisir un fichier").setInputFiles(TEMPLATE);
  const preview = page.waitForResponse((r) => r.url().includes("/imports/stations/preview"));
  await dialog.getByRole("button", { name: "Prévisualiser" }).click();
  const batch = await (await preview).json();
  expect(batch.can_apply).toBe(true);
  importedCodes.push(...(batch.report.items as { key: string }[]).map((item) => item.key));

  // Première exécution : créations. Exécutions suivantes : les stations supprimées par le nettoyage sont
  // annoncées comme « réactivées » (mise à jour) — le rapport affiché suit celui du serveur dans les deux cas.
  const { created, updated } = batch.report.summary as { created: number; updated: number };
  expect(created + updated).toBeGreaterThan(0);
  await expect(dialog.getByTestId("import-summary")).toContainText("0 en erreur");
  await expect(dialog.getByTestId("import-effects")).toContainText(`${created} création`);
  await expect(dialog.getByTestId("import-effects")).toContainText(`${updated} mise`);
  const firstItem = batch.report.items[0] as { label: string; action: string };
  await expect(dialog.getByRole("row").filter({ hasText: firstItem.label })).toContainText(
    firstItem.action === "create" ? "Création" : "Mise à jour",
  );

  await dialog.getByRole("button", { name: /^Appliquer \d+ lignes?$/ }).click();
  await expect(page.getByText(/Import appliqué/)).toBeVisible();
  await expect(dialog).toBeHidden();
  const stations = page.getByRole("grid", { name: "Stations" });
  for (const code of importedCodes)
    await expect(stations.getByRole("gridcell", { name: code, exact: true })).toBeVisible();

  // Rejouer le même fichier : plus rien à créer.
  await page.getByRole("button", { name: "Importer" }).click();
  await dialog.getByLabel("Choisir un fichier").setInputFiles(TEMPLATE);
  await dialog.getByRole("button", { name: "Prévisualiser" }).click();
  await expect(dialog.getByTestId("import-effects")).toContainText("0 création, 0 mise à jour");
  await expect(dialog.getByText(/rien à appliquer/)).toBeVisible();
});

test("administration : paramètre modifié, tracé dans l'audit, puis rétabli", async ({ page }) => {
  await login(page);
  await page.goto("/administration?tab=settings");
  const field = page.getByLabel(/Dépassement de fenêtre toléré/);
  await expect(field).toBeVisible();
  await expect(page.locator("[data-setting]")).not.toHaveCount(0);
  const original = await field.inputValue();
  const next = original === "25" ? "26" : "25";

  await field.fill(next);
  await page.getByRole("button", { name: "Enregistrer 1 modification" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByText("1 paramètre enregistré")).toBeVisible();

  // Valeur hors bornes : refusée avant l'envoi, d'après les bornes annoncées par le serveur.
  await field.fill("99999");
  await expect(page.getByRole("button", { name: /Enregistrer 1 modification/ })).toBeDisabled();
  await page.getByRole("button", { name: "Annuler les modifications" }).click();

  await page.goto("/administration?tab=audit");
  await page.getByLabel("Table", { exact: true }).selectOption("settings");
  await page.getByLabel("Identifiant de ligne").fill("window_tolerance_min");
  const first = page.getByRole("grid", { name: "Journal d'audit" }).getByRole("row").nth(1);
  await expect(first).toContainText("Administrateur Honowa");
  await first.getByRole("gridcell").first().click();
  await expect(page.getByTestId("audit-diff")).toContainText(next);

  // Utilisateurs : la liste réelle s'affiche, le compte courant est repéré.
  await page.goto("/administration?tab=users");
  await expect(
    page.getByRole("grid", { name: "Utilisateurs" }).getByRole("row").filter({ hasText: ADMIN.email }),
  ).toContainText("vous");

  await page.goto("/administration?tab=settings");
  await page.getByLabel(/Dépassement de fenêtre toléré/).fill(original);
  await page.getByRole("button", { name: "Enregistrer 1 modification" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByText("1 paramètre enregistré")).toBeVisible();
});
