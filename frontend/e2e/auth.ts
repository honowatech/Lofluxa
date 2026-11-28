/**
 * Aide de connexion COMMUNE à tous les parcours (`pnpm e2e`, vraie API).
 *
 *   import { ADMIN, openSession, fetchTokens, submitLogin } from "./auth";
 *
 *   await openSession(page);                       // admin du seed, session ouverte sans passer par le formulaire
 *   await openSession(page, { email, password });  // un autre compte
 *   const { access_token } = await fetchTokens();  // jeton pour préparer des données par l'API
 *   await submitLogin(page, email, password);      // le formulaire lui-même (réservé aux parcours de connexion)
 *
 * Pourquoi par jeton : seul le parcours de connexion a besoin du formulaire ; les autres gagnent du temps et
 * ne dépendent pas de l'écran de connexion. L'API des parcours tourne sans limitation de débit
 * (`TOURNEO_RATE_LIMIT_ENABLED=false`, vérifié par `prerequis.setup.ts`) ; si un 429 survient malgré tout,
 * ces aides attendent le délai annoncé par le serveur au lieu d'échouer.
 */
import { expect, type Page } from "@playwright/test";

export const API = "http://localhost:8000/api/v1";
/** Compte créé par le seed (`./scripts/dev_setup.sh`). */
export const ADMIN = { email: "admin@honowa.tech", password: "admin-dev-only" };
/** Clé de stockage des jetons de l'application (`src/lib/auth/tokens.ts`). */
export const TOKENS_KEY = "tourneo.tokens";

export interface Credentials {
  email: string;
  password: string;
}
export interface Tokens {
  access_token: string;
  refresh_token: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Connexion par l'API : renvoie une paire de jetons neuve (une connexion par appel, aucune session partagée). */
export async function fetchTokens(credentials: Credentials = ADMIN): Promise<Tokens> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
    });
    if (response.status === 429) {
      await sleep((Number(response.headers.get("retry-after") ?? 60) + 1) * 1000);
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `Connexion de ${credentials.email} refusée par l'API (HTTP ${response.status}) : ${await response.text()}`,
      );
    }
    const pair = (await response.json()) as Tokens;
    return { access_token: pair.access_token, refresh_token: pair.refresh_token };
  }
  throw new Error(
    "Connexion impossible : limitation de débit persistante (voir frontend/README.md, « e2e »).",
  );
}

/**
 * Ouvre une session dans la page sans passer par le formulaire : les jetons sont déposés dans le stockage
 * de l'application avant son premier chargement. À appeler AVANT `page.goto(...)`.
 * Le dépôt n'a lieu qu'une fois par onglet : une déconnexion faite ensuite par le parcours reste effective.
 */
export async function openSession(page: Page, credentials: Credentials = ADMIN): Promise<Tokens> {
  const tokens = await fetchTokens(credentials);
  await page.addInitScript(
    ([key, value]) => {
      if (window.sessionStorage.getItem("e2e.session")) return;
      window.sessionStorage.setItem("e2e.session", "1");
      window.localStorage.setItem(key, value);
    },
    [TOKENS_KEY, JSON.stringify(tokens)] as const,
  );
  return tokens;
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
