/**
 * Lot L13 — bout en bout contre la VRAIE API (aucune doublure) :
 *   1. `fleet`      : arrivée au dépôt → chargement avec avertissement RM-13 → fiche PDF → départ ;
 *   2. `dispatcher` : une livraison, un arrêt sauté, clôture de la tournée.
 * Prérequis : `./scripts/dev_setup.sh`, l'API sur :8000 et **un worker Celery** (calcul du plan).
 *
 * Captures d'écran (`docs/captures/l13-*.png`) : `L13_CAPTURES=1 pnpm e2e l13-execution`.
 * Les écrans 7 et 8 sont alors photographiés sur les données réelles du parcours ; le journal des
 * événements (routes du lot L10 non livrées) l'est avec des réponses `/events*` simulées dans la page.
 */
import { readFileSync } from "node:fs";

import { expect, test, type Browser, type Page } from "@playwright/test";

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
  await expect(first.getByTestId("delay")).toHaveText("Retard 15 min");
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

/* ------------------------------------------------------------------ captures du journal des événements */

/**
 * Journal d'une journée type, bâti sur le plan réel du parcours. Les routes `/events*` (lot L10) n'existent
 * pas encore : leurs réponses sont simulées dans la page, selon les formes supposées de
 * `src/features/events/api.ts`. Tout le reste (plans, dépôts, produits) vient de la vraie API.
 */
function sampleEvents(): Record<string, unknown>[] {
  const [t1, t2] = seed.trips;
  const depart = t1.planned_depart_at;
  const people = { dispatcher: "Serge Mbarga", fleet: "Brigitte Ngo Bassa", supply: "Aïcha Njoya" };
  let n = 0;
  const event = (
    minutes: number,
    type: string,
    actor: keyof typeof people,
    payload: Record<string, unknown>,
    on: SeedTrip | null = null,
  ) => ({
    id: `00000000-0000-4000-a000-${String((n += 1)).padStart(12, "0")}`,
    day,
    plan_id: seed.planId,
    trip_id: on?.id ?? null,
    type,
    payload,
    occurred_at: utcAt(depart, minutes),
    actor_id: null,
    actor_name: people[actor],
    trip_seq: on?.seq ?? null,
    truck_plate: on?.truck_plate ?? null,
  });
  const total = (item: SeedTrip) => item.loads.reduce((sum, load) => sum + load.planned_l, 0);
  const delivery = (item: SeedTrip, index: number, status: string, reason: string | null = null) => ({
    stop_id: item.stops[index].id,
    seq: item.stops[index].seq,
    station_code: item.stops[index].station_code,
    status,
    skip_reason: reason,
    deliveries: item.stops[index].deliveries.map((line) => ({
      order_id: line.order_id,
      planned_l: line.planned_l,
      actual_l: status === "delivered" ? line.planned_l : null,
    })),
  });
  return [
    event(-190, "manual_edit", "dispatcher", {
      plan_version: 1,
      action: "reorder",
      summary: `Ordre des arrêts de la tournée n° ${t2.seq} modifié.`,
    }),
    event(-175, "publish", "dispatcher", {
      plan_version: 1,
      action: "publish",
      summary: "Version 1 publiée.",
    }),
    event(
      -22,
      "loading_recorded",
      "fleet",
      {
        updated: false,
        depot_ticket_no: "BL-2231",
        volume_15_total_l: total(t2) * 0.9962,
        planned_total_l: total(t2),
        gap_pct: -0.38,
        out_of_tolerance: false,
      },
      t2,
    ),
    event(
      -18,
      "loading_recorded",
      "fleet",
      {
        updated: false,
        depot_ticket_no: "BL-2238",
        volume_15_total_l: total(t1) * 0.9737,
        planned_total_l: total(t1),
        gap_pct: -2.63,
        out_of_tolerance: true,
      },
      t1,
    ),
    event(24, "delivery_recorded", "dispatcher", delivery(t1, 0, "delivered"), t1),
    event(41, "delivery_recorded", "dispatcher", delivery(t2, 0, "delivered"), t2),
    event(
      63,
      "product_shortage",
      "dispatcher",
      {
        depot_code: "SCDP-DLA",
        product_code: "GASOIL",
        product_label: "Gasoil",
        previous_available_l: 400000,
        new_available_l: 15000,
        impacted_trips: [{ trip_id: t2.id, trip_seq: t2.seq, truck_plate: t2.truck_plate, planned_l: 19000 }],
      },
      null,
    ),
    event(
      78,
      "delivery_recorded",
      "dispatcher",
      delivery(t1, 1, "skipped", "Station fermée à l'arrivée"),
      t1,
    ),
    event(
      96,
      "truck_breakdown",
      "dispatcher",
      {
        truck_plate: t2.truck_plate,
        replacement_truck_plate: "LT 608 EM",
        replacement_driver_name: null,
        transferred_stop_count: t2.stops.length - 1,
        kept_stop_count: 1,
        new_plan_id: seed.planId,
        new_plan_version: 2,
      },
      t2,
    ),
    event(97, "replan", "dispatcher", {
      plan_version: 2,
      action: "recompute",
      summary:
        "Plan recalculé en conservant 1 tournée(s) figée(s) : 4 tournée(s), 0 commande(s) non servie(s).",
    }),
    event(99, "publish", "dispatcher", {
      plan_version: 2,
      action: "publish",
      summary: "Version 2 publiée (la version 1 est archivée).",
    }),
  ];
}

test("captures : journal des événements, assistant de réaffectation, pénurie", async ({ browser }) => {
  test.skip(
    !CAPTURES,
    "Captures seulement (L13_CAPTURES=1) : les routes /events du lot L10 ne sont pas livrées.",
  );
  const { context, page } = await open(browser, DISPATCHER, "/journee");
  // Attendre la fin du démarrage de session : une navigation pendant le `GET /me` initial l'interrompt,
  // et la coquille efface alors les jetons (retour à la connexion).
  await expect(page.getByTestId("screen-day")).toBeVisible();
  const other = seed.trips[1];
  await page.route("**/api/v1/events**", async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname.endsWith("/events")) {
      const items = sampleEvents();
      return json({ items, total: items.length, limit: 200, offset: 0 });
    }
    if (url.pathname.endsWith("/replacement-options")) {
      const truck = (
        plate: string,
        size: string,
        capacity: number,
        carrier: string,
        reason: string | null = null,
      ) => ({
        id: `00000000-0000-4000-b000-${plate.replace(/\D/g, "").padStart(12, "0")}`,
        plate,
        size,
        total_capacity_l: capacity,
        carrier_name: carrier,
        suitable: reason === null,
        reason,
      });
      return json({
        trucks: [
          truck("LT 608 EM", "medium", 20000, "OLA Flotte"),
          truck("LT 334 BX", "medium", 24000, "OLA Flotte"),
          truck("LT 123 AB", "large", 33000, "Transcam"),
          truck("LT 456 CD", "small", 12000, "Transcam", "En maintenance"),
        ],
        drivers: [
          {
            id: "00000000-0000-4000-c000-000000000001",
            full_name: "Hervé Ndjock",
            phone: "+237 677 10 20 33",
          },
          {
            id: "00000000-0000-4000-c000-000000000002",
            full_name: "Rodrigue Essomba",
            phone: "+237 677 10 20 31",
          },
        ],
      });
    }
    if (url.pathname.endsWith("/product-shortage")) {
      return json({
        available_l: 15000,
        impacted_trips: seed.trips.slice(1, 3).map((item, index) => ({
          trip_id: item.id,
          plan_id: seed.planId,
          trip_seq: item.seq,
          truck_plate: item.truck_plate,
          driver_name: item.driver_name,
          planned_l: index === 0 ? 19000 : 17840,
          shortfall_l: index === 0 ? 4000 : 17840,
        })),
      });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  await page.goto(`/journal?day=${day}`);
  await expect(page.getByTestId("screen-events")).toBeVisible();
  await expect(page.getByText("Version 2 publiée (la version 1 est archivée).")).toBeVisible();
  await shot(page, "l13-08-journal-evenements");

  // Assistant de réaffectation : panne de camion sur la tournée en cours.
  await page.getByRole("button", { name: "Assistant de réaffectation" }).click();
  const assistant = page.getByRole("dialog", { name: "Assistant de réaffectation" });
  await assistant.getByText("Camion en panne", { exact: true }).click();
  await assistant.getByRole("button", { name: "Suivant" }).click();
  await assistant
    .getByText(new RegExp(`Tournée n° ${other.seq} —`))
    .first()
    .click();
  await expect(assistant.getByText(/RM-19/)).toBeVisible();
  await shot(page, "l13-09-journal-assistant-tournee-rm19");
  await assistant.getByRole("button", { name: "Suivant" }).click();
  await assistant.getByText("LT 608 EM").click();
  await shot(page, "l13-10-journal-assistant-remplacant");
  await page.keyboard.press("Escape");

  // Pénurie produit : tournées impactées et choix du dispatcher.
  await page.getByRole("button", { name: "Déclarer une pénurie" }).click();
  const shortage = page.getByRole("dialog", { name: "Déclarer une pénurie produit" });
  await shortage.getByLabel("Dépôt").selectOption({ index: 1 });
  // Produits triés par code : le premier est le gasoil.
  await shortage.getByLabel("Produit").selectOption({ index: 1 });
  await shortage.getByLabel("Nouveau stock disponible").fill("15000");
  await shortage.getByRole("button", { name: "Déclarer", exact: true }).click();
  await expect(shortage.getByText(/tournées impactées/)).toBeVisible();
  await shot(page, "l13-11-journal-penurie-tournees-impactees");
  await context.close();
});
