/**
 * Accès aux schémas générés depuis l'OpenAPI réelle (`api.gen.ts`, produit par `scripts/gen_api_types.sh`).
 * Les types de `@/lib/types` sont des alias de ces schémas : après une évolution de l'API, régénérer le
 * fichier suffit — une incompatibilité apparaît à la compilation.
 */
import type { components } from "./api.gen";

export type Schemas = components["schemas"];
export type Schema<K extends keyof Schemas> = Schemas[K];

/** Remplace le type de certains champs (précision que l'OpenAPI ne porte pas : horaires, valeurs de paramètre…). */
export type Refine<T, R> = Omit<T, keyof R> & R;
