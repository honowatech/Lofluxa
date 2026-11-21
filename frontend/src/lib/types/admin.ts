import type { IsoDateTime, Role, UUID } from "./common";
import type { ImportKind, ImportStatus } from "./enums";

export interface User {
  id: UUID;
  email: string;
  full_name: string;
  role: Role;
  active: boolean;
  last_login_at: IsoDateTime | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}
export interface UserCreateInput {
  email: string;
  full_name: string;
  role: Role;
  password: string;
  active?: boolean;
}
/** `PUT /users/{id}` : mise à jour partielle. Le mot de passe passe par `POST /users/{id}/reset-password`. */
export interface UserUpdateInput {
  email?: string;
  full_name?: string;
  role?: Role;
  active?: boolean;
}

export type SettingValue = string | number | boolean | null;
/** Type déclaré par le serveur (`admin/settings_spec.py`). */
export type SettingType = "int" | "float" | "str" | "bool" | "time" | "timezone" | "json";
/** Une entrée de `GET /settings` (`SettingOut`). */
export interface Setting {
  key: string;
  value: SettingValue;
  default: SettingValue;
  description: string;
  type: SettingType;
  min?: number | null;
  max?: number | null;
  nullable?: boolean;
  is_default: boolean;
  updated_by?: UUID | null;
  updated_by_name?: string | null;
  updated_at?: IsoDateTime | null;
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
  actor_name: string | null;
  actor_email: string | null;
  at: IsoDateTime;
}

/** Anomalie d'un fichier importé (`RowIssue`). */
export interface ImportIssue {
  /** Numéro de ligne dans le fichier ; `null` = anomalie du fichier entier (colonne manquante…). */
  row: number | null;
  column: string | null;
  value: string | null;
  message: string;
  severity: "error" | "warning";
}
export interface ImportFieldChange {
  field: string;
  label: string;
  before: unknown;
  after: unknown;
}
/** Effet annoncé d'un enregistrement du fichier (`ImportItem`). */
export interface ImportItem {
  row: number | null;
  key: string;
  label: string;
  action: "create" | "update" | "unchanged";
  changes: ImportFieldChange[];
}
export interface ImportSummary {
  created: number;
  updated: number;
  unchanged: number;
  errors: number;
  warnings: number;
}
/** `ImportBatchOut` : réponse de `preview`, `apply` et `GET /imports/{id}`. */
export interface ImportBatch {
  id: UUID;
  batch_id: UUID;
  kind: ImportKind;
  filename: string;
  status: ImportStatus;
  row_count: number;
  error_count: number;
  /** Faux si le lot contient des erreurs, a déjà été appliqué ou a été rejeté. */
  can_apply: boolean;
  created_at: IsoDateTime;
  created_by: UUID | null;
  report: { summary: ImportSummary; issues: ImportIssue[]; items: ImportItem[] };
}
