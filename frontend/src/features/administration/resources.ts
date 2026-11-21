import { createResource } from "@/lib/api/resource";
import type { AuditEntry, User, UserCreateInput, UserUpdateInput } from "@/lib/types";

/**
 * `/users` (lot L8, réservé à `admin`). Activation, désactivation et réinitialisation du mot de passe
 * passent par `POST /users/{id}/activate|deactivate|reset-password` (voir UsersTab).
 */
export const users = createResource<User, UserCreateInput & UserUpdateInput>("/users");

/** `GET /audit?table=&row_id=&actor_id=&action=&date_from=&date_to=` (lot L8, `admin` et `manager`) — lecture seule. */
export const audit = createResource<AuditEntry, never>("/audit");

/** Tables tracées (F9.3). */
export const AUDITED_TABLES = ["plans", "trips", "loadings", "stocks", "settings"] as const;
