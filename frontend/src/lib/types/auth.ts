import type { Schema } from "./schemas";

/** `POST /auth/login`, `POST /auth/refresh`. */
export type TokenPair = Schema<"TokenOut">;

/** `GET /me`. */
export type Me = Schema<"MeOut">;
