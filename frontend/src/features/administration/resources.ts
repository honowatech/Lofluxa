import { createResource } from "@/lib/api/resource";
import type { AuditEntry, User, UserCreateInput, UserUpdateInput } from "@/lib/types";

/** `CRUD /users` (lot L8). La mise à jour accepte `password` pour réinitialiser le mot de passe. */
export const users = createResource<User, UserCreateInput & UserUpdateInput>("/users");

/** `GET /audit?table=&row_id=&actor_id=&from=&to=` (lot L8) — lecture seule. */
export const audit = createResource<AuditEntry, never>("/audit");

/** Tables tracées (F9.3). */
export const AUDITED_TABLES = ["plans", "trips", "loadings", "stocks", "settings"] as const;
