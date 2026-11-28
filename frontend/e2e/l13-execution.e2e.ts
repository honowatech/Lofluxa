/**
 * Lot L13 — bout en bout contre la VRAIE API (aucune doublure) :
 *   1. `fleet`      : arrivée au dépôt → chargement avec avertissement RM-13 → fiche PDF → départ ;
 *   2. `dispatcher` : une livraison, un arrêt sauté, clôture de la tournée.
 * Prérequis : `./scripts/dev_setup.sh`, l'API sur :8000 et **un worker Celery** (calcul du plan).
 *
 * Captures d'écran (`docs/captures/l13-0[1-7]-*.png`) : `L13_CAPTURES=1 pnpm e2e l13-execution`.
 * Les écrans 7 et 8 sont alors photographiés sur les données réelles du parcours.
 */
import { readFileSync } from "node:fs";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { openSession } from "./auth";
import { ACCOUNTS, call, seedPublishedPlan, type Seed, type SeedTrip } from "./l13-seed";

const CAPTURES = !!process.env.L13_CAPTURES;
const OUT = "docs/captures";
const FLEET = ACCOUNTS.fleet;
const DISPATCHER = ACCOUNTS.dispatcher;

let seed: Seed;
let day: string;
let trip: SeedTrip;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(300_000);
  seed = await seedPublishedPlan();
  day = seed.day;
  trip = seed.trips[0];
  expect(trip.stops.length).toBeGreaterThanOrEqual(2);
  await prepareSecondTrip(seed);
});

/** Heure locale de Douala (UTC+1) d'un horodatage UTC, décalée de quelques minutes. */
function localTime(utc: string, plusMinutes = 0): string {
  const date = new Date(Date.parse(utc) + (60 + plusMinutes) * 60_000);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}
const utcAt = (utc: string, plusMinutes: number) =>
  new Date(Date.parse(utc) + plusMinutes * 60_000).toISOString();

/** Une deuxième tournée déjà en route (par l'API), pour que les listes montrent plusieurs états. */
async function prepareSecondTrip({ trips, adminToken: token }: Seed): Promise<void> {
  const other = trips[1];
  if (!other) return;
  const status = (body: Record<string, unknown>) =>
    call(`/trips/${other.id}/status`, { method: "PUT", token, body });
  await status({ status: "at_depot" });
  await call(`/trips/${other.id}/loading`, {
    method: "POST",
    token,
    body: {
      arrived_at: utcAt(other.planned_depart_at, -125),
      started_at: utcAt(other.planned_depart_at, -100),
      finished_at: utcAt(other.planned_depart_at, -20),
      depot_ticket_no: "BL-2231",
      lines: other.loads.map((load) => ({
        compartment_id: load.compartment_id,
        product_id: load.product_id,
        observed_l: load.planned_l + 40,
        observed_temp_c: 19.5,
        observed_density: load.product_code === "SUPER" ? 0.745 : 0.84,
      })),
    },
  });
  await status({ status: "loaded" });
  await status({ status: "in_progress", actual_depart_at: utcAt(other.planned_depart_at, 4) });
  const first = other.stops[0];
  await call(`/stops/${first.id}/delivery`, {
    method: "PUT",
    token,
    body: {
      actual_arrival_at: utcAt(first.planned_arrival_at, 21),
      actual_departure_at: utcAt(first.planned_arrival_at, 58),
      deliveries: first.deliveries.map((line) => ({ order_id: line.order_id, actual_l: line.planned_l })),
    },
  });
}

async function open(browser: Browser, account: { email: string; password: string }, path: string) {
  const context = await browser.newContext({
    baseURL: "http://localhost:5173",
    locale: "fr-FR",
    timezoneId: "Africa/Douala",
    acceptDownloads: true,
    viewport: CAPTURES ? { width: 1440, height: 900 } : { width: 1280, height: 800 },
    deviceScaleFactor: CAPTURES ? 2 : 1,
  });
  const page = await context.newPage();
  // Session ouverte par jeton (aide commune) : seul le parcours de connexion passe par le formulaire.
  await openSession(page, account);
  await page.goto(path);
  await expect(page.getByTestId("user-menu")).toBeVisible();
  return { context, page };
}

async function shot(page: Page, name: string) {
  if (!CAPTURES) return;
  await page.waitForTimeout(400);
  // Les notifications passagères masqueraient le bas de l'écran (mention RM-12, boutons).
  const hide = await page.addStyleTag({
    content: "[data-sonner-toaster] { visibility: hidden !important; }",
  });
  await page.screenshot({ path: `${OUT}/${name}.png`, animations: "disabled" });
  await hide.evaluate((node) => (node as Element).remove());
}

test("fleet : arrivée au dépôt → chargement avec avertissement RM-13 → fiche PDF → départ", async ({
  browser,
}) => {
  const { context, page } = await open(browser, FLEET, `/chargement?day=${day}&trip=${trip.id}`);
  await expect(page.getByTestId("mocks-badge")).toHaveCount(0);
  const panel = page.getByTestId("trip-panel");
  await expect(panel.getByRole("heading", { name: new RegExp(`Tournée ${trip.seq}`) })).toBeVisible();
  await expect(page.getByRole("list", { name: "Tournées du jour" }).getByRole("listitem")).toHaveCount(
    seed.trips.length,
  );
  // Tant que le chargement n'est pas saisi : pas de fiche.
  await expect(panel.getByRole("button", { name: "Fiche de chargement" })).toBeDisabled();

  await panel.getByRole("button", { name: "Camion arrivé au dépôt" }).click();
  await expect(panel.getByRole("listitem").filter({ hasText: "Au dépôt" })).toHaveAttribute(
    "aria-current",
    "step",
  );
  await expect(panel.getByRole("button", { name: "Chargement terminé" })).toBeDisabled();

  // Saisie au clavier : Entrée passe d'un champ au suivant.
  await panel.getByRole("textbox", { name: "Arrivée au dépôt" }).click();
  const entries = [
    localTime(trip.planned_depart_at, -130).replace(":", ""),
    localTime(trip.planned_depart_at, -105).replace(":", ""),
    localTime(trip.planned_depart_at, -25).replace(":", ""),
    "BL-2238",
  ];
  for (const [index, load] of trip.loads.entries()) {
    // Le premier compartiment est chargé 3 % sous le planifié : hors tolérance (2 %) même avant correction.
    const observed = index === 0 ? Math.round(load.planned_l * 0.97) : Math.round(load.planned_l);
    entries.push(String(observed), "24,5", load.product_code === "SUPER" ? "0,745" : "0,84");
  }
  for (const entry of entries) {
    await page.keyboard.type(entry);
    await page.keyboard.press("Enter");
  }

  // Calcul en direct (RM-12) : volume observé × [1 − coefficient × (température − 15)].
  const first = trip.loads[0];
  const coeff = first.product_code === "SUPER" ? 0.0012 : first.product_code === "GASOIL" ? 0.00085 : 0.00095;
  const expected15 = Math.round(first.planned_l * 0.97) * (1 - coeff * 9.5);
  const live = await panel
    .getByTestId(`compartment-${first.compartment_position}`)
    .getByTestId("at15")
    .innerText();
  expect(Number(live.replace(/\s/g, "").replace(",", "."))).toBeCloseTo(expected15, 1);
  await expect(panel.getByTestId("rm13-warning")).toContainText("RM-13");
  await expect(panel.getByTestId("astm-note")).toContainText("tables ASTM non appliquées dans le prototype");
  await shot(page, "l13-01-chargement-saisie-rm13");

  await page.keyboard.press("Control+Enter");
  await expect(panel.getByRole("button", { name: "Mettre à jour le chargement" })).toBeVisible();
  // La valeur enregistrée est celle du serveur ; l'avertissement RM-13 est porté par la tournée.
  const saved = await panel
    .getByTestId(`compartment-${first.compartment_position}`)
    .getByTestId("at15")
    .innerText();
  expect(Number(saved.replace(/\s/g, "").replace(",", "."))).toBeCloseTo(expected15, 1);
  await expect(panel.getByTestId("rm13-warning")).toBeVisible();
  await expect(page.getByTestId(`trip-card-${trip.seq}`)).toContainText("Écart RM-13");

  // Fiche de chargement PDF.
  const download = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Fiche de chargement" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.pdf$/);
  expect(
    readFileSync(await file.path())
      .subarray(0, 4)
      .toString(),
  ).toBe("%PDF");

  // Destinataires proposés pour l'envoi par e-mail (pas d'envoi : aucun serveur SMTP en développement).
  await panel.getByRole("button", { name: "Envoyer la fiche" }).click();
  const dialog = page.getByRole("dialog", { name: "Envoyer la fiche de chargement" });
  await expect(dialog.getByRole("checkbox")).toHaveCount(
    new Set(trip.stops.map((stop) => stop.station_code)).size,
  );
  await shot(page, "l13-02-chargement-envoi-fiche");
  await dialog.getByRole("button", { name: "Annuler" }).click();

  await panel.getByRole("button", { name: "Chargement terminé" }).click();
  await expect(panel.getByRole("button", { name: "Départ du dépôt" })).toBeVisible();
  await shot(page, "l13-03-chargement-enregistre-pret-au-depart");
  await panel
    .getByRole("textbox", { name: "Heure de départ réelle" })
    .fill(localTime(trip.planned_depart_at, 7));
  await panel.getByRole("button", { name: "Départ du dépôt" }).click();
  await expect(panel.getByText(/Chargement figé/)).toBeVisible();
  await expect(page.getByTestId(`trip-card-${trip.seq}`)).toContainText("En cours");
  await expect(panel.getByRole("link", { name: "Suivi des livraisons" })).toBeVisible();
  await context.close();
});

test("dispatcher : une livraison, un arrêt sauté, clôture de la tournée", async ({ browser }) => {
  const { context, page } = await open(browser, DISPATCHER, `/suivi?day=${day}&trip=${trip.id}`);
  const detail = page.getByTestId("trip-detail");
  await expect(detail.getByRole("heading", { name: new RegExp(`Tournée ${trip.seq}`) })).toContainText(
    "En cours",
  );
  await expect(detail.getByRole("button", { name: "Clôturer la tournée" })).toBeDisabled();

  // Premier arrêt : livré, avec un quart d'heure de retard et un volume légèrement inférieur.
  const [firstStop, ...others] = trip.stops;
  const first = detail.getByTestId(`stop-${firstStop.seq}`);
  await first
    .getByRole("textbox", { name: `Arrivée réelle, arrêt ${firstStop.seq}` })
    .fill(localTime(firstStop.planned_arrival_at, 15));
  await first
    .getByRole("textbox", { name: `Départ réel, arrêt ${firstStop.seq}` })
    .fill(localTime(firstStop.planned_arrival_at, 52));
  const volume = first.getByRole("textbox", { name: /Volume livré/ }).first();
  await volume.fill(String(firstStop.deliveries[0].planned_l - 150));
  if (others.length > 0) {
    // Arrêt suivant : formulaire « sauté » ouvert pour la capture.
    await detail
      .getByTestId(`stop-${others[0].seq}`)
      .getByRole("button", { name: "Saisir la livraison" })
      .click();
  }
  await shot(page, "l13-04-suivi-saisie-livraison");
  if (others.length > 0) {
    await detail.getByTestId(`stop-${others[0].seq}`).getByRole("button", { name: "Annuler" }).click();
  }
  await first.getByRole("button", { name: "Enregistrer la livraison" }).click();
  await expect(first.getByText("Livré", { exact: true })).toBeVisible();
  // L'heure saisie est à la minute, l'heure prévue a des secondes : le retard attendu est recalculé.
  const typed = Math.floor((Date.parse(firstStop.planned_arrival_at) + 15 * 60_000) / 60_000) * 60_000;
  const lateMinutes = Math.round((typed - Date.parse(firstStop.planned_arrival_at)) / 60_000);
  await expect(first.getByTestId("delay")).toHaveText(`Retard ${lateMinutes} min`);
  await expect(detail.getByTestId("trip-progress")).toHaveText(`1 / ${trip.stops.length} arrêts`);
  // Livré : corrigeable, mais plus « sautable ».
  await expect(first.getByRole("button", { name: "Corriger" })).toBeVisible();
  await expect(first.getByRole("button", { name: "Arrêt sauté…" })).toHaveCount(0);

  // Arrêts suivants : sautés, motif obligatoire.
  for (const stop of others) {
    const card = detail.getByTestId(`stop-${stop.seq}`);
    await card.getByRole("button", { name: "Arrêt sauté…" }).click();
    await card.getByRole("button", { name: "Confirmer l'arrêt sauté" }).click();
    await expect(card.getByText("Le motif est obligatoire pour un arrêt sauté.")).toBeVisible();
    await card.getByRole("textbox", { name: /Motif de l'arrêt sauté/ }).fill("Station fermée à l'arrivée");
    if (stop === others[0]) await shot(page, "l13-05-suivi-arret-saute");
    await card.getByRole("button", { name: "Confirmer l'arrêt sauté" }).click();
    await expect(card.getByText("Motif : Station fermée à l'arrivée")).toBeVisible();
    await expect(card.getByText(/Arrêt sauté : non réversible/)).toBeVisible();
  }

  // Clôture : heure de retour et kilomètres réels.
  await expect(detail.getByTestId("close-hint")).toContainText("Tous les arrêts sont traités");
  const lastStop = trip.stops[trip.stops.length - 1];
  await detail
    .getByRole("textbox", { name: "Heure de retour au dépôt" })
    .fill(localTime(lastStop.planned_arrival_at, 70));
  await detail.getByRole("textbox", { name: /Kilomètres réels/ }).fill("14,8");
  await shot(page, "l13-06-suivi-cloture");
  await detail.getByRole("button", { name: "Clôturer la tournée" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Clôturer la tournée" }).click();
  await expect(detail.getByRole("heading", { name: new RegExp(`Tournée ${trip.seq}`) })).toContainText(
    "Terminée",
  );
  await expect(detail.getByText(/Tournée terminée : les heures, volumes/)).toBeVisible();
  await expect(detail.getByText("14,8 km")).toBeVisible();
  await expect(detail.getByRole("button", { name: "Clôturer la tournée" })).toHaveCount(0);
  await shot(page, "l13-07-suivi-tournee-terminee");

  // Côté chargement, la tournée terminée est figée (lecture seule pour tous).
  await page.goto(`/chargement?day=${day}&trip=${trip.id}`);
  await expect(page.getByTestId("trip-panel").getByText(/Chargement figé/)).toBeVisible();
  await context.close();
});
