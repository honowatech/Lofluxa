/** Accès à l'API du suivi des livraisons (lot L6, F7.4) : types générés, requêtes et écritures de l'écran. */
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, fetchAll, type ApiError } from "@/lib/api";
import type { components } from "@/lib/types/api.gen";
import type { IsoDate, UUID } from "@/lib/types";

type Schemas = components["schemas"];
export type TripSummary = Schemas["TripLoadingOut"];
export type TripStatus = TripSummary["status"];
export type Plan = Schemas["PlanOut"];
export type PlanTrip = Schemas["TripOut"];
export type PlanStop = PlanTrip["stops"][number];
export type StopDeliveryInput = Schemas["StopDeliveryIn"];
export type StopResult = Schemas["DeliveryStopOut"];
export type TripStatusInput = Schemas["TripStatusIn"];

export const TRIP_FLOW: readonly TripStatus[] = ["planned", "at_depot", "loaded", "in_progress", "completed"];

/** Tournées des plans publiés du jour (même route que la vue Fleet : statut, avancement des arrêts). */
export function useTrips(day: IsoDate) {
  return useQuery<TripSummary[], ApiError>({
    queryKey: ["/loadings", { day, depotId: null }],
    queryFn: ({ signal }) => fetchAll<TripSummary>("/loadings", { day }, signal),
  });
}

/** Plans publiés des tournées du jour : arrêts, commandes, heures prévues et réelles. */
export function usePlans(planIds: UUID[]) {
  return useQueries({
    queries: planIds.map((planId) => ({
      queryKey: ["/plans", planId],
      queryFn: ({ signal }: { signal: AbortSignal }) => api<Plan>(`/plans/${planId}`, { signal }),
    })),
    combine: (results) => ({
      trips: new Map(
        results
          .flatMap((result) => (result.data as Plan | undefined)?.trips ?? [])
          .map((trip) => [trip.id, trip]),
      ),
      isLoading: results.some((result) => result.isLoading),
      error: (results.find((result) => result.error)?.error ?? null) as ApiError | null,
      refetch: () => results.forEach((result) => void result.refetch()),
    }),
  });
}

function useRefresh() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ["/loadings"] }),
      client.invalidateQueries({ queryKey: ["/plans"] }),
      client.invalidateQueries({ queryKey: ["/orders"] }),
      client.invalidateQueries({ queryKey: ["/events"] }),
    ]);
}

/** Arrêt livré (heures et volumes par commande) ou sauté (motif). */
export function useRecordDelivery(stopId: UUID) {
  const refresh = useRefresh();
  return useMutation<StopResult, ApiError, StopDeliveryInput>({
    mutationFn: (input) => api<StopResult>(`/stops/${stopId}/delivery`, { method: "PUT", body: input }),
    onSettled: refresh,
  });
}

/** Clôture : `completed` avec heure de retour et kilomètres réels. */
export function useCloseTrip(tripId: UUID) {
  const refresh = useRefresh();
  return useMutation<TripSummary, ApiError, TripStatusInput>({
    mutationFn: (input) => api<TripSummary>(`/trips/${tripId}/status`, { method: "PUT", body: input }),
    onSettled: refresh,
  });
}
