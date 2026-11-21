import type { IsoDateTime, Role, UUID } from "./common";
import type { ImportKind, ImportStatus } from "./enums";

export interface User {
  id: UUID;
  email: string;
  full_name: string;
  role: Role;
  active: boolean;
  last_login_at: IsoDateTime | null;
  created_at?: IsoDateTime;
}
export interface UserCreateInput {
  email: string;
  full_name: string;
  role: Role;
  password: string;
}
/** Mise à jour partielle ; `password` renseigné = réinitialisation du mot de passe par l'administrateur. */
export interface UserUpdateInput {
  full_name?: string;
  role?: Role;
  active?: boolean;
  password?: string;
}

export type SettingValue = string | number | boolean | null;
/** Une entrée de `GET /settings` (forme normalisée par `normalizeSettings`). */
export interface Setting {
  key: string;
  value: SettingValue;
  default_value?: SettingValue;
  description?: string | null;
  updated_at?: IsoDateTime | null;
  updated_by?: UUID | null;
}

export type AuditAction = "insert" | "update" | "delete";
export interface AuditEntry {
  id: UUID;
  table_name: string;
  row_id: string;
  action: AuditAction;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actor_id: UUID | null;
  /** Libellé d'affichage (CONTRATS §7) ; repli sur `actor_id` s'il est absent. */
  actor_name?: string | null;
  at: IsoDateTime;
}

/** Une ligne du rapport d'import (forme normalisée par `normalizeImportBatch`). */
export interface ImportRowReport {
  /** Numéro de ligne dans le fichier (en-tête = ligne 1). */
  row: number;
  status: "ok" | "error" | "warning";
  /** create | update | skip, si le serveur le précise. */
  action?: string | null;
  errors: { field?: string | null; message: string }[];
  /** Données normalisées de la ligne, pour l'aperçu. */
  data?: Record<string, unknown> | null;
}
export interface ImportBatch {
  id: UUID;
  kind: ImportKind;
  filename: string;
  status: ImportStatus;
  row_count: number;
  error_count: number;
  rows: ImportRowReport[];
}
