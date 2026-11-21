/**
 * Point d'entrée unique des types de l'API.
 * Les types de ressources sont des alias des schémas générés depuis l'OpenAPI réelle (`api.gen.ts`).
 * Pour un schéma sans alias : `Schema<"OrderOut">` (ou `components["schemas"][…]`).
 * Régénérer après toute évolution de l'API : `./scripts/gen_api_types.sh` (voir README).
 */
export * from "./common";
export * from "./enums";
export * from "./auth";
export * from "./referentials";
export * from "./admin";
export type { Refine, Schema, Schemas } from "./schemas";
export type { components, operations, paths } from "./api.gen";
