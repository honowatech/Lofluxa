/** Aides de pagination : toutes les listes de l'API sont des `Page<T>` (`limit` / `offset`). */
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "@/lib/config";
import type { Page } from "@/lib/types";

import { api, type Query } from "./client";

export interface ListState {
  pageIndex: number;
  pageSize: number;
  /** Tri serveur : `{ id: "code", desc: false }`. */
  sorting?: { id: string; desc: boolean }[];
  /** Recherche plein texte (paramètre `q`). */
  search?: string;
  /** Filtres exacts par nom de champ. */
  filters?: Record<string, string | number | boolean | null | undefined>;
}

export const emptyPage = <T>(): Page<T> => ({ items: [], total: 0, limit: DEFAULT_PAGE_SIZE, offset: 0 });

/**
 * État de tableau → paramètres de requête.
 * Convention supposée (CONTRATS §7 ne la fixe pas, question L9-Q2) : `sort=champ` ou `sort=-champ`,
 * `q=` pour la recherche, un paramètre par filtre.
 */
export function toListQuery(state: Partial<ListState>): Query {
  const pageSize = state.pageSize ?? DEFAULT_PAGE_SIZE;
  const query: Query = { limit: pageSize, offset: (state.pageIndex ?? 0) * pageSize };
  const sort = state.sorting?.[0];
  if (sort) query.sort = `${sort.desc ? "-" : ""}${sort.id}`;
  if (state.search?.trim()) query.q = state.search.trim();
  for (const [key, value] of Object.entries(state.filters ?? {})) {
    if (value !== undefined && value !== null && value !== "") query[key] = value;
  }
  return query;
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
}

/** Libellé « 1–50 sur 132 » : bornes affichées (1-indexées). */
export function pageBounds(page: Pick<Page<unknown>, "total" | "limit" | "offset">): {
  from: number;
  to: number;
} {
  if (page.total === 0) return { from: 0, to: 0 };
  return { from: page.offset + 1, to: Math.min(page.offset + page.limit, page.total) };
}

/** Charge toutes les pages d'une liste (listes déroulantes, carte). À réserver aux petits référentiels. */
export async function fetchAll<T>(path: string, query: Query = {}, signal?: AbortSignal): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await api<Page<T>>(path, { query: { ...query, limit: MAX_PAGE_SIZE, offset }, signal });
    items.push(...page.items);
    offset += page.items.length;
    if (page.items.length === 0 || offset >= page.total) return items;
  }
}
