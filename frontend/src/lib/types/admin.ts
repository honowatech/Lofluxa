/** Administration (lot L8) et imports (lot L3) : alias des schémas générés. */
import type { Refine, Schema } from "./schemas";

export type User = Schema<"UserOut">;
export type UserCreateInput = Schema<"UserCreate">;
/** `PUT /users/{id}` : mise à jour partielle. Le mot de passe passe par `POST /users/{id}/reset-password`. */
export type UserUpdateInput = Schema<"UserUpdate">;

export type SettingValue = string | number | boolean | null;
/** Type déclaré par le serveur (`admin/settings_spec.py`). */
export type SettingType = "int" | "float" | "str" | "bool" | "time" | "timezone" | "json";
/** Une entrée de `GET /settings`. L'OpenAPI ne type ni la valeur ni le nom du type : précisés ici. */
export type Setting = Refine<
  Schema<"SettingOut">,
  { value: SettingValue; default: SettingValue; type: SettingType; nullable?: boolean }
>;

export type AuditAction = "insert" | "update" | "delete";
export type AuditEntry = Refine<
  Schema<"AuditEntryOut">,
  { action: AuditAction; before: Record<string, unknown> | null; after: Record<string, unknown> | null }
>;

/** Anomalie d'un fichier importé : ligne (`null` ou absente = fichier entier), colonne, valeur fautive, message. */
export type ImportIssue = Schema<"RowIssue">;
export type ImportFieldChange = Schema<"FieldChange">;
/** Effet annoncé d'un enregistrement du fichier. */
export type ImportItem = Schema<"ImportItem">;
export type ImportSummary = Schema<"ImportSummary">;
/** Réponse de `preview`, `apply` et `GET /imports/{id}`. `can_apply` fait foi. */
export type ImportBatch = Schema<"ImportBatchOut">;

/** @deprecated Ancienne forme supposée du rapport d'import ; utiliser `ImportItem` / `ImportIssue` (ou `importReportRows`). */
export interface ImportRowReport {
  row: number;
  status: "ok" | "error" | "warning";
  action?: string | null;
  errors: { field?: string | null; message: string }[];
  data?: Record<string, unknown> | null;
}
