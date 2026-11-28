/**
 * Doublures des écrans de vague 2, pour le mode démonstration (`VITE_MOCKS=full`), `pnpm captures` et la base
 * des tests Vitest. Chaque écran fournit les siennes dans son dossier ; ce fichier ne fait que les assembler
 * (aucune n'est modifiée ici).
 *
 * Plusieurs écrans simulent les mêmes routes (`GET /plans`, `/plans/{id}`, `/loadings`, `/trips/{id}/status`,
 * `/tasks/{id}`…), chacun avec ses propres données. Un aiguilleur unique interroge donc les doublures dans
 * l'ordre (Journal, Plan, Journée, Comparaison, Commandes, Disponibilité, Chargement, Suivi) :
 *  - la première réponse autre que « 404 introuvable » l'emporte : une tournée de l'écran Suivi est ainsi
 *    servie par les doublures du Suivi même si celles du Chargement ne la connaissent pas ;
 *  - les listes `GET /plans` et `GET /loadings` sont fusionnées (sans doublon), pour que chaque écran y
 *    retrouve ses plans et ses tournées.
 * Limites connues du mode démonstration : pour une même route sans identifiant (`/dashboard`,
 * `/availability/trucks`…), la première doublure répond pour tous les écrans ; une tâche lancée depuis
 * Comparaison (rejeu) est suivie par le scénario de tâche de l'écran Plan.
 *
 * Les écrans Chargement, Suivi et Journal montrent leurs données sur le jour courant (Douala).
 */
import { http, HttpResponse, type HttpHandler, type RequestHandler } from "msw";

import { createAvailabilityMocks } from "@/features/availability/mocks";
import { comparisonHandlers } from "@/features/comparison/fixtures";
import { createDayMocks } from "@/features/day/mocks";
import { createDeliveryMocks } from "@/features/deliveries/mocks";
import { createEventsScenario, eventsHandlers } from "@/features/events/mocks";
import { createLoadingMocks } from "@/features/loading/mocks";
import { createOrdersMocks } from "@/features/orders/mocks";
import { makePlan, summaryOf } from "@/features/plan/testing/fixtures";
import { planApi, type PlanApiState } from "@/features/plan/testing/handlers";
import { todayLocal } from "@/lib/format";

import { API } from "./helpers";

/** Listes paginées fusionnées entre écrans (chemin exact sous `/api/v1`). */
const MERGED_LISTS = new Set(["/plans", "/loadings"]);

interface PageBody {
  items: { id?: string }[];
  total: number;
  limit: number;
  offset: number;
}
const isPage = (body: unknown): body is PageBody =>
  typeof body === "object" && body !== null && Array.isArray((body as PageBody).items);

/**
 * Aiguilleur : interroge chaque doublure dans l'ordre et renvoie la première réponse autre que 404
 * (ou la fusion des listes pour les chemins de `MERGED_LISTS`). Sans réponse : la requête poursuit son chemin.
 */
export function combineHandlers(handlers: readonly RequestHandler[]): HttpHandler {
  return http.all(`${API}/*`, async ({ request, requestId }) => {
    const path = new URL(request.url).pathname.replace(/^.*\/api\/v1/, "");
    const merge = request.method === "GET" && MERGED_LISTS.has(path);
    const pages: PageBody[] = [];
    let notFound: Response | undefined;
    for (const handler of handlers) {
      const result = await handler.run({ request: request.clone(), requestId });
      const response = result?.response;
      if (!response) continue;
      if (response.status === 404) {
        notFound ??= response;
        continue;
      }
      if (!merge || !response.ok) return response;
      const body: unknown = await response
        .clone()
        .json()
        .catch(() => null);
      if (!isPage(body)) return response;
      pages.push(body);
    }
    if (pages.length > 0) {
      const seen = new Set<string>();
      const items = pages
        .flatMap((page) => page.items)
        .filter((item) => {
          if (!item.id) return true;
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        });
      return HttpResponse.json({ items, total: items.length, limit: 500, offset: 0 });
    }
    return notFound;
  });
}

export function createScreenHandlers(): HttpHandler[] {
  const today = todayLocal();
  const planState: PlanApiState = { plans: [makePlan()], calls: [] };
  const day = createDayMocks({ plans: planState.plans.map(summaryOf) as never });

  return [
    combineHandlers([
      // Le journal d'abord : ses doublures filtrent `/events` par jour et paginent, celles de la Journée
      // (aperçu des derniers événements) répondent pour tout jour avec un total fixe.
      ...eventsHandlers(createEventsScenario(today)),
      ...planApi(planState),
      ...day.handlers,
      ...comparisonHandlers().handlers,
      ...createOrdersMocks().handlers,
      ...createAvailabilityMocks().handlers,
      ...createLoadingMocks(today).handlers,
      ...createDeliveryMocks(today).handlers,
    ]),
  ];
}
