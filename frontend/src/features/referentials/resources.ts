/** Ressources de l'API utilisées par l'écran Référentiels (routes du lot L3). */
import { createResource } from "@/lib/api/resource";
import type {
  Carrier,
  CarrierInput,
  Depot,
  DepotInput,
  Driver,
  DriverInput,
  Product,
  ProductInput,
  Station,
  StationInput,
  Truck,
  TruckInput,
} from "@/lib/types";

export const products = createResource<Product, ProductInput>("/products");
export const depots = createResource<Depot, DepotInput>("/depots");
export const stations = createResource<Station, StationInput>("/stations");
export const carriers = createResource<Carrier, CarrierInput>("/carriers", {
  invalidates: [["/trucks"], ["/drivers"]],
});
export const trucks = createResource<Truck, TruckInput>("/trucks", { invalidates: [["/drivers"]] });
export const drivers = createResource<Driver, DriverInput>("/drivers");
