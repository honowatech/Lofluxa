/**
 * Accès à l'API de l'écran « Journal des événements ».
 *
 * ⚠ ROUTES D'ÉVÉNEMENTS NON LIVRÉES (lot L10) — tout ce qui SUPPOSE la forme de leurs réponses est ici,
 * et nulle part ailleurs dans l'écran. Rapprochement à l'intégration : ajuster les types « supposés » et
 * les fonctions `normalize*` de ce fichier (et les doublures de `mocks.ts`), rien d'autre.
 *
 * Certain (spec §9, à la lettre) :
 *   GET  /events?day=
 *   POST /events/truck-breakdown    {trip_id, replacement_truck_id, replacement_driver_id?}
 *   POST /events/driver-unavailable {trip_id, replacement_driver_id}
 *   POST /events/product-shortage   {depot_id, product_id, new_available_l}
 * Certain (modèle `backend/app/events/models.py`) : champs d'un événement
 *   id, day, plan_id, trip_id, type, payload, occurred_at, actor_id.
 * Supposé :
 *   - `GET /events` renvoie une `Page` (CONTRATS §7) avec des libellés (`actor_name`, `trip_seq`, `truck_plate`) ;
 *   - route des options de remplacement : `GET /events/replacement-options?trip_id=&kind=truck|driver` ;
 *   - réponses des trois POST (voir `ReassignmentResult` et `ShortageResult`).
 *
 * Les routes déjà livrées (plans, dépôts, produits) utilisent les types générés depuis l'OpenAPI.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, fetchAll, type ApiError } from "@/lib/api";
import type { EventType, IsoDate, IsoDateTime, UUID } from "@/lib/types";
import type { components } from "@/lib/types/api.gen";

/* ------------------------------------------------------------------ routes livrées (types générés) */

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
    queryFn: async ({ signal }) => {
      const summaries = await fetchAll<PlanSummaryOut>("/plans", { day, status: "published" }, signal);
      const plans = await Promise.all(
        summaries.map((summary) => api<PlanOut>(`/plans/${summary.id}`, { signal })),
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

/* ------------------------------------------------------------------ GET /events (forme supposée) */

/** Événement du journal. Les six premiers champs suivent le modèle ; les libellés sont supposés. */
export interface EventItem {
  id: UUID;
  day: IsoDate;
  plan_id: UUID | null;
  trip_id: UUID | null;
  type: EventType;
  payload: Record<string, unknown>;
  occurred_at: IsoDateTime;
  actor_id: UUID | null;
  /** Supposé (CONTRATS §7 : « libellés utiles à l'affichage »). */
  actor_name: string | null;
  trip_seq: number | null;
  truck_plate: string | null;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function normalizeEvent(raw: unknown): EventItem {
  const row = isRecord(raw) ? raw : {};
  const payload = isRecord(row.payload) ? row.payload : {};
  return {
    id: String(row.id),
    day: String(row.day ?? ""),
    plan_id: str(row.plan_id),
    trip_id: str(row.trip_id),
    type: String(row.type) as EventType,
    payload,
    occurred_at: String(row.occurred_at ?? row.created_at ?? ""),
    actor_id: str(row.actor_id),
    actor_name: str(row.actor_name) ?? str(payload.actor_name),
    trip_seq: num(row.trip_seq) ?? num(payload.trip_seq),
    truck_plate: str(row.truck_plate) ?? str(payload.truck_plate),
  };
}

/** Accepte une `Page` ou une simple liste ; renvoie le fil du plus récent au plus ancien. */
export function normalizeEvents(raw: unknown): EventItem[] {
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.items) ? raw.items : [];
  return list.map(normalizeEvent).sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
}

const EVENTS_PAGE_SIZE = 200;

export const eventsKey = (day: IsoDate) => ["/events", day] as const;

export function useEvents(day: IsoDate) {
  return useQuery<EventItem[], ApiError>({
    queryKey: eventsKey(day),
    queryFn: async ({ signal }) => {
      const items: EventItem[] = [];
      for (let offset = 0; ;) {
        const raw = await api<unknown>("/events", {
          query: { day, limit: EVENTS_PAGE_SIZE, offset },
          signal,
        });
        const batch = normalizeEvents(raw);
        items.push(...batch);
        offset += batch.length;
        const total = isRecord(raw) ? num(raw.total) : null;
        if (batch.length === 0 || total === null || offset >= total) break;
      }
      return items.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
    },
  });
}

/* ------------------------------------------------------------------ options de remplacement (supposé) */

export type IncidentKind = "truck" | "driver";

export interface ReplacementTruck {
  id: UUID;
  plate: string;
  size: string | null;
  total_capacity_l: number | null;
  carrier_name: string | null;
  /** Faux : proposé pour information mais non affectable (`reason` dit pourquoi). */
  suitable: boolean;
  reason: string | null;
}
export interface ReplacementDriver {
  id: UUID;
  full_name: string;
  phone: string | null;
  suitable: boolean;
  reason: string | null;
}
export interface ReplacementOptions {
  trucks: ReplacementTruck[];
  drivers: ReplacementDriver[];
}

export function normalizeReplacementOptions(raw: unknown): ReplacementOptions {
  const source = isRecord(raw) ? raw : {};
  const list = (value: unknown): Raw[] => (Array.isArray(value) ? value.filter(isRecord) : []);
  return {
    trucks: list(source.trucks).map((row) => ({
      id: String(row.id ?? row.truck_id),
      plate: String(row.plate ?? row.truck_plate ?? ""),
      size: str(row.size),
      total_capacity_l: num(row.total_capacity_l),
      carrier_name: str(row.carrier_name),
      suitable: row.suitable !== false,
      reason: str(row.reason),
    })),
    drivers: list(source.drivers).map((row) => ({
      id: String(row.id ?? row.driver_id),
      full_name: String(row.full_name ?? row.driver_name ?? ""),
      phone: str(row.phone),
      suitable: row.suitable !== false,
      reason: str(row.reason),
    })),
  };
}

/** Supposé : `GET /events/replacement-options?trip_id=&kind=` → `{trucks[], drivers[]}`. */
export function useReplacementOptions(tripId: UUID | null, kind: IncidentKind, enabled = true) {
  return useQuery<ReplacementOptions, ApiError>({
    queryKey: ["/events/replacement-options", tripId, kind],
    enabled: enabled && !!tripId,
    queryFn: async ({ signal }) =>
      normalizeReplacementOptions(
        await api<unknown>("/events/replacement-options", { query: { trip_id: tripId, kind }, signal }),
      ),
    staleTime: 0,
  });
}

/* ------------------------------------------------------------------ réaffectation (corps : spec §9) */

export interface TruckBreakdownInput {
  trip_id: UUID;
  replacement_truck_id: UUID;
  replacement_driver_id?: UUID;
}
export interface DriverUnavailableInput {
  trip_id: UUID;
  replacement_driver_id: UUID;
}

/** Résultat d'une réaffectation, réduit à ce dont l'écran a besoin. */
export interface ReassignmentResult {
  /** Nouvelle version du plan (F6.1 : « nouvelle version du plan »). */
  plan_id: UUID | null;
  plan_version: number | null;
  transferred_stop_count: number | null;
}

/**
 * Formes acceptées : `{plan: {id, version}, …}`, `{plan_id, plan_version, …}`, `{event: {plan_id, payload}}`,
 * ou directement un plan complet (`PlanOut`, comme les routes d'édition du lot L5).
 */
export function normalizeReassignment(raw: unknown): ReassignmentResult {
  const source = isRecord(raw) ? raw : {};
  const plan = isRecord(source.plan) ? source.plan : Array.isArray(source.trips) ? source : {};
  const event = isRecord(source.event) ? source.event : {};
  const payload = isRecord(event.payload) ? event.payload : {};
  return {
    plan_id:
      str(plan.id) ??
      str(source.new_plan_id) ??
      str(source.plan_id) ??
      str(payload.new_plan_id) ??
      str(event.plan_id),
    plan_version:
      num(plan.version) ??
      num(source.plan_version) ??
      num(payload.new_plan_version) ??
      num(payload.plan_version),
    transferred_stop_count:
      num(source.transferred_stop_count) ??
      num(payload.transferred_stop_count) ??
      (Array.isArray(source.transferred_stop_ids) ? source.transferred_stop_ids.length : null),
  };
}

function useAfterEvent() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ["/events"] }),
      client.invalidateQueries({ queryKey: ["/plans"] }),
      client.invalidateQueries({ queryKey: ["/loadings"] }),
    ]);
}

export function useTruckBreakdown() {
  const after = useAfterEvent();
  return useMutation<ReassignmentResult, ApiError, TruckBreakdownInput>({
    mutationFn: async (body) =>
      normalizeReassignment(await api<unknown>("/events/truck-breakdown", { method: "POST", body })),
    onSuccess: after,
  });
}

export function useDriverUnavailable() {
  const after = useAfterEvent();
  return useMutation<ReassignmentResult, ApiError, DriverUnavailableInput>({
    mutationFn: async (body) =>
      normalizeReassignment(await api<unknown>("/events/driver-unavailable", { method: "POST", body })),
    onSuccess: after,
  });
}

/* ------------------------------------------------------------------ pénurie produit (corps : spec §9) */

export interface ProductShortageInput {
  depot_id: UUID;
  product_id: UUID;
  new_available_l: number;
}

/** Tournée impactée (F6.3 : volume prévu > stock restant). */
export interface ImpactedTrip {
  trip_id: UUID;
  plan_id: UUID | null;
  trip_seq: number | null;
  truck_plate: string | null;
  driver_name: string | null;
  /** Volume du produit prévu au chargement de la tournée. */
  planned_l: number | null;
  /** Volume manquant pour cette tournée, si le serveur le calcule. */
  shortfall_l: number | null;
}
export interface ShortageResult {
  available_l: number | null;
  impacted_trips: ImpactedTrip[];
}

/** Formes acceptées : `{impacted_trips: […]}` à la racine, ou dans `event.payload`. */
export function normalizeShortage(raw: unknown): ShortageResult {
  const source = isRecord(raw) ? raw : {};
  const event = isRecord(source.event) ? source.event : {};
  const payload = isRecord(event.payload) ? event.payload : isRecord(source.payload) ? source.payload : {};
  const list = Array.isArray(source.impacted_trips)
    ? source.impacted_trips
    : Array.isArray(payload.impacted_trips)
      ? payload.impacted_trips
      : [];
  return {
    available_l: num(source.available_l) ?? num(source.new_available_l) ?? num(payload.new_available_l),
    impacted_trips: list.filter(isRecord).map((row) => ({
      trip_id: String(row.trip_id ?? row.id),
      plan_id: str(row.plan_id),
      trip_seq: num(row.trip_seq) ?? num(row.seq),
      truck_plate: str(row.truck_plate),
      driver_name: str(row.driver_name),
      planned_l: num(row.planned_l),
      shortfall_l: num(row.shortfall_l),
    })),
  };
}

export function useProductShortage() {
  const after = useAfterEvent();
  return useMutation<ShortageResult, ApiError, ProductShortageInput>({
    mutationFn: async (body) =>
      normalizeShortage(await api<unknown>("/events/product-shortage", { method: "POST", body })),
    onSuccess: after,
  });
}
