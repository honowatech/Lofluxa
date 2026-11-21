/**
 * Énumérations de l'API. Les types viennent des schémas générés ; les listes (nécessaires à l'exécution :
 * listes déroulantes, filtres) sont contrôlées par `satisfies` : une valeur ajoutée ou retirée côté serveur
 * se voit à la compilation après régénération des types.
 */
import type { Schema } from "./schemas";

/** Vérifie qu'une liste contient TOUTES les valeurs de l'énumération (et seulement elles). */
type Exhaustive<T extends string, L extends readonly T[]> = [T] extends [L[number]] ? L : never;
const all =
  <T extends string>() =>
  <const L extends readonly T[]>(list: Exhaustive<T, L>) =>
    list;

export type DepotOperator = Schema<"DepotOperator">;
export const DEPOT_OPERATORS = all<DepotOperator>()(["scdp", "internal", "third_party"]);

export type CarrierType = Schema<"CarrierType">;
export const CARRIER_TYPES = all<CarrierType>()(["own", "third_party"]);

export type TruckSize = Schema<"TruckSize">;
export const TRUCK_SIZES = all<TruckSize>()(["small", "medium", "large"]);

export type TruckStatus = Schema<"TruckStatus">;
export const TRUCK_STATUSES = all<TruckStatus>()(["available", "maintenance", "broken", "reserved"]);

export type DriverStatus = Schema<"DriverStatus">;
export const DRIVER_STATUSES = all<DriverStatus>()(["available", "rest", "leave", "sick"]);

export type OrderPriority = Schema<"OrderPriority">;
export const ORDER_PRIORITIES = all<OrderPriority>()(["normal", "urgent"]);

export type OrderStatus = Schema<"OrderStatus">;
export const ORDER_STATUSES = all<OrderStatus>()([
  "draft",
  "confirmed",
  "planned",
  "loaded",
  "delivered",
  "cancelled",
  "postponed",
]);

export type PlanKind = Schema<"PlanKind">;
export const PLAN_KINDS = all<PlanKind>()(["computed", "manual_reference", "replay"]);

export type PlanStatus = Schema<"PlanStatus">;
export const PLAN_STATUSES = all<PlanStatus>()(["draft", "published", "archived"]);

export type TripStatus = Schema<"TripStatus">;
export const TRIP_STATUSES = all<TripStatus>()(["planned", "at_depot", "loaded", "in_progress", "completed"]);

export type StopStatus = Schema<"StopStatus">;
export const STOP_STATUSES = all<StopStatus>()(["pending", "delivered", "skipped"]);

export type ImportKind = Schema<"ImportKind">;
export const IMPORT_KINDS = all<ImportKind>()([
  "stations",
  "trucks",
  "drivers",
  "depots",
  "orders",
  "reference_day",
]);

export type ImportStatus = Schema<"ImportStatus">;
export const IMPORT_STATUSES = all<ImportStatus>()(["previewed", "applied", "rejected"]);

/* Énumérations du back-end qui n'apparaissent pas (encore) comme schémas nommés dans l'OpenAPI. */

export const UNSERVED_REASONS = [
  "no_truck",
  "no_driver",
  "depot_stock",
  "time_window",
  "truck_size",
  "compartment",
  "service_duration",
  "other",
] as const;
export type UnservedReason = (typeof UNSERVED_REASONS)[number];

export const EVENT_TYPES = [
  "truck_breakdown",
  "driver_unavailable",
  "product_shortage",
  "manual_edit",
  "publish",
  "replan",
  "loading_recorded",
  "delivery_recorded",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
