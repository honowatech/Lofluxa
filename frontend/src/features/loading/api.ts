/** Accès à l'API du chargement (lot L6) : types générés depuis l'OpenAPI, requêtes et écritures de l'écran. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, fetchAll, type ApiError } from "@/lib/api";
import type { components } from "@/lib/types/api.gen";
import type { IsoDate, Page, UUID } from "@/lib/types";

type Schemas = components["schemas"];
export type TripLoading = Schemas["TripLoadingOut"];
export type Loading = Schemas["LoadingOut"];
export type LoadingInput = Schemas["LoadingIn"];
export type TripStatusInput = Schemas["TripStatusIn"];
export type TripStatus = TripLoading["status"];
export type Plan = Schemas["PlanOut"];
export type PlanTrip = Schemas["TripOut"];
export type PlannedLoad = Schemas["LoadOut"];
export type Product = Schemas["ProductOut"];
export type Depot = Schemas["DepotOut"];
export type Station = Schemas["StationOut"];
export type EmailResult = Schemas["LoadingSheetEmailOut"];

export const TRIP_FLOW: readonly TripStatus[] = ["planned", "at_depot", "loaded", "in_progress", "completed"];
/** Statuts dans lesquels le chargement se saisit ou se corrige (question L6-11). */
export const LOADING_EDITABLE: readonly TripStatus[] = ["planned", "at_depot", "loaded"];

const keys = {
  loadings: ["/loadings"] as const,
  loadingList: (day: IsoDate, depotId: UUID | null) => ["/loadings", { day, depotId }] as const,
  loading: (tripId: UUID) => ["/trips", tripId, "loading"] as const,
  plan: (planId: UUID) => ["/plans", planId] as const,
};

/** Tournées publiées du jour, vues du dépôt. */
export function useTripLoadings(day: IsoDate, depotId: UUID | null) {
  return useQuery<TripLoading[], ApiError>({
    queryKey: keys.loadingList(day, depotId),
    queryFn: ({ signal }) =>
      fetchAll<TripLoading>("/loadings", { day, depot_id: depotId ?? undefined }, signal),
  });
}

/** Chargement enregistré d'une tournée (404 `loading_not_found` tant qu'il n'existe pas : non demandé). */
export function useLoading(tripId: UUID, enabled: boolean) {
  return useQuery<Loading, ApiError>({
    queryKey: keys.loading(tripId),
    queryFn: ({ signal }) => api<Loading>(`/trips/${tripId}/loading`, { signal }),
    enabled,
  });
}

/** Plan publié de la tournée : plan de chargement (compartiments planifiés) et arrêts. */
export function usePlan(planId: UUID) {
  return useQuery<Plan, ApiError>({
    queryKey: keys.plan(planId),
    queryFn: ({ signal }) => api<Plan>(`/plans/${planId}`, { signal }),
  });
}

function useAll<T>(path: string) {
  return useQuery<T[], ApiError>({
    queryKey: [path, "all", {}],
    queryFn: ({ signal }) => fetchAll<T>(path, {}, signal),
    staleTime: 5 * 60_000,
  });
}
export const useProducts = () => useAll<Product>("/products");
export const useDepots = () => useAll<Depot>("/depots");
export const useStations = () => useAll<Station>("/stations");

function useRefresh() {
  const client = useQueryClient();
  return (tripId: UUID) =>
    Promise.all([
      client.invalidateQueries({ queryKey: keys.loadings }),
      client.invalidateQueries({ queryKey: keys.loading(tripId) }),
      client.invalidateQueries({ queryKey: ["/plans"] }),
      client.invalidateQueries({ queryKey: ["/events"] }),
    ]);
}

export function useSaveLoading(tripId: UUID) {
  const client = useQueryClient();
  const refresh = useRefresh();
  return useMutation<Loading, ApiError, LoadingInput>({
    mutationFn: (input) => api<Loading>(`/trips/${tripId}/loading`, { method: "POST", body: input }),
    onSuccess: (loading) => {
      client.setQueryData(keys.loading(tripId), loading);
      return refresh(tripId);
    },
    onError: () => refresh(tripId),
  });
}

export function useChangeStatus(tripId: UUID) {
  const refresh = useRefresh();
  return useMutation<TripLoading, ApiError, TripStatusInput>({
    mutationFn: (input) => api<TripLoading>(`/trips/${tripId}/status`, { method: "PUT", body: input }),
    onSettled: () => refresh(tripId),
  });
}

export function useEmailSheet(tripId: UUID) {
  return useMutation<EmailResult, ApiError, string[] | null>({
    mutationFn: (recipients) =>
      api<EmailResult>(`/trips/${tripId}/loading-sheet/email`, {
        method: "POST",
        body: recipients ? { recipients } : {},
      }),
  });
}

export type { Page };
