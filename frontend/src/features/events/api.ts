/**
 * Accès à l'API de l'écran « Journal des événements » (routes du lot L10, `backend/app/events/router.py`).
 * Tous les types viennent de l'OpenAPI générée (`@/lib/types/api.gen`).
 *
 *   GET  /events?day=&type=&trip_id=&plan_id=           → Page[EventOut]
 *   GET  /events/replacement-options?trip_id=&replacement_truck_id=&occurred_at= → ReplacementOptionsOut
 *   POST /events/truck-breakdown    {trip_id, replacement_truck_id, replacement_driver_id?, reason?} → EventResultOut
 *   POST /events/driver-unavailable {trip_id, replacement_driver_id, reason?}                        → EventResultOut
 *   POST /events/product-shortage   {depot_id, product_id, new_available_l, day?}  (supply) → ShortageOut
 *   GET  /events/{id}/impact                                                               → ShortageOut
 *   POST /events/{id}/resolve       {resolutions: [{trip_id, action, depot_id?}]} (dispatcher) → ResolveOut
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, fetchAll, type ApiError } from "@/lib/api";
import type { IsoDate, UUID } from "@/lib/types";
import type { components } from "@/lib/types/api.gen";

/* ------------------------------------------------------------------ routes déjà dans api.gen.ts */

export type PlanOut = components["schemas"]["PlanOut"];
export type TripOut = components["schemas"]["TripOut"];
export type PlanStopOut = TripOut["stops"][number];
export type DepotOut = components["schemas"]["DepotOut"];
export type ProductOut = components["schemas"]["ProductOut"];
type PlanSummaryOut = components["schemas"]["PlanSummaryOut"];

/** Tournée d'un plan publié du jour, avec le plan qui la porte. */
export interface PublishedTrip {
  plan_id: UUID;
  plan_version: number;
  trip: TripOut;
}

/** Tournées des plans publiés du jour (`GET /plans?day=&status=published` puis `GET /plans/{id}`). */
export function usePublishedTrips(day: IsoDate, enabled = true) {
  return useQuery<PublishedTrip[], ApiError>({
    queryKey: ["/plans", "published-trips", day],
    enabled,
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const summaries = await fetchAll<PlanSummaryOut>("/plans", { day, status: "published" }, signal);
      const plans = await Promise.all(
        summaries
          .filter((summary) => summary.kind === "computed")
          .map((summary) => api<PlanOut>(`/plans/${summary.id}`, { signal })),
      );
      return plans.flatMap((plan) =>
        [...plan.trips]
          .sort((a, b) => a.seq - b.seq)
          .map((trip) => ({ plan_id: plan.id, plan_version: plan.version, trip })),
      );
    },
  });
}

export function useDepots(enabled = true) {
  return useQuery<DepotOut[], ApiError>({
    queryKey: ["/depots", "all"],
    enabled,
    queryFn: ({ signal }) => fetchAll<DepotOut>("/depots", { sort: "code" }, signal),
    staleTime: 60_000,
  });
}

export function useProducts(enabled = true) {
  return useQuery<ProductOut[], ApiError>({
    queryKey: ["/products", "all"],
    enabled,
    queryFn: ({ signal }) => fetchAll<ProductOut>("/products", { sort: "code" }, signal),
    staleTime: 60_000,
  });
}

/* ------------------------------------------------------------------ journal : EventOut */

type S = components["schemas"];
/** Une ligne du journal de la journée (F6.4). `summary` est toujours fourni par le serveur. */
export type EventOut = S["EventOut"];

export const eventsKey = (day: IsoDate) => ["/events", day] as const;

/** Journal du jour, du plus récent au plus ancien (ordre du serveur), toutes pages réunies. */
export function useEvents(day: IsoDate) {
  return useQuery<EventOut[], ApiError>({
    queryKey: eventsKey(day),
    queryFn: ({ signal }) => fetchAll<EventOut>("/events", { day }, signal),
  });
}

/* ------------------------------------------------------------------ options de remplacement */

export type ReasonOut = S["ReasonOut"];
export type TripBriefOut = S["TripBriefOut"];
export type TruckOptionOut = S["TruckOptionOut"];
export type DriverOptionOut = S["DriverOptionOut"];
export type ReplacementOptionsOut = S["ReplacementOptionsOut"];

/**
 * Camions et chauffeurs possibles pour une tournée. Les chauffeurs sont évalués pour la tournée telle
 * quelle (F6.2) ou, si `replacementTruckId` est donné, pour la tournée de remplacement de ce camion (F6.1).
 */
export function useReplacementOptions(
  tripId: UUID | null,
  replacementTruckId: UUID | null,
  occurredAt: string | null,
  enabled = true,
) {
  return useQuery<ReplacementOptionsOut, ApiError>({
    queryKey: ["/events/replacement-options", tripId, replacementTruckId, occurredAt],
    enabled: enabled && !!tripId,
    queryFn: ({ signal }) =>
      api<ReplacementOptionsOut>("/events/replacement-options", {
        query: {
          trip_id: tripId,
          replacement_truck_id: replacementTruckId ?? undefined,
          occurred_at: occurredAt ?? undefined,
        },
        signal,
      }),
    staleTime: 0,
  });
}

/* ------------------------------------------------------------------ réaffectation */

/** Corps de la spec §9 ; `occurred_at` et `reason` sont des ajouts facultatifs du lot L10 (L10-A6). `publish` n'est jamais envoyé. */
export type TruckBreakdownIn = Pick<S["TruckBreakdownIn"], "trip_id" | "replacement_truck_id"> & {
  replacement_driver_id?: UUID;
  occurred_at?: string;
  reason?: string;
};
export type DriverUnavailableIn = Pick<S["DriverUnavailableIn"], "trip_id" | "replacement_driver_id"> & {
  occurred_at?: string;
  reason?: string;
};

export type RuleIssueOut = S["RuleIssueOut"];
/** État de la version du plan après un événement (RM-18). */
export type PlanResultOut = S["PlanResultOut"];
export type EventResultOut = S["EventResultOut"];

function useAfterEvent() {
  const client = useQueryClient();
  return () =>
    Promise.all(
      ["/events", "/plans", "/loadings", "/events/replacement-options"].map((key) =>
        client.invalidateQueries({ queryKey: [key] }),
      ),
    );
}

export function useTruckBreakdown() {
  const after = useAfterEvent();
  return useMutation<EventResultOut, ApiError, TruckBreakdownIn>({
    mutationFn: (body) => api<EventResultOut>("/events/truck-breakdown", { method: "POST", body }),
    onSuccess: after,
  });
}

export function useDriverUnavailable() {
  const after = useAfterEvent();
  return useMutation<EventResultOut, ApiError, DriverUnavailableIn>({
    mutationFn: (body) => api<EventResultOut>("/events/driver-unavailable", { method: "POST", body }),
    onSuccess: after,
  });
}

/* ------------------------------------------------------------------ pénurie produit (F6.3) */

/**
 * Corps de la spec §9, plus `day` (ajout facultatif L10-A6) : sans lui le serveur prend « aujourd'hui »,
 * alors que l'écran travaille sur le jour J choisi.
 */
export type ProductShortageIn = Pick<
  S["ProductShortageIn"],
  "depot_id" | "product_id" | "new_available_l"
> & {
  day: IsoDate;
};

export type ShortageOut = S["ShortageOut"];
export type ShortageStatus = ShortageOut["status"];
export type ImpactedTripOut = S["ImpactedTripOut"];
export type ShortageAction = ImpactedTripOut["options"][number];
export type ResolveOut = S["ResolveOut"];
/** Décision pour une tournée. Les volumes (`reduce`) et commandes (`postpone`) par défaut sont ceux du serveur. */
export type ShortageResolutionIn = Pick<S["ShortageResolutionIn"], "trip_id" | "action"> & {
  depot_id?: UUID;
};
export interface ResolveIn {
  resolutions: ShortageResolutionIn[];
  occurred_at?: string;
}

export function useProductShortage() {
  const after = useAfterEvent();
  return useMutation<ShortageOut, ApiError, ProductShortageIn>({
    mutationFn: (body) => api<ShortageOut>("/events/product-shortage", { method: "POST", body }),
    onSuccess: after,
  });
}

/** Tournées encore impactées par une pénurie déclarée, options à jour. */
export function useShortageImpact(eventId: UUID | null, enabled = true) {
  return useQuery<ShortageOut, ApiError>({
    queryKey: ["/events", "impact", eventId],
    enabled: enabled && !!eventId,
    queryFn: ({ signal }) => api<ShortageOut>(`/events/${eventId}/impact`, { signal }),
    staleTime: 0,
  });
}

export function useResolveShortage(eventId: UUID | null) {
  const after = useAfterEvent();
  return useMutation<ResolveOut, ApiError, ResolveIn>({
    mutationFn: (body) => api<ResolveOut>(`/events/${eventId}/resolve`, { method: "POST", body }),
    onSuccess: after,
  });
}
