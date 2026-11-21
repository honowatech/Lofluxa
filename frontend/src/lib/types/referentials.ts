/** Référentiels (lot L3) : alias des schémas générés, avec les horaires d'ouverture typés précisément. */
import type { OpeningHours } from "./common";
import type { Refine, Schema } from "./schemas";

type Hours = { opening_hours: OpeningHours };
type OptionalHours = { opening_hours?: OpeningHours };

export type Product = Schema<"ProductOut">;
export type ProductInput = Schema<"ProductCreate">;

export type Depot = Refine<Schema<"DepotOut">, Hours>;
export type DepotInput = Refine<Schema<"DepotCreate">, OptionalHours>;

export type StationTank = Schema<"TankOut">;
export type StationTankInput = Schema<"TankCreate">;

export type Station = Refine<Schema<"StationOut">, Hours>;
/** `tanks` fourni = remplacement de la liste (rapprochée par produit) ; absent = inchangée. */
export type StationInput = Refine<Schema<"StationCreate">, OptionalHours>;

export type Carrier = Schema<"CarrierOut">;
export type CarrierInput = Schema<"CarrierCreate">;

export type TruckCompartment = Schema<"CompartmentOut">;
export type TruckCompartmentInput = Schema<"CompartmentCreate">;

export type Truck = Schema<"TruckOut">;
/** `compartments` fourni = remplacement de la liste (rapprochée par position) ; absent = inchangée. */
export type TruckInput = Schema<"TruckCreate">;

export type Driver = Schema<"DriverOut">;
export type DriverInput = Schema<"DriverCreate">;

/** @deprecated Les schémas générés déclarent eux-mêmes leurs horodatages ; conservé pour compatibilité. */
export interface Timestamps {
  created_at?: string;
  updated_at?: string;
}
