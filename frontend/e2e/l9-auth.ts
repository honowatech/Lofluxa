/**
 * Aides de connexion des parcours du socle, tolérantes à la limitation de débit réelle du serveur
 * (10 connexions par minute et par adresse : la suite complète en fait davantage). Sur un 429, on attend
 * le délai annoncé par le serveur puis on recommence — sans désactiver la protection.
 */
import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const API = "http://localhost:8000/api/v1";
export const ADMIN = { email: "admin@honowa.tech", password: "admin-dev-only" };
/** Délai de test à prévoir quand une attente de limitation est possible. */
export const PATIENT_TIMEOUT = 200_000;

export interface Tokens {
  access_token: string;
  refresh_token: string;
}

/** Connexion par l'API ; attend `Retry-After` sur un 429. */
export async function apiLogin(request: APIRequestContext, credentials = ADMIN): Promise<Tokens> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await request.post(`${API}/auth/login`, { data: credentials });
    if (response.status() !== 429) {
      expect(response.status(), "connexion par l'API").toBe(200);
      return (await response.json()) as Tokens;
    }
    const wait = Number(response.headers()["retry-after"] ?? 60);
    await new Promise((resolve) => setTimeout(resolve, (wait + 1) * 1000));
  }
  throw new Error("Connexion impossible : limitation de débit persistante.");
}

/**
 * Soumet le formulaire de connexion. Si l'écran affiche le refus pour trop de tentatives (avec le délai
 * « Nouvel essai possible dans N s. »), attend ce délai et soumet de nouveau.
 */
export async function submitLogin(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel("Adresse e-mail").fill(email);
  await page.getByLabel("Mot de passe", { exact: true }).fill(password);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const answered = page.waitForResponse((response) => response.url().endsWith("/auth/login"));
    await page.getByRole("button", { name: "Se connecter" }).click();
    const response = await answered;
    if (response.status() !== 429) return;
    const notice = page.getByRole("alert").filter({ hasText: "Trop de tentatives" });
    await expect(notice).toContainText(/Nouvel essai possible dans \d+ s\./);
    const seconds = Number(/dans (\d+) s/.exec((await notice.textContent()) ?? "")?.[1] ?? 60);
    await page.waitForTimeout((seconds + 1) * 1000);
  }
  throw new Error("Connexion impossible : limitation de débit persistante.");
}
