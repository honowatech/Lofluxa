/** Constantes de configuration du front. Les valeurs métier paramétrables vivent côté serveur (`/settings`). */

/** Préfixe de l'API (proxy Vite en développement, Caddy en production). */
export const API_BASE = "/api/v1";

/** Fuseau d'affichage (RM-20). Aligné sur le paramètre serveur `timezone`. */
export const APP_TIMEZONE = "Africa/Douala";

/** Taille de page par défaut des tableaux (le serveur accepte 1 à 500). */
export const DEFAULT_PAGE_SIZE = 50;
export const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];
export const MAX_PAGE_SIZE = 500;

/**
 * Délai (jours) en dessous duquel un permis ou une habilitation est signalé « expire bientôt ».
 * Absent de `settings_store.DEFAULTS` : question L9-Q3 (docs/questions/l9-frontend.md).
 * Simple aide visuelle, sans effet sur les règles (RM-03 est contrôlée par le serveur).
 */
export const EXPIRY_WARNING_DAYS = 30;

export type MocksMode = "off" | "partial" | "full";
export const MOCKS_MODE: MocksMode = (import.meta.env.VITE_MOCKS as MocksMode | undefined) ?? "off";

export const TILES_URL: string = import.meta.env.VITE_TILES_URL ?? "";
export const TILES_ATTRIBUTION: string = import.meta.env.VITE_TILES_ATTRIBUTION ?? "";

/** Centre par défaut de la carte quand il n'y a rien à cadrer : Douala. */
export const DEFAULT_MAP_CENTER = { lat: 4.0511, lon: 9.7679 };
