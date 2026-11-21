/**
 * Hooks TanStack Query génériques pour une ressource CRUD de l'API.
 *
 *   export const stations = createResource<Station, StationInput>("/stations");
 *   const { data } = stations.useList(toListQuery(state));
 *   const create = stations.useCreate();           // create.mutateAsync(input)
 *   const update = stations.useUpdate();           // update.mutateAsync({ id, input })
 *   const remove = stations.useRemove();           // remove.mutateAsync(id)
 *
 * Toute écriture invalide les listes et le détail de la ressource (et les clés `invalidates`).
 */
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseQueryOptions,
} from "@tanstack/react-query";

import type { Page, UUID } from "@/lib/types";

import { api, type Query } from "./client";
import type { ApiError } from "./errors";
import { fetchAll } from "./pagination";

export interface ResourceOptions {
  /** Verbe de mise à jour. L'API traite `PUT` et `PATCH` de la même façon : mise à jour partielle. */
  updateMethod?: "PUT" | "PATCH";
  /** Clés de requête supplémentaires à invalider après une écriture. */
  invalidates?: QueryKey[];
}

type ListOptions<T> = Omit<UseQueryOptions<Page<T>, ApiError>, "queryKey" | "queryFn">;

export function createResource<T extends { id: UUID }, TInput = Partial<T>>(
  path: string,
  options: ResourceOptions = {},
) {
  const updateMethod = options.updateMethod ?? "PUT";
  const keys = {
    all: [path] as const,
    lists: () => [path, "list"] as const,
    list: (query: Query = {}) => [path, "list", query] as const,
    everything: (query: Query = {}) => [path, "all", query] as const,
    detail: (id: UUID) => [path, "detail", id] as const,
  };

  const fetchers = {
    list: (query: Query = {}, signal?: AbortSignal) => api<Page<T>>(path, { query, signal }),
    all: (query: Query = {}, signal?: AbortSignal) => fetchAll<T>(path, query, signal),
    one: (id: UUID, signal?: AbortSignal) => api<T>(`${path}/${id}`, { signal }),
    create: (input: TInput) => api<T>(path, { method: "POST", body: input }),
    update: (id: UUID, input: Partial<TInput>) =>
      api<T>(`${path}/${id}`, { method: updateMethod, body: input }),
    remove: (id: UUID) => api<void>(`${path}/${id}`, { method: "DELETE" }),
  };

  function useInvalidate() {
    const client = useQueryClient();
    return () =>
      Promise.all([
        client.invalidateQueries({ queryKey: keys.all }),
        ...(options.invalidates ?? []).map((queryKey) => client.invalidateQueries({ queryKey })),
      ]);
  }

  return {
    path,
    keys,
    ...fetchers,

    /** Une page de la liste ; la page précédente reste affichée pendant le chargement de la suivante. */
    useList(query: Query = {}, queryOptions: ListOptions<T> = {}) {
      return useQuery<Page<T>, ApiError>({
        queryKey: keys.list(query),
        queryFn: ({ signal }) => fetchers.list(query, signal),
        placeholderData: keepPreviousData,
        ...queryOptions,
      });
    },

    /** Toutes les lignes (listes déroulantes, carte). */
    useAll(query: Query = {}, queryOptions: { enabled?: boolean; staleTime?: number } = {}) {
      return useQuery<T[], ApiError>({
        queryKey: keys.everything(query),
        queryFn: ({ signal }) => fetchers.all(query, signal),
        staleTime: 60_000,
        ...queryOptions,
      });
    },

    useOne(id: UUID | null | undefined) {
      return useQuery<T, ApiError>({
        queryKey: keys.detail(id ?? ""),
        queryFn: ({ signal }) => fetchers.one(id as UUID, signal),
        enabled: !!id,
      });
    },

    useCreate() {
      const invalidate = useInvalidate();
      return useMutation<T, ApiError, TInput>({ mutationFn: fetchers.create, onSuccess: invalidate });
    },

    useUpdate() {
      const invalidate = useInvalidate();
      return useMutation<T, ApiError, { id: UUID; input: Partial<TInput> }>({
        mutationFn: ({ id, input }) => fetchers.update(id, input),
        onSuccess: invalidate,
      });
    },

    useRemove() {
      const invalidate = useInvalidate();
      return useMutation<void, ApiError, UUID>({ mutationFn: fetchers.remove, onSuccess: invalidate });
    },

    /** Suppression en masse : une requête par ligne ; échoue à la première erreur. */
    useRemoveMany() {
      const invalidate = useInvalidate();
      return useMutation<void, ApiError, UUID[]>({
        mutationFn: async (ids) => {
          for (const id of ids) await fetchers.remove(id);
        },
        onSettled: invalidate,
      });
    },
  };
}

export type Resource<T extends { id: UUID }, TInput = Partial<T>> = ReturnType<
  typeof createResource<T, TInput>
>;
