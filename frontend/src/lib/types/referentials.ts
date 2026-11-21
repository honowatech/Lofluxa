import type { IsoDate, IsoDateTime, OpeningHours, UUID } from "./common";
import type { CarrierType, DepotOperator, DriverStatus, TruckSize, TruckStatus } from "./enums";

/** Champs communs supposés présents en lecture sur toutes les ressources. */
export interface Timestamps {
  created_at?: IsoDateTime;
  updated_at?: IsoDateTime;
}

export interface Product extends Timestamps {
  id: UUID;
  code: string;
  label: string;
  /** kg/L à 15 °C */
  ref_density_15: number;
  /** coefficient de dilatation par °C (RM-12) */
  thermal_coeff: number;
  color: string;
}
export type ProductInput = Omit<Product, "id" | keyof Timestamps>;

export interface Depot extends Timestamps {
  id: UUID;
  code: string;
  name: string;
  operator: DepotOperator;
  lat: number;
  lon: number;
  address: string | null;
  opening_hours: OpeningHours;
  /** `null` → paramètre `default_depot_wait_min` */
  avg_wait_min: number | null;
  /** `null` → paramètre `default_max_loadings_per_truck_day` */
  max_loadings_per_truck_day: number | null;
  active: boolean;
}
export type DepotInput = Omit<Depot, "id" | keyof Timestamps>;

export interface StationTank {
  id: UUID;
  station_id: UUID;
  product_id: UUID;
  /** Libellés d'affichage renvoyés en lecture. */
  product_code: string;
  product_label: string;
  capacity_l: number;
  safety_stock_l: number;
}
export type StationTankInput = Pick<StationTank, "product_id" | "capacity_l" | "safety_stock_l">;

export interface Station extends Timestamps {
  id: UUID;
  code: string;
  name: string;
  region: string | null;
  city: string | null;
  lat: number;
  lon: number;
  opening_hours: OpeningHours;
  max_truck_size: TruckSize;
  /** `null` → paramètre `default_unload_time_min` */
  unload_time_min: number | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  active: boolean;
  tanks: StationTank[];
}
/** `tanks` fourni = remplacement de la liste (rapprochée par produit) ; absent = inchangée. */
export type StationInput = Omit<Station, "id" | "tanks" | keyof Timestamps> & { tanks?: StationTankInput[] };

export interface Carrier extends Timestamps {
  id: UUID;
  name: string;
  type: CarrierType;
  contact: string | null;
}
export type CarrierInput = Omit<Carrier, "id" | keyof Timestamps>;

export interface TruckCompartment {
  id: UUID;
  truck_id: UUID;
  position: number;
  capacity_l: number;
  /** `null` = tous produits (RM-07) */
  allowed_product_ids: UUID[] | null;
  allowed_product_codes: string[] | null;
}
export type TruckCompartmentInput = Pick<TruckCompartment, "position" | "capacity_l" | "allowed_product_ids">;

export interface Truck extends Timestamps {
  id: UUID;
  plate: string;
  carrier_id: UUID | null;
  carrier_name: string | null;
  carrier_type: CarrierType | null;
  size: TruckSize;
  total_capacity_l: number;
  /** `null` → paramètre `default_avg_speed_kmh` */
  avg_speed_kmh: number | null;
  status: TruckStatus;
  /** FCFA/km, indicatif */
  cost_per_km: number | null;
  notes: string | null;
  compartments: TruckCompartment[];
}
/** `compartments` fourni = remplacement de la liste (rapprochée par position) ; absent = inchangée. */
export type TruckInput = Omit<
  Truck,
  "id" | "compartments" | "carrier_name" | "carrier_type" | keyof Timestamps
> & {
  compartments?: TruckCompartmentInput[];
};

export interface Driver extends Timestamps {
  id: UUID;
  full_name: string;
  phone: string | null;
  license_no: string | null;
  license_expiry: IsoDate | null;
  hazmat_cert: boolean;
  hazmat_expiry: IsoDate | null;
  carrier_id: UUID | null;
  carrier_name: string | null;
  status: DriverStatus;
  default_truck_id: UUID | null;
  default_truck_plate: string | null;
}
export type DriverInput = Omit<Driver, "id" | "carrier_name" | "default_truck_plate" | keyof Timestamps>;
