/** Types de l'écran Plan : alias des types générés depuis l'OpenAPI (jamais réécrits à la main). */
import type { components } from "@/lib/types/api.gen";

type Schemas = components["schemas"];

export type Plan = Schemas["PlanOut"];
/** Les noms `PlanSummaryOut`, `StopOut` et `UnservedOut` existent dans plusieurs modules du back-end :
 * l'OpenAPI les préfixe. Les deux derniers sont déduits du plan pour ne pas dépendre de ce préfixe. */
export type PlanSummary = Schemas["PlanSummaryOut"];
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
