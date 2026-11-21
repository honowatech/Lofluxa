/**
 * Lot L13, écran 6 — bout en bout contre la VRAIE API (aucune doublure, routes du lot L10) :
 *   1. `dispatcher` : panne de camion traitée par l'assistant sur une tournée en cours du plan publié
 *      (RM-19) → nouvelle version publiée, événement au journal, tournée de remplacement dans l'écran
 *      Chargement ;
 *   2. pénurie produit déclarée par l'écran en `admin` (le rôle `supply`, seul autre rôle autorisé par
 *      l'API, ne voit pas encore l'écran Journal dans `lib/auth/roles.ts`), puis traitée par l'écran en
 *      `dispatcher` → alerte résolue, journal à jour.
 * Prérequis : `./scripts/dev_setup.sh`, l'API sur :8000 et **un worker Celery** (calcul du plan).
 * Connexions limitées à 10/min par adresse : une connexion par rôle, contextes réutilisés.
 *
 * Captures d'écran (`docs/captures/l13-0[89]-*.png`, `l13-1[0-3]-*.png`) :
 * `L13_CAPTURES=1 pnpm e2e l13-evenements`.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { ACCOUNTS, call, seedPublishedPlan, type Seed, type SeedTrip } from "./l13-seed";

const CAPTURES = !!process.env.L13_CAPTURES;
const OUT = "docs/captures";
const ADMIN = { email: "admin@honowa.tech", password: "admin-dev-only" };

let seed: Seed;
let day: string;
/** Tournée en panne : la seconde du camion, en cours, premier arrêt livré. */
let broken: SeedTrip;
/** Première tournée du même camion, terminée avant la panne. */
let earlier: SeedTrip;
let dispatcher: { context: BrowserContext; page: Page };

test.describe.configure({ mode: "serial" });

const utcAt = (utc: string, plusMinutes: number) =>
  new Date(Date.parse(utc) + plusMinutes * 60_000).toISOString();
/** Heure locale de Douala (UTC+1), sans séparateur (saisie rapide « 1015 »). */
function localDigits(utc: string, plusMinutes = 0): string {
  const date = new Date(Date.parse(utc) + (60 + plusMinutes) * 60_000);
  return `${String(date.getUTCHours()).padStart(2, "0")}${String(date.getUTCMinutes()).padStart(2, "0")}`;
}
const gasoil = (trip: SeedTrip) =>
  trip.loads.filter((load) => load.product_code === "GASOIL").reduce((sum, load) => sum + load.planned_l, 0);

/** Fait avancer une tournée par l'API : chargement, départ, puis livraison des `delivered` premiers arrêts. */
async function run(trip: SeedTrip, delivered: number, complete: boolean): Promise<void> {
  const token = seed.adminToken;
  const status = (body: Record<string, unknown>) =>
    call(`/trips/${trip.id}/status`, { method: "PUT", token, body });
  await status({ status: "at_depot" });
  await call(`/trips/${trip.id}/loading`, {
    method: "POST",
    token,
    body: {
      arrived_at: utcAt(trip.planned_depart_at, -125),
      started_at: utcAt(trip.planned_depart_at, -100),
      finished_at: utcAt(trip.planned_depart_at, -20),
      depot_ticket_no: `BL-22${30 + trip.seq}`,
      lines: trip.loads.map((load) => ({
        compartment_id: load.compartment_id,
        product_id: load.product_id,
        observed_l: load.planned_l,
        observed_temp_c: 19,
      })),
    },
  });
  await status({ status: "loaded" });
  await status({ status: "in_progress", actual_depart_at: utcAt(trip.planned_depart_at, 3) });
  for (const stop of trip.stops.slice(0, delivered)) {
    await call(`/stops/${stop.id}/delivery`, {
      method: "PUT",
      token,
      body: {
        actual_arrival_at: utcAt(stop.planned_arrival_at, 6),
        actual_departure_at: utcAt(stop.planned_arrival_at, 40),
        deliveries: stop.deliveries.map((line) => ({ order_id: line.order_id, actual_l: line.planned_l })),
      },
    });
  }
  if (complete) {
    const last = trip.stops[trip.stops.length - 1];
    await status({ status: "completed", actual_return_at: utcAt(last.planned_arrival_at, 70) });
  }
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  seed = await seedPublishedPlan();
  day = seed.day;
  // Un camion qui fait deux tournées : la première est terminée, la seconde tombe en panne en route.
  const byTruck = new Map<string, SeedTrip[]>();
  for (const trip of seed.trips) byTruck.set(trip.truck_id, [...(byTruck.get(trip.truck_id) ?? []), trip]);
  const pair = [...byTruck.values()].find((trips) => trips.length === 2 && trips[1].stops.length >= 2);
  expect(pair, "le plan d'essai contient un camion à deux tournées").toBeTruthy();
  [earlier, broken] = pair as [SeedTrip, SeedTrip];
  await run(earlier, earlier.stops.length, true);
  await run(broken, 1, false);
});

test.afterAll(async () => {
  await dispatcher?.context.close();
});

async function open(browser: Browser, account: { email: string; password: string }, path: string) {
  const context = await browser.newContext({
    baseURL: "http://localhost:5173",
    locale: "fr-FR",
    timezoneId: "Africa/Douala",
    viewport: CAPTURES ? { width: 1440, height: 900 } : { width: 1280, height: 800 },
    deviceScaleFactor: CAPTURES ? 2 : 1,
  });
  const page = await context.newPage();
  await page.goto("/connexion");
  await page.getByLabel("Adresse e-mail").fill(account.email);
  await page.getByLabel("Mot de passe", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page.getByTestId("user-menu")).toBeVisible();
  await page.goto(path);
  return { context, page };
}

async function shot(page: Page, name: string) {
  if (!CAPTURES) return;
  await page.waitForTimeout(400);
  const hide = await page.addStyleTag({
    content: "[data-sonner-toaster] { visibility: hidden !important; }",
  });
  await page.screenshot({ path: `${OUT}/${name}.png`, animations: "disabled" });
  await hide.evaluate((node) => (node as Element).remove());
}

test("dispatcher : panne de camion → assistant → nouvelle version publiée, journal, chargement", async ({
  browser,
}) => {
  dispatcher = await open(browser, ACCOUNTS.dispatcher, `/journal?day=${day}`);
  const { page } = dispatcher;
  await expect(page.getByTestId("mocks-badge")).toHaveCount(0);
  await expect(page.getByTestId("event-row").first()).toBeVisible();
  // Le dispatcher réaffecte et traite ; la déclaration d'une pénurie revient à Supply.
  await expect(page.getByRole("button", { name: "Déclarer une pénurie" })).toHaveCount(0);

  await page.getByRole("button", { name: "Assistant de réaffectation" }).click();
  const dialog = page.getByRole("dialog", { name: "Assistant de réaffectation" });
  const next = dialog.getByRole("button", { name: "Suivant" });

  // Étape 1 : panne de camion, constatée peu après la première livraison.
  await expect(dialog.getByRole("radio", { name: /Camion en panne/ })).toBeChecked();
  await dialog
    .getByRole("textbox", { name: /Heure de l'incident/ })
    .fill(localDigits(broken.stops[0].planned_arrival_at, 50));
  await next.click();

  // Étape 2 : la tournée en cours ; RM-19 — l'arrêt livré reste sur la tournée d'origine.
  await dialog.getByRole("radio", { name: new RegExp(`Tournée n° ${broken.seq} — `) }).click();
  const rm19 = dialog.getByRole("region", { name: /RM-19/ });
  await expect(
    rm19.getByText(new RegExp(`Arrêts? transférés? \\(${broken.stops.length - 1}\\)`)),
  ).toBeVisible();
  await expect(rm19.getByText(/conservé sur la tournée d'origine \(1\)/)).toBeVisible();
  await expect(rm19.getByText(broken.stops[0].station_name)).toBeVisible();
  await shot(page, "l13-09-journal-assistant-tournee-rm19");
  await next.click();

  // Étape 3 : le camion en panne n'est pas proposé ; on prend le premier camion éligible.
  const trucks = dialog.getByRole("group", { name: "Camion de remplacement" }).getByRole("radio");
  await expect(trucks.first()).toBeVisible();
  await expect(dialog.getByRole("radio", { name: new RegExp(`^${broken.truck_plate}`) })).toHaveCount(0);
  const eligible = dialog
    .getByRole("group", { name: "Camion de remplacement" })
    .locator("input[type=radio]:enabled");
  await expect(eligible.first()).toBeVisible();
  await eligible.first().check();
  const plate = (
    (await eligible.first().locator("xpath=ancestor::label").innerText()).split("\n")[0] ?? ""
  ).trim();
  await expect(dialog.getByRole("group", { name: /Chauffeur de la tournée de remplacement/ })).toBeVisible();
  await shot(page, "l13-10-journal-assistant-remplacant");
  await expect(next).toBeEnabled();
  await next.click();

  // Étape 4 : récapitulatif, motif, confirmation.
  await expect(dialog.getByRole("region", { name: "Récapitulatif" })).toContainText(plate);
  await dialog.getByRole("textbox", { name: /Motif/ }).fill("Fuite hydraulique sur l'axe Ndokoti");
  await dialog.getByRole("button", { name: "Confirmer la réaffectation" }).click();

  await expect(dialog.getByText("Réaffectation enregistrée")).toBeVisible();
  await expect(dialog.getByText(new RegExp(`Panne du camion ${broken.truck_plate}`))).toBeVisible();
  await expect(dialog.getByTestId("plan-result")).toContainText("Version 2 du plan publiée.");
  await expect(
    dialog.getByText(/arrêts? transférés?, 1 conservé sur la tournée d'origine \(RM-19\)/),
  ).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Ouvrir le plan (v2)" })).toBeVisible();
  await shot(page, "l13-12-journal-reaffectation-resultat");

  // La tournée de remplacement repart du dépôt : elle est dans l'écran Chargement, sur le nouveau camion.
  await dialog.getByRole("link", { name: "Ouvrir son chargement" }).click();
  await expect(page).toHaveURL(/\/chargement\?trip=/);
  await expect(page.getByTestId("trip-panel")).toContainText(plate);

  // Le journal porte l'événement, avec son motif.
  await page.goto(`/journal?day=${day}`);
  const row = page.getByTestId("event-row").filter({ hasText: `Panne du camion ${broken.truck_plate}` });
  await expect(row).toContainText("Motif : Fuite hydraulique sur l'axe Ndokoti");
  await expect(row).toContainText("Plan v2");
  await expect(row.getByRole("link", { name: "Voir le plan" })).toBeVisible();
});

test("pénurie produit : déclarée par l'écran (admin), traitée par le dispatcher → résolue", async ({
  browser,
}) => {
  // Stock total du jour = déjà chargé + 4 000 L : les tournées de gasoil non chargées ne sont plus couvertes.
  const loaded = gasoil(earlier) + gasoil(broken);
  const stock = loaded + 4000;

  const admin = await open(browser, ADMIN, `/journal?day=${day}`);
  await admin.page.getByRole("button", { name: "Déclarer une pénurie" }).click();
  const form = admin.page.getByRole("dialog", { name: "Déclarer une pénurie produit" });
  await form.getByRole("combobox", { name: "Dépôt" }).selectOption(broken.depot_id);
  await form.getByRole("combobox", { name: "Produit" }).selectOption({ label: "Gasoil" });
  const field = form.getByRole("textbox", { name: "Nouveau stock disponible" });

  // Refus expliqué : le stock total ne peut pas être inférieur à ce qui est déjà chargé.
  await field.fill(String(loaded - 1000));
  await form.getByRole("button", { name: "Déclarer" }).click();
  await expect(form.getByRole("alert")).toContainText("Déclaration refusée");
  await expect(form.getByRole("alert")).toContainText("Le stock saisi est le stock total du jour");

  await field.fill(String(stock));
  await form.getByRole("button", { name: "Déclarer" }).click();
  const overview = form.getByTestId("shortage-overview");
  await expect(overview).toContainText("GASOIL au dépôt");
  await expect(overview).toContainText("À traiter");
  await form.getByRole("button", { name: "Fermer" }).last().click();
  await expect(
    admin.page.getByTestId("event-row").filter({ hasText: "Stock de GASOIL au dépôt" }),
  ).toContainText("À traiter");
  await admin.context.close();

  // Le dispatcher traite l'alerte depuis le journal.
  const { page } = dispatcher;
  await page.goto(`/journal?day=${day}`);
  const alertRow = page.getByTestId("event-row").filter({ hasText: "Stock de GASOIL au dépôt" });
  await expect(alertRow).toContainText("À traiter");
  await shot(page, "l13-08-journal-evenements");
  await alertRow.getByRole("button", { name: "Traiter la pénurie" }).click();
  const impact = page.getByRole("dialog", { name: "Pénurie produit — tournées impactées" });
  const trips = impact.getByTestId("impacted-trip");
  await expect(trips.first()).toBeVisible();
  const count = await trips.count();
  expect(count).toBeGreaterThanOrEqual(1);

  // Les options viennent du serveur ; ici les commandes de gasoil de chaque tournée impactée sont reportées.
  for (let index = 0; index < count; index += 1) {
    const decision = trips.nth(index).getByRole("combobox", { name: /Décision pour la tournée/ });
    await expect(decision.getByRole("option", { name: "Changer de dépôt" })).toBeAttached();
    await decision.selectOption("postpone");
  }
  await shot(page, "l13-11-journal-penurie-tournees-impactees");
  await impact.getByRole("button", { name: "Appliquer les décisions" }).click();

  await expect(impact.getByText("Décisions appliquées")).toBeVisible();
  await expect(impact.getByTestId("shortage-overview")).toContainText("Résolue");
  await expect(impact.getByText(/La pénurie est résolue/)).toBeVisible();
  await expect(impact.getByTestId("plan-result").first()).toContainText(/Version \d+ du plan/);
  await shot(page, "l13-13-journal-penurie-traitee");
  await impact.getByRole("button", { name: "Fermer" }).last().click();

  // Journal à jour : alerte résolue, décision journalisée.
  await expect(alertRow).toContainText("Résolue");
  await expect(alertRow.getByRole("button", { name: "Traiter la pénurie" })).toHaveCount(0);
  await expect(
    page
      .getByTestId("event-row")
      .filter({ hasText: /Pénurie de GASOIL au dépôt/ })
      .first(),
  ).toBeVisible();
});
