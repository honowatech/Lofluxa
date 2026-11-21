/** Accès à l'API de l'écran Commandes du jour (routes du lot L4). */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, type Query } from "@/lib/api/client";
import type { ApiError } from "@/lib/api/errors";
import { fetchAll } from "@/lib/api/pagination";
import { createResource } from "@/lib/api/resource";
import type { components } from "@/lib/types/api.gen";

type Schemas = components["schemas"];
export type Order = Schemas["OrderOut"];
export type OrderInput = Schemas["OrderIn"];
export type OrderPatch = Schemas["OrderPatch"];
export type OrderWarning = Schemas["OrderWarning"];
export type OrderStatus = Schemas["OrderStatus"];
export type BulkConfirmResult = Schemas["BulkConfirmOut"];
export type Station = Schemas["StationOut"];
export type Product = Schemas["ProductOut"];

/** Statuts dans lesquels une commande reste modifiable (question L4-1). */
export const EDITABLE_STATUSES: readonly OrderStatus[] = ["draft", "confirmed"];
export const isEditable = (order: Pick<Order, "status">) => EDITABLE_STATUSES.includes(order.status);

export const stations = createResource<Station>("/stations");
export const products = createResource<Product>("/products");

export interface OrderFilters {
  station_id?: string;
  product_id?: string;
  status?: string;
  priority?: string;
}

const ORDERS = "/orders";

/**
 * Toutes les commandes du jour qui passent les filtres (appliqués par le serveur). Le tri, la recherche et la
 * pagination sont faits par le tableau : `GET /orders` ne trie pas, et les totaux portent sur toute la liste.
 */
export function useOrders(day: string, filters: OrderFilters) {
  const query: Query = { day, ...filters };
  return useQuery<Order[], ApiError>({
    queryKey: [ORDERS, "all", query],
    queryFn: ({ signal }) => fetchAll<Order>(ORDERS, query, signal),
    placeholderData: keepPreviousData,
  });
}

/** Erreur `order_exceeds_tank_capacity` (F3.4) : volume recevable par la cuve, s'il est fourni. */
export function capacityMax(error: ApiError): number | null {
  const max = error.details.find((detail) => typeof detail.max_l === "number")?.max_l;
  return typeof max === "number" ? max : null;
}

export function useOrderMutations() {
  const client = useQueryClient();
  const invalidate = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: [ORDERS] }),
      client.invalidateQueries({ queryKey: ["/availability/summary"] }),
    ]);
  const options = { onSuccess: invalidate };
  const transition = (action: "confirm" | "cancel" | "postpone") => (id: string) =>
    api<Order>(`${ORDERS}/${id}/${action}`, { method: "POST" });

  return {
    invalidate,
    create: useMutation<Order, ApiError, OrderInput>({
      mutationFn: (input) => api<Order>(ORDERS, { method: "POST", body: input }),
      ...options,
    }),
    replace: useMutation<Order, ApiError, { id: string; input: OrderInput }>({
      mutationFn: ({ id, input }) => api<Order>(`${ORDERS}/${id}`, { method: "PUT", body: input }),
      ...options,
    }),
    patch: useMutation<Order, ApiError, { id: string; changes: OrderPatch }>({
      mutationFn: ({ id, changes }) => api<Order>(`${ORDERS}/${id}`, { method: "PATCH", body: changes }),
      ...options,
    }),
    remove: useMutation<void, ApiError, string>({
      mutationFn: (id) => api<void>(`${ORDERS}/${id}`, { method: "DELETE" }),
      ...options,
    }),
    /** Suppression de plusieurs brouillons : une requête par ligne, s'arrête à la première erreur. */
    removeMany: useMutation<void, ApiError, string[]>({
      mutationFn: async (ids) => {
        for (const id of ids) await api<void>(`${ORDERS}/${id}`, { method: "DELETE" });
      },
      onSettled: invalidate,
    }),
    confirm: useMutation<Order, ApiError, string>({ mutationFn: transition("confirm"), ...options }),
    cancel: useMutation<Order, ApiError, string>({ mutationFn: transition("cancel"), ...options }),
    postpone: useMutation<Order, ApiError, string>({ mutationFn: transition("postpone"), ...options }),
    confirmMany: useMutation<BulkConfirmResult, ApiError, string[]>({
      mutationFn: (order_ids) =>
        api<BulkConfirmResult>(`${ORDERS}/confirm`, { method: "POST", body: { order_ids } }),
      onSettled: invalidate,
    }),
  };
}
