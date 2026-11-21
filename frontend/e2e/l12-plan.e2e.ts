/**
 * Écran Plan de tournées, de bout en bout contre la VRAIE API (aucune doublure) :
 * ouvrir un plan calculé → déplacer un arrêt (glisser-déposer) → verrouiller → publier →
 * télécharger une feuille de route → modifier le plan publié (nouvelle version brouillon, RM-18).
 *
 * Prérequis : `./scripts/dev_setup.sh`, l'API, et un worker Celery
 * (`cd backend && uv run celery -A app.worker.celery_app worker --loglevel=warning`).
 * Les données (jeu `demo_douala`) sont créées par l'API pour un jour neuf à chaque exécution.
 */
import { expect, test, type Page } from "@playwright/test";

import { ADMIN, Api, freshDay, seedPlan } from "./l12-seed";

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

interface ApiStop {
  id: string;
  station_name: string;
  planned_l: number;
}
interface ApiTrip {
  id: string;
  seq: number;
  truck_capacity_l: number;
  planned_l: number;
  stops: ApiStop[];
}
interface ApiPlan {
  id: string;
  status: string;
  version: number;
  blocking_count: number;
  trips: ApiTrip[];
}

async function login(page: Page) {
  await page.goto("/connexion");
  await page.getByLabel("Adresse e-mail").fill(ADMIN.email);
  await page.getByLabel("Mot de passe", { exact: true }).fill(ADMIN.password);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page.getByTestId("user-menu")).toBeVisible();
}

/** Glisse la poignée d'un arrêt jusqu'à une cible (souris réelle, par étapes : dnd-kit suit le pointeur). */
async function dragTo(page: Page, handle: ReturnType<Page["locator"]>, target: ReturnType<Page["locator"]>) {
  const from = await handle.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error("Élément à glisser ou cible introuvable");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x - 30, from.y + from.height / 2, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
  await page.mouse.up();
}

test("plan calculé → déplacer un arrêt → verrouiller → publier → feuille de route → nouvelle version", async ({
  page,
}) => {
  const day = freshDay();
  const { planId } = await seedPlan({ fixture: "demo_douala", day });
  expect(planId).toBeTruthy();
  const api = await Api.login();
  const initial = await api.call<ApiPlan>("GET", `/plans/${planId}`);
  expect(initial.trips.length).toBeGreaterThan(1);

  // Déplacement choisi pour tenir dans le camion d'arrivée : le plus petit arrêt d'une tournée de plusieurs
  // arrêts, vers la tournée qui a le plus de capacité libre.
  const free = (trip: ApiTrip) => trip.truck_capacity_l - trip.planned_l;
  const target = [...initial.trips].sort((a, b) => free(b) - free(a))[0];
  const source = initial.trips
    .filter((trip) => trip.id !== target.id && trip.stops.length > 1)
    .sort(
      (a, b) => Math.min(...a.stops.map((s) => s.planned_l)) - Math.min(...b.stops.map((s) => s.planned_l)),
    )[0];
  const moved = [...source.stops].sort((a, b) => a.planned_l - b.planned_l)[0];

  await login(page);
  await page.goto(`/plan?day=${day}`);
  await expect(page.getByTestId("screen-plan")).toHaveAttribute("data-plan-id", planId as string);
  const list = page.getByRole("region", { name: "Liste des tournées" });
  const detail = page.getByRole("region", { name: "Détail de la tournée" });
  await expect(list.locator("[data-trip-card]")).toHaveCount(initial.trips.length);
  await expect(page.getByText("Brouillon", { exact: true })).toBeVisible();

  // 1. Sélection d'une tournée : détail (arrêts, heures en HH:mm, plan de chargement), carte synchronisée.
  await list.getByRole("button", { name: `Afficher la tournée ${source.seq}` }).click();
  await expect(detail.getByRole("heading", { name: `Tournée ${source.seq}` })).toBeVisible();
  await expect(detail.locator("[data-stop-row]")).toHaveCount(source.stops.length);
  await expect(detail.locator("[data-stop-row]").first()).toContainText(/\d{2}:\d{2} – \d{2}:\d{2}/);
  await expect(detail.getByText("Plan de chargement")).toBeVisible();

  // 2. Glisser-déposer d'un arrêt vers une autre tournée (move-stop) : le plan renvoyé remplace l'affichage.
  const row = detail.locator(`[data-stop-row="${moved.id}"]`);
  const moveResponse = page.waitForResponse(
    (response) => response.url().includes("/move-stop") && response.request().method() === "POST",
  );
  await dragTo(page, row.getByRole("button").first(), list.locator(`[data-trip-card="${target.id}"]`));
  expect((await moveResponse).status()).toBe(200);
  await expect(page.getByTestId("plan-sync")).toHaveAttribute("data-state", "saved");
  // La sélection suit l'arrêt : il est maintenant le dernier de la tournée d'arrivée.
  await expect(detail.getByRole("heading", { name: `Tournée ${target.seq}` })).toBeVisible();
  await expect(detail.locator("[data-stop-row]")).toHaveCount(target.stops.length + 1);
  await expect(detail.locator("[data-stop-row]").last()).toContainText(moved.station_name);
  const afterMove = await api.call<ApiPlan>("GET", `/plans/${planId}`);
  expect(afterMove.trips.find((trip) => trip.id === target.id)?.stops.at(-1)?.id).toBe(moved.id);

  // 3. Verrouillage d'une tournée restée intacte.
  const untouched = initial.trips.find((trip) => trip.id !== source.id && trip.id !== target.id) ?? target;
  await list.getByRole("button", { name: `Verrouiller la tournée ${untouched.seq}`, exact: true }).click();
  await expect(
    list.getByRole("button", { name: `Déverrouiller la tournée ${untouched.seq}`, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("plan-sync")).toHaveAttribute("data-state", "saved");

  // 4. Si le déplacement a créé une violation bloquante, la publication est désactivée et expliquée :
  //    « Recalculer en conservant » remet le plan d'aplomb en gardant la tournée verrouillée (RM-17).
  const publish = page.getByRole("button", { name: "Publier", exact: true });
  if (afterMove.blocking_count > 0) {
    await expect(publish).toBeDisabled();
    await expect(
      page.getByText(/Publication impossible : \d+ violations? bloquantes? à corriger\./),
    ).toBeVisible();
    await expect(
      page.getByTestId("violations-panel").locator('[data-severity="blocking"]').first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "Recalculer en conservant" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Recalculer" }).click();
    await expect(page.getByTestId("recompute-progress")).toBeVisible();
    await expect(page.getByTestId("recompute-progress")).toHaveCount(0, { timeout: 120_000 });
    await expect(
      list.getByRole("button", { name: /Déverrouiller la tournée/ }),
      "la tournée verrouillée est conservée par le recalcul",
    ).toHaveCount(1);
  }
  await expect(publish).toBeEnabled();

  // 5. Publication, après confirmation.
  await publish.click();
  const confirm = page.getByRole("alertdialog", { name: "Publier ce plan ?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Publier" }).click();
  await expect(page.getByText("Publié", { exact: true })).toBeVisible();
  await expect(publish).toHaveCount(0);
  const published = await api.call<ApiPlan>("GET", `/plans/${planId}`);
  expect(published.status).toBe("published");

  // 6. Feuilles de route PDF : toutes, puis celle d'une tournée.
  const all = page.waitForEvent("download");
  await page.getByRole("button", { name: "Feuilles de route" }).click();
  expect((await all).suggestedFilename()).toMatch(/\.pdf$/);
  await list.locator("[data-trip-button]").first().click();
  const one = page.waitForEvent("download");
  await detail.getByRole("button", { name: "Feuille de route" }).click();
  const sheet = await one;
  expect(sheet.suggestedFilename()).toMatch(/\.pdf$/);
  expect(await sheet.failure()).toBeNull();

  // 7. Modifier le plan publié : l'API renvoie une nouvelle version brouillon (autre id) — l'écran bascule
  //    dessus, adresse comprise, et l'annonce. La version publiée reste intacte.
  await expect(page.getByText(/Toute modification crée une nouvelle version brouillon/)).toBeVisible();
  const lockable = list.getByRole("button", { name: /^Verrouiller la tournée \d+$/ }).first();
  await lockable.click();
  await expect(
    page.getByText(`Nouvelle version brouillon (version ${published.version + 1})`).first(),
  ).toBeVisible();
  await expect(page).toHaveURL(/[?&]plan=/);
  const draftId = new URL(page.url()).searchParams.get("plan");
  expect(draftId).not.toBe(planId);
  await expect(page.getByTestId("screen-plan")).toHaveAttribute("data-plan-id", draftId as string);
  await expect(
    page.getByText(/reste la référence du terrain tant que ce brouillon n'est pas publié/),
  ).toBeVisible();
  expect((await api.call<ApiPlan>("GET", `/plans/${planId}`)).status).toBe("published");

  // 8. Historique : les deux versions, qui a fait quoi.
  await page.getByRole("button", { name: "Historique" }).click();
  const history = page.getByRole("dialog", { name: "Historique des versions" });
  await expect(history.getByTestId("version-2")).toContainText("Brouillon");
  await expect(history.getByTestId("version-1")).toContainText("Publié");
  await expect(history.getByTestId("version-1")).toContainText("Version 1 publiée");
  await expect(
    history.getByTestId("version-1").getByRole("button", { name: "Restaurer la version 1" }),
  ).toBeVisible();
});

test("édition au clavier et vue tableau contre la vraie API", async ({ page }) => {
  const day = freshDay();
  const { planId } = await seedPlan({ fixture: "demo_douala", day });
  const api = await Api.login();
  const initial = await api.call<ApiPlan>("GET", `/plans/${planId}`);
  const trip = initial.trips.find((candidate) => candidate.stops.length > 1) as ApiTrip;

  await login(page);
  await page.goto(`/plan?day=${day}`);
  await page.getByRole("radio", { name: "Tableau" }).click();
  const table = page.getByRole("table", { name: "Plan de tournées — vue tableau" });
  const total = initial.trips.reduce((sum, t) => sum + t.stops.length, 0);
  await expect(table.locator("[data-stop-row]")).toHaveCount(total);

  // Alt+↓ sur le premier arrêt d'une tournée : il passe en deuxième position (reorder).
  const first = table.locator(`[data-stop-row="${trip.stops[0].id}"]`);
  await first.focus();
  const reorder = page.waitForResponse((response) => response.url().includes("/reorder"));
  await page.keyboard.press("Alt+ArrowDown");
  expect((await reorder).status()).toBe(200);
  await expect(page.getByTestId("plan-sync")).toHaveAttribute("data-state", "saved");
  const after = await api.call<ApiPlan>("GET", `/plans/${planId}`);
  expect(
    after.trips
      .find((t) => t.id === trip.id)
      ?.stops.map((s) => s.id)
      .slice(0, 2),
  ).toEqual([trip.stops[1].id, trip.stops[0].id]);
  await expect(first).toBeFocused();
  await expect(first.locator("td").nth(1)).toHaveText("2");
});
