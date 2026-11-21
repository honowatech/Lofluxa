/**
 * Doublures des écrans de vague 2, pour le mode démonstration (`VITE_MOCKS=full`), `pnpm captures` et la base
 * des tests Vitest. Chaque écran fournit les siennes dans son dossier ; ce fichier ne fait que les assembler
 * (aucune n'est modifiée ici).
 *
 * Plusieurs écrans simulent les mêmes routes (`GET /plans`, `/tasks/{id}`, `/dashboard`,
 * `/availability/trucks`…) : MSW retient le premier gestionnaire qui répond, d'où l'ordre ci-dessous
 * (Plan, Journée, Comparaison, Commandes, Disponibilité). Seule la liste `GET /plans` est fusionnée, pour que
 * chaque écran y retrouve ses plans. Conséquence connue : une tâche lancée depuis Comparaison (rejeu) est
 * suivie par le scénario de tâche de l'écran Plan.
 */
import { http, HttpResponse, type HttpHandler } from "msw";

import { createAvailabilityMocks } from "@/features/availability/mocks";
import { comparisonHandlers, PLANS as COMPARISON_PLANS } from "@/features/comparison/fixtures";
import { createDayMocks } from "@/features/day/mocks";
import { createOrdersMocks } from "@/features/orders/mocks";
import { makePlan, summaryOf } from "@/features/plan/testing/fixtures";
import { planApi, type PlanApiState } from "@/features/plan/testing/handlers";

import { API, authenticate } from "./helpers";

export function createScreenHandlers(): HttpHandler[] {
  const planState: PlanApiState = { plans: [makePlan()], calls: [] };
  const day = createDayMocks({ plans: planState.plans.map(summaryOf) as never });
  const comparison = comparisonHandlers();

  // Liste des plans du jour : ceux de l'écran Plan (vivants) et ceux de l'écran Comparaison.
  const plans = http.get(`${API}/plans`, ({ request }) => {
    const user = authenticate(request);
    if (user instanceof Response) return user;
    const wanted = new URL(request.url).searchParams.get("day");
    const items = [...planState.plans.map(summaryOf), ...COMPARISON_PLANS].filter(
      (plan) => !wanted || (plan as { day?: string }).day === wanted,
    );
    return HttpResponse.json({ items, total: items.length, limit: 500, offset: 0 });
  });

  return [
    plans,
    ...planApi(planState),
    ...day.handlers,
    ...comparison.handlers,
    ...createOrdersMocks().handlers,
    ...createAvailabilityMocks().handlers,
  ];
}
