/** Types de l'écran Plan : alias des types générés depuis l'OpenAPI (jamais réécrits à la main). */
import type { components } from "@/lib/types/api.gen";

type Schemas = components["schemas"];

export type Plan = Schemas["PlanOut"] & { display_label?: string | null; is_current?: boolean | null };
/**
 * Résumé d'un plan (`GET /plans`). `display_label` (libellé prêt à afficher) et `is_current` (plan en vigueur)
 * sont ajoutés par le lot L5 : l'écran les utilise s'ils sont présents et se replie sinon sur
 * `kind` / `status` / `version` / `label`.
 */
export type PlanSummary = Schemas["PlanSummaryOut"] & {
  display_label?: string | null;
  is_current?: boolean | null;
};
export type Trip = Schemas["TripOut"];
export type Stop = Trip["stops"][number];
export type Delivery = Schemas["DeliveryOut"];
export type Load = Schemas["LoadOut"];
export type Unserved = Plan["unserved"][number];
export type PlanViolation = Schemas["ViolationOut"];
export type PlanVersion = Schemas["VersionOut"];
export type VersionChange = Schemas["VersionChangeOut"];
export type TaskStatus = Schemas["TaskOut"];
export type TaskAccepted = Schemas["TaskAccepted"];
export type TruckDay = Schemas["TruckDayOut"];
export type DriverDay = Schemas["DriverDayOut"];
export type UnservedReason = Schemas["UnservedReason"];
export type PlanKind = Schemas["PlanKind"];
export type PlanEvent = Schemas["EventOut"];

/** Modification manuelle d'un plan (F5.1, F5.3) : une opération = un appel à l'API. */
export type EditOp =
  | { type: "move"; tripId: string; stopId: string; toTripId: string; toSeq: number }
  | { type: "reorder"; tripId: string; stopIds: string[] }
  | {
      type: "assign";
      tripId: string;
      truck?: { id: string; plate: string; size?: Trip["truck_size"]; capacity_l?: number | null };
      /** `null` retire le chauffeur de la tournée. */
      driver?: { id: string; name: string; phone?: string | null } | null;
    }
  | { type: "lock"; tripId: string; locked: boolean };

export type PlanView = "map" | "table";
