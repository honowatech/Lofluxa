/**
 * Accès à l'API de l'écran « Journal des événements » — aligné sur les routes RÉELLES du lot L10
 * (`backend/app/events/router.py` et `schemas.py`, commit 1bd8741).
 *
 * Les types ci-dessous sont écrits à la main, à l'identique des schémas Pydantic du lot L10, parce que
 * `src/lib/types/api.gen.ts` ne contient pas encore ces routes :
 * **à remplacer par `components["schemas"][…]` après régénération** (`scripts/gen_api_types.sh`) —
 * les noms sont ceux des schémas (`EventOut`, `EventResultOut`, `ReplacementOptionsOut`, `ShortageOut`…).
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
import type {
  EventType,
  IsoDate,
  IsoDateTime,
  PlanStatus,
  Severity,
  TripStatus,
  TruckSize,
  UUID,
} from "@/lib/types";
import type { components } from "@/lib/types/api.gen";

/* ------------------------------------------------------------------ routes déjà dans api.gen.ts */

export type PlanOut = components["schemas"]["PlanOut"];
export type TripOut = components["schemas"]["TripOut"];
export type PlanStopOut = TripOut["stops"][number];
export type DepotOut = components["schemas"]["DepotOut"];
export type ProductOut = components["schemas"]["ProductOut"];
type PlanSummaryOut = components["schemas"]["app__planning__schemas__PlanSummaryOut"];

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

/** `EventOut` : une ligne du journal de la journée (F6.4). `summary` est toujours fourni par le serveur. */
export interface EventOut {
  id: UUID;
  day: IsoDate;
  type: EventType;
  type_label: string;
  action?: string | null;
  summary: string;
  occurred_at: IsoDateTime;
  actor_id?: UUID | null;
  actor_name?: string | null;
  plan_id?: UUID | null;
  plan_version?: number | null;
  trip_id?: UUID | null;
  trip_seq?: number | null;
  truck_plate?: string | null;
  payload: Record<string, unknown>;
}

export const eventsKey = (day: IsoDate) => ["/events", day] as const;

/** Journal du jour, du plus récent au plus ancien (ordre du serveur), toutes pages réunies. */
export function useEvents(day: IsoDate) {
  return useQuery<EventOut[], ApiError>({
    queryKey: eventsKey(day),
    queryFn: ({ signal }) => fetchAll<EventOut>("/events", { day }, signal),
  });
}

/* ------------------------------------------------------------------ options de remplacement */

export interface ReasonOut {
  rule_code?: string | null;
  message: string;
}
export interface TripBriefOut {
  trip_id: UUID;
  source_trip_id: UUID;
  plan_id: UUID;
  plan_version: number;
  plan_status: PlanStatus;
  seq: number;
  status: TripStatus;
  truck_id: UUID;
  truck_plate?: string | null;
  driver_id?: UUID | null;
  driver_name?: string | null;
  depot_id: UUID;
  depot_code?: string | null;
  pending_stops: number;
  delivered_stops: number;
  skipped_stops: number;
  pending_l: number;
  pending_station_codes: string[];
  can_replace_truck: boolean;
  can_replace_driver: boolean;
  blocked_reason?: string | null;
}
export interface TruckOptionOut {
  truck_id: UUID;
  plate: string;
  size: TruckSize;
  carrier_name?: string | null;
  total_capacity_l: number;
  assigned_driver_id?: UUID | null;
  assigned_driver_name?: string | null;
  other_trip_seqs: number[];
  eligible: boolean;
  reasons: ReasonOut[];
  suggested_driver_id?: UUID | null;
  suggested_driver_name?: string | null;
  driver_required: boolean;
}
export interface DriverOptionOut {
  driver_id: UUID;
  full_name: string;
  phone?: string | null;
  carrier_name?: string | null;
  assigned_truck_id?: UUID | null;
  assigned_truck_plate?: string | null;
  other_trip_seqs: number[];
  is_current: boolean;
  eligible: boolean;
  reasons: ReasonOut[];
}
export interface ReplacementOptionsOut {
  trip: TripBriefOut;
  occurred_at: IsoDateTime;
  drivers_evaluated_for_truck_id: UUID;
  trucks: TruckOptionOut[];
  drivers: DriverOptionOut[];
}

/**
 * Camions et chauffeurs possibles pour une tournée. Les chauffeurs sont évalués pour la tournée telle
 * quelle (F6.2) ou, si `replacementTruckId` est donné, pour la tournée de remplacement de ce camion (F6.1).
 */
export function useReplacementOptions(tripId: UUID | null, replacementTruckId: UUID | null, enabled = true) {
  return useQuery<ReplacementOptionsOut, ApiError>({
    queryKey: ["/events/replacement-options", tripId, replacementTruckId],
    enabled: enabled && !!tripId,
    queryFn: ({ signal }) =>
      api<ReplacementOptionsOut>("/events/replacement-options", {
        query: { trip_id: tripId, replacement_truck_id: replacementTruckId ?? undefined },
        signal,
      }),
    staleTime: 0,
  });
}

/* ------------------------------------------------------------------ réaffectation */

/** Corps de la spec §9 ; `reason` est un ajout facultatif du lot L10 (L10-A6). */
export interface TruckBreakdownIn {
  trip_id: UUID;
  replacement_truck_id: UUID;
  replacement_driver_id?: UUID;
  reason?: string;
}
export interface DriverUnavailableIn {
  trip_id: UUID;
  replacement_driver_id: UUID;
  reason?: string;
}

export interface RuleIssueOut {
  rule_code: string;
  severity: Severity;
  message: string;
  trip_id?: UUID | null;
  trip_seq?: number | null;
}
/** `PlanResultOut` : état de la version du plan après un événement (RM-18). */
export interface PlanResultOut {
  plan_id: UUID;
  plan_version: number;
  plan_status: PlanStatus;
  published: boolean;
  version_created: boolean;
  previous_plan_id?: UUID | null;
  previous_plan_version?: number | null;
  previous_plan_status?: PlanStatus | null;
  blocking_count: number;
  warning_count: number;
  violations: RuleIssueOut[];
  plan: PlanOut;
}
export interface OtherTripOut {
  trip_id: UUID;
  seq: number;
  status: TripStatus;
  pending_stops: number;
}
export interface EventResultOut extends PlanResultOut {
  event: EventOut;
  source_trip_id: UUID;
  origin_trip_id?: UUID | null;
  new_trip_id?: UUID | null;
  trip_id: UUID;
  truck_id: UUID;
  driver_id?: UUID | null;
  transferred_stop_ids: UUID[];
  kept_stop_ids: UUID[];
  other_impacted_trips: OtherTripOut[];
}

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
export interface ProductShortageIn {
  depot_id: UUID;
  product_id: UUID;
  new_available_l: number;
  day?: IsoDate;
}

export type ShortageAction = "reduce" | "postpone" | "change_depot";
export type ShortageStatus = "open" | "resolved" | "no_impact";

export interface ShortageOrderOut {
  order_id: UUID;
  stop_id: UUID;
  station_code?: string | null;
  station_name?: string | null;
  planned_l: number;
  requested_l?: number | null;
  priority?: string | null;
}
export interface AlternativeDepotOut {
  depot_id: UUID;
  code: string;
  name: string;
  available_l?: number | null;
  planned_l: number;
  remaining_l?: number | null;
  sufficient?: boolean | null;
}
export interface ImpactedTripOut {
  plan_id: UUID;
  plan_version: number;
  plan_status: PlanStatus;
  trip_id: UUID;
  trip_seq: number;
  status: TripStatus;
  truck_plate?: string | null;
  driver_name?: string | null;
  planned_start_at?: IsoDateTime | null;
  planned_l: number;
  covered_l: number;
  shortfall_l: number;
  options: ShortageAction[];
  orders: ShortageOrderOut[];
  alternative_depots: AlternativeDepotOut[];
  resolution?: Record<string, unknown> | null;
}
export interface ShortageOut {
  event: EventOut;
  status: ShortageStatus;
  day: IsoDate;
  depot_id: UUID;
  depot_code: string;
  product_id: UUID;
  product_code: string;
  previous_available_l?: number | null;
  new_available_l: number;
  loaded_l: number;
  remaining_l: number;
  planned_unloaded_l: number;
  shortfall_l: number;
  impacted_trips: ImpactedTripOut[];
}

/** Décision du dispatcher pour une tournée. Les volumes (`reduce`) et commandes (`postpone`) par défaut sont ceux du serveur. */
export interface ShortageResolutionIn {
  trip_id: UUID;
  action: ShortageAction;
  depot_id?: UUID;
}
export interface ResolveIn {
  resolutions: ShortageResolutionIn[];
}
export interface ResolveOut extends ShortageOut {
  results: PlanResultOut[];
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
