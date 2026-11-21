/** Miroir de backend/app/core/enums.py. */

export const DEPOT_OPERATORS = ["scdp", "internal", "third_party"] as const;
export type DepotOperator = (typeof DEPOT_OPERATORS)[number];

export const CARRIER_TYPES = ["own", "third_party"] as const;
export type CarrierType = (typeof CARRIER_TYPES)[number];

export const TRUCK_SIZES = ["small", "medium", "large"] as const;
export type TruckSize = (typeof TRUCK_SIZES)[number];

export const TRUCK_STATUSES = ["available", "maintenance", "broken", "reserved"] as const;
export type TruckStatus = (typeof TRUCK_STATUSES)[number];

export const DRIVER_STATUSES = ["available", "rest", "leave", "sick"] as const;
export type DriverStatus = (typeof DRIVER_STATUSES)[number];

export const ORDER_PRIORITIES = ["normal", "urgent"] as const;
export type OrderPriority = (typeof ORDER_PRIORITIES)[number];

export const ORDER_STATUSES = [
  "draft",
  "confirmed",
  "planned",
  "loaded",
  "delivered",
  "cancelled",
  "postponed",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PLAN_KINDS = ["computed", "manual_reference", "replay"] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];

export const PLAN_STATUSES = ["draft", "published", "archived"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const TRIP_STATUSES = ["planned", "at_depot", "loaded", "in_progress", "completed"] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

export const STOP_STATUSES = ["pending", "delivered", "skipped"] as const;
export type StopStatus = (typeof STOP_STATUSES)[number];

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

export const IMPORT_KINDS = ["stations", "trucks", "drivers", "depots", "orders", "reference_day"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const IMPORT_STATUSES = ["previewed", "applied", "rejected"] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];
