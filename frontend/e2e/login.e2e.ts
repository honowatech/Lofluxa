/**
 * Bout en bout contre la vraie API (aucune doublure) : connexion admin → coquille → déconnexion.
 * Compte créé par le seed (`./scripts/dev_setup.sh`).
 */
import { expect, test } from "@playwright/test";

import { ADMIN, PATIENT_TIMEOUT, submitLogin } from "./l9-auth";

test.setTimeout(PATIENT_TIMEOUT);

test("connexion refusée avec un mauvais mot de passe", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/connexion$/);
  await submitLogin(page, ADMIN.email, "mauvais-mot-de-passe");
  await expect(page.getByRole("alert")).toContainText("E-mail ou mot de passe incorrect.");
  await expect(page).toHaveURL(/\/connexion$/);
});

test("connexion admin → coquille → déconnexion", async ({ page }) => {
  // Une route protégée renvoie à la connexion, puis ramène à la page demandée (jour J conservé).
  await page.goto("/plan?day=2027-01-12");
  await expect(page).toHaveURL(/\/connexion$/);
  await submitLogin(page, ADMIN.email, ADMIN.password);

  await expect(page).toHaveURL(/\/plan\?day=2027-01-12$/);
  await expect(page.getByTestId("mocks-badge")).toHaveCount(0);

  // Coquille : identité, rôle, les dix écrans de la navigation (admin voit tout), jour J.
  await expect(page.getByTestId("user-role")).toHaveText("Administrateur");
  const nav = page.getByRole("navigation", { name: "Navigation principale" });
  await expect(nav.getByRole("link")).toHaveCount(10);
  await expect(nav.getByRole("link", { name: "Plan de tournées" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("day-label")).toContainText("12 janv. 2027");

  // Le jour J suit la navigation.
  await page.getByRole("button", { name: "Jour suivant" }).click();
  await expect(page).toHaveURL(/day=2027-01-13/);
  await nav.getByRole("link", { name: "Commandes du jour" }).click();
  await expect(page).toHaveURL(/\/commandes\?day=2027-01-13$/);
  await expect(page.getByRole("heading", { level: 1, name: "Commandes du jour" })).toBeVisible();

  // La session survit au rechargement (jetons stockés).
  await page.reload();
  await expect(page.getByTestId("user-role")).toHaveText("Administrateur");

  // Jeton d'accès périmé : rafraîchissement transparent, sans retour à la connexion.
  await page.evaluate(() => {
    const tokens = JSON.parse(window.localStorage.getItem("tourneo.tokens") ?? "{}");
    window.localStorage.setItem(
      "tourneo.tokens",
      JSON.stringify({ ...tokens, access_token: "jeton.perime.invalide" }),
    );
  });
  const refreshed = page.waitForResponse(
    (response) => response.url().includes("/auth/refresh") && response.ok(),
  );
  await page.reload();
  await refreshed;
  await expect(page.getByTestId("user-role")).toHaveText("Administrateur");
  await expect(page).toHaveURL(/\/commandes/);

  // Déconnexion : retour à la connexion, routes de nouveau protégées.
  await page.getByTestId("user-menu").click();
  await page.getByRole("menuitem", { name: "Se déconnecter" }).click();
  await expect(page).toHaveURL(/\/connexion$/);
  await expect(page.getByText("Vous êtes déconnecté.")).toBeVisible();
  expect(await page.evaluate(() => window.localStorage.getItem("tourneo.tokens"))).toBeNull();
  await page.goto("/journee");
  await expect(page).toHaveURL(/\/connexion$/);
});
