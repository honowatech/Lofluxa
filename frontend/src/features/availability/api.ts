/** Accès à l'API de l'écran Disponibilité du jour (F2.1 à F2.4, routes du lot L4). */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api/client";
import type { ApiError } from "@/lib/api/errors";
import { fetchAll } from "@/lib/api/pagination";
import type { components } from "@/lib/types/api.gen";

type Schemas = components["schemas"];
export type DepotStock = Schemas["DepotStockOut"];
export type DepotStockEntry = Schemas["DepotStockEntryOut"];
export type DepotStockItem = Schemas["DepotStockItemIn"];
export type TruckDay = Schemas["TruckDayOut"];
export type TruckDayItem = Schemas["TruckDayItemIn"];
export type DriverDay = Schemas["DriverDayOut"];
export type DriverDayItem = Schemas["DriverDayItemIn"];

const BASE = "/availability";
const keys = {
  stocks: (day: string) => [BASE, "depot-stocks", day] as const,
  history: (day: string, depotId?: string, productId?: string) =>
    [BASE, "depot-stocks", day, "history", depotId ?? null, productId ?? null] as const,
  trucks: (day: string) => [BASE, "trucks", day] as const,
  drivers: (day: string) => [BASE, "drivers", day] as const,
};

function useInvalidate() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: [BASE] }),
      client.invalidateQueries({ queryKey: ["/availability/summary"] }),
    ]);
}

/** Valeur courante du stock pour chaque (dépôt actif, produit) ; `available_l` nul = non renseigné. */
export function useDepotStocks(day: string) {
  return useQuery<DepotStock[], ApiError>({
    queryKey: keys.stocks(day),
    queryFn: ({ signal }) => fetchAll<DepotStock>(`${BASE}/depot-stocks`, { day }, signal),
  });
}

/** Saisies du jour, de la plus récente à la plus ancienne (toutes, ou celles d'un couple dépôt × produit). */
export function useStockHistory(day: string, target: { depotId?: string; productId?: string } | null) {
  return useQuery<DepotStockEntry[], ApiError>({
    queryKey: keys.history(day, target?.depotId, target?.productId),
    queryFn: ({ signal }) =>
      fetchAll<DepotStockEntry>(
        `${BASE}/depot-stocks/history`,
        { day, depot_id: target?.depotId, product_id: target?.productId },
        signal,
      ),
    enabled: target !== null,
  });
}

export function useSaveStocks(day: string) {
  const invalidate = useInvalidate();
  return useMutation<DepotStock[], ApiError, DepotStockItem[]>({
    mutationFn: (items) =>
      api<DepotStock[]>(`${BASE}/depot-stocks`, { method: "PUT", query: { day }, body: { items } }),
    onSuccess: invalidate,
  });
}

/** Tous les camions avec leur affectabilité pour J (RM-04) et leur chauffeur du jour. */
export function useTruckDays(day: string) {
  return useQuery<TruckDay[], ApiError>({
    queryKey: keys.trucks(day),
    queryFn: ({ signal }) => fetchAll<TruckDay>(`${BASE}/trucks`, { day }, signal),
  });
}

export function useSaveTrucks(day: string) {
  const invalidate = useInvalidate();
  return useMutation<TruckDay[], ApiError, TruckDayItem[]>({
    mutationFn: (items) =>
      api<TruckDay[]>(`${BASE}/trucks`, { method: "PUT", query: { day }, body: { items } }),
    onSuccess: invalidate,
  });
}

/** Tous les chauffeurs avec leur affectabilité pour J (RM-03) et leur camion du jour. */
export function useDriverDays(day: string) {
  return useQuery<DriverDay[], ApiError>({
    queryKey: keys.drivers(day),
    queryFn: ({ signal }) => fetchAll<DriverDay>(`${BASE}/drivers`, { day }, signal),
  });
}

export function useSaveDrivers(day: string) {
  const invalidate = useInvalidate();
  return useMutation<DriverDay[], ApiError, DriverDayItem[]>({
    mutationFn: (items) =>
      api<DriverDay[]>(`${BASE}/drivers`, { method: "PUT", query: { day }, body: { items } }),
    onSuccess: invalidate,
  });
}
