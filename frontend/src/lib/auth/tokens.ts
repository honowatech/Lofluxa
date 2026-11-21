/**
 * Stockage des jetons JWT (accès 15 min, rafraîchissement 7 jours).
 * `localStorage` : la session survit au rechargement et se partage entre onglets.
 * Module sans dépendance, pour que le client API et le magasin de session puissent tous deux l'utiliser.
 */
import type { TokenPair } from "@/lib/types";

const KEY = "tourneo.tokens";

type Listener = (tokens: StoredTokens | null) => void;
export type StoredTokens = Pick<TokenPair, "access_token" | "refresh_token">;

let cache: StoredTokens | null | undefined;
const listeners = new Set<Listener>();

function read(): StoredTokens | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredTokens>;
    return parsed.access_token && parsed.refresh_token
      ? { access_token: parsed.access_token, refresh_token: parsed.refresh_token }
      : null;
  } catch {
    return null;
  }
}

export function getTokens(): StoredTokens | null {
  if (cache === undefined) cache = read();
  return cache;
}

/** Relit le stockage (un autre onglet a pu rafraîchir les jetons entre-temps). */
export function reloadTokens(): StoredTokens | null {
  cache = read();
  return cache;
}

export function setTokens(tokens: StoredTokens | null): void {
  cache = tokens;
  try {
    if (tokens) window.localStorage.setItem(KEY, JSON.stringify(tokens));
    else window.localStorage.removeItem(KEY);
  } catch {
    // Stockage indisponible (navigation privée stricte) : la session reste en mémoire.
  }
  listeners.forEach((listener) => listener(tokens));
}

export function onTokensChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Synchronisation entre onglets : une déconnexion dans un onglet vaut pour tous. */
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== KEY) return;
    cache = read();
    listeners.forEach((listener) => listener(cache ?? null));
  });
}
