/**
 * Captures d'écran des écrans livrés (pour la revue) → `docs/captures/`.
 * Tourne sur les doublures complètes (`VITE_MOCKS=full`) : aucun back-end requis.
 */
import { expect, test, type Page } from "@playwright/test";

const OUT = "docs/captures";
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${OUT}/${name}.png`, animations: "disabled" });

async function login(page: Page, email = "admin@honowa.tech", password = "admin-dev-only") {
  await page.goto("/connexion");
  await page.getByLabel("Adresse e-mail").fill(email);
  await page.getByLabel("Mot de passe", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page.getByTestId("user-menu")).toBeVisible();
}

test("captures des écrans livrés", async ({ page }) => {
  await page.goto("/connexion");
  await expect(page.getByRole("button", { name: "Se connecter" })).toBeVisible();
  await shot(page, "01-connexion");

  await login(page);
  // Écran réel de vague 2 servi par les doublures de son lot (mode démonstration sans back-end).
  await page.goto("/journee?day=2027-01-12");
  await expect(page.getByRole("heading", { level: 1, name: "Journée" })).toBeVisible();
  await page.waitForTimeout(600);
  await shot(page, "02-coquille-journee-demonstration");

  // Écrans Chargement, Suivi et Journal : leurs doublures portent sur le jour courant (pas de `?day=`).
  await page.goto("/chargement");
  await expect(page.getByTestId("screen-loading")).toBeVisible();
  await page.waitForTimeout(600);
  await shot(page, "02b-demonstration-chargement");
  await page.goto("/suivi");
  await expect(page.getByRole("heading", { level: 1, name: "Suivi des livraisons" })).toBeVisible();
  await page.waitForTimeout(600);
  await shot(page, "02c-demonstration-suivi");
  await page.goto("/journal");
  await expect(page.getByRole("heading", { level: 1, name: "Journal des événements" })).toBeVisible();
  await page.waitForTimeout(600);
  await shot(page, "02d-demonstration-journal");

  await page.goto("/journee?day=2027-01-12");
  await page.getByRole("button", { name: /Alertes/ }).click();
  await expect(page.getByText(/permis ou une habilitation expiré/)).toBeVisible();
  await shot(page, "03-coquille-alertes");
  await page.keyboard.press("Escape");

  await page.goto("/referentiels?tab=stations");
  await expect(page.getByRole("grid", { name: "Stations" }).getByRole("row")).toHaveCount(31);
  await page.waitForTimeout(1200);
  await page.getByRole("gridcell", { name: "OLA Deido", exact: true }).hover();
  await shot(page, "04-referentiels-stations-carte");

  await page.getByRole("gridcell", { name: "OLA Akwa Boulevard", exact: true }).dblclick();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForTimeout(1200);
  await shot(page, "05-referentiels-station-formulaire");
  await page.getByRole("dialog").getByRole("button", { name: "Annuler" }).click();

  await page.goto("/referentiels?tab=depots");
  await expect(page.getByRole("grid", { name: "Dépôts" }).getByRole("row")).toHaveCount(4);
  await page.waitForTimeout(1200);
  await shot(page, "06-referentiels-depots");

  await page.goto("/referentiels?tab=trucks");
  await expect(page.getByRole("grid", { name: "Camions" }).getByRole("row")).toHaveCount(13);
  await shot(page, "07-referentiels-camions");
  await page.getByRole("gridcell", { name: "LT 482 AB", exact: true }).dblclick();
  await expect(page.getByRole("dialog")).toBeVisible();
  await shot(page, "08-referentiels-camion-compartiments");
  await page.getByRole("dialog").getByRole("button", { name: "Annuler" }).click();

  // Sélection multiple et actions en masse.
  await page.getByRole("gridcell", { name: "LT 120 GH", exact: true }).click();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  await shot(page, "09-referentiels-selection-actions-en-masse");
  await page.keyboard.press("Escape");

  await page.goto("/referentiels?tab=drivers");
  await expect(page.getByRole("grid", { name: "Chauffeurs" }).getByRole("row")).toHaveCount(15);
  await shot(page, "10-referentiels-chauffeurs-alertes");

  await page.goto("/referentiels?tab=products");
  await expect(page.getByRole("grid", { name: "Produits" }).getByRole("row")).toHaveCount(4);
  await shot(page, "11-referentiels-produits");

  // Import : prévisualisation avec erreurs ligne par ligne.
  await page.goto("/referentiels?tab=stations");
  await page.getByRole("button", { name: "Importer" }).click();
  await page.getByLabel("Choisir un fichier").setInputFiles({
    name: "stations_erreur.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("démo"),
  });
  await page.getByRole("button", { name: "Prévisualiser" }).click();
  await expect(page.getByTestId("import-summary")).toBeVisible();
  await page.getByLabel("Erreurs seulement").uncheck();
  await shot(page, "12-import-previsualisation-erreurs");
  await page.getByRole("dialog").getByRole("button", { name: "Annuler" }).click();

  await page.goto("/administration?tab=users");
  await expect(page.getByRole("grid", { name: "Utilisateurs" }).getByRole("row")).toHaveCount(7);
  await shot(page, "13-administration-utilisateurs");
  await page.getByRole("button", { name: "Nouvel utilisateur" }).click();
  await page.getByRole("button", { name: "Générer" }).click();
  await shot(page, "14-administration-nouvel-utilisateur");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Abandonner" }).click();

  await page.goto("/administration?tab=settings");
  await expect(page.getByLabel(/Vitesse moyenne par défaut/)).toBeVisible();
  await page.getByLabel(/Durée maximale de service/).fill("10,5");
  await page.getByLabel(/Temps d.attente moyen au dépôt/).fill("9999");
  await page.getByLabel(/Vitesse moyenne par défaut/).focus();
  await shot(page, "15-administration-parametres");

  await page.goto("/administration?tab=audit");
  await expect(page.getByRole("grid", { name: "Journal d'audit" }).getByRole("row").nth(1)).toBeVisible();
  await page.getByRole("gridcell", { name: "Modification", exact: true }).first().click();
  await expect(page.getByTestId("audit-diff")).toBeVisible();
  await shot(page, "16-administration-audit-diff");

  // Rôle en lecture seule : navigation filtrée, référentiels non modifiables.
  await page.getByTestId("user-menu").click();
  await page.getByRole("menuitem", { name: "Se déconnecter" }).click();
  await login(page, "direction@ola.example", "demo-dev-only");
  await page.goto("/referentiels?tab=drivers");
  await expect(page.getByText(/Lecture seule/)).toBeVisible();
  await expect(page.getByRole("grid", { name: "Chauffeurs" }).getByRole("row")).toHaveCount(15);
  await shot(page, "17-role-direction-lecture-seule");
});
