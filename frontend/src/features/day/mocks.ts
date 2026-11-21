/**
 * Doublures MSW de l'écran Journée : résumé, plans du jour, tableau de bord, calcul et suivi de tâche.
 * À brancher par `server.use(...createDayMocks().handlers)` ; l'état renvoyé se modifie depuis le test.
 */
import { http, HttpResponse, type HttpHandler } from "msw";

import { API, authenticate, authorize, errorResponse } from "@/mocks/handlers/helpers";

import type { Dashboard, DaySummary, PlanSummary, Task } from "./api";

export const MOCK_DAY = "2027-01-12";

export function mockPlan(overrides: Partial<PlanSummary> = {}): PlanSummary {
  return {
    id: "plan-1",
    day: MOCK_DAY,
    kind: "computed",
    status: "draft",
    version: 1,
    root_plan_id: null,
    parent_plan_id: null,
    label: null,
    approximate: true,
    engine_version: "moteur-1.4.2",
    computed_at: "2027-01-12T05:42:10Z",
    computed_in_ms: 3460,
    prep_time_s: null,
    metrics: {
      trips_count: 6,
      orders_served: 19,
      orders_total: 20,
      total_distance_m: 89325,
      avg_fill_rate_pct: 78.1,
    },
    blocking_count: 1,
    warning_count: 2,
    publishable: false,
    created_at: "2027-01-12T05:42:10Z",
    updated_at: "2027-01-12T05:42:10Z",
    created_by: "u-dispatcher",
    created_by_name: "Awa Dispatcher",
    ...overrides,
  };
}

export function mockSummary(): DaySummary {
  return {
    day: MOCK_DAY,
    orders: {
      total: 23,
      by_status: { draft: 4, confirmed: 17, planned: 0, loaded: 0, delivered: 0, cancelled: 1, postponed: 1 },
      urgent_pending: 2,
    },
    trucks: { total: 7, assignable: 5, blocked: 2 },
    drivers: { total: 10, assignable: 6, blocked: 4, blocked_rm03: 2, assignable_without_truck: 1 },
    depot_stocks: {
      expected: 6,
      entered: 4,
      missing: 2,
      complete: false,
      last_entered_at: "2027-01-12T05:10:00Z",
      missing_items: [
        { depot_id: "d2", depot_code: "SCDP-YDE", product_id: "p1", product_code: "SUPER" },
        { depot_id: "d2", depot_code: "SCDP-YDE", product_id: "p3", product_code: "PETROLE" },
      ],
    },
  };
}

export function mockDashboard(): Dashboard {
  return {
    day: MOCK_DAY,
    generated_at: "2027-01-12T06:00:00Z",
    plan: null,
    summary: {
      trips_total: 0,
      trips_by_status: {},
      stops_total: 0,
      stops_delivered: 0,
      stops_skipped: 0,
      stops_pending: 0,
      volume_planned_l: 0,
      volume_delivered_l: 0,
      trips_late: 0,
      max_delay_s: 0,
      alerts_blocking: 1,
      alerts_total: 2,
    },
    trips: [],
    delays: [],
    alerts: [
      {
        source: "violation",
        severity: "blocking",
        code: "RM-15",
        message: "La commande urgente de OLA Deido (gasoil) n'est pas servie.",
        trip_id: null,
        trip_seq: null,
        event_id: null,
        event_type: null,
        occurred_at: null,
        payload: null,
      },
      {
        source: "violation",
        severity: "warning",
        code: "RM-10",
        message: "Arrivée 12 min après la fermeture de OLA Bonabéri.",
        trip_id: "trip-3",
        trip_seq: 3,
        event_id: null,
        event_type: null,
        occurred_at: null,
        payload: null,
      },
    ],
  };
}

export interface DayMockState {
  summary: DaySummary;
  plans: PlanSummary[];
  dashboard: Dashboard;
  /** États renvoyés par les interrogations successives de `GET /tasks/{id}` (le dernier se répète). */
  taskScript: Partial<Task>[];
  /** Plan ajouté à la liste quand la tâche réussit. */
  producedPlan: PlanSummary;
  computeCalls: { day: string }[];
  taskPolls: number;
}

export function createDayMocks(overrides: Partial<DayMockState> = {}) {
  const state: DayMockState = {
    summary: mockSummary(),
    plans: [],
    dashboard: mockDashboard(),
    taskScript: [
      { state: "pending", progress: 0, message: "En attente de démarrage" },
      { state: "running", progress: 45, message: "Construction des tournées" },
      { state: "succeeded", progress: 100, message: "Plan calculé", plan_id: "plan-new" },
    ],
    producedPlan: mockPlan({ id: "plan-new" }),
    computeCalls: [],
    taskPolls: 0,
    ...overrides,
  };

  const handlers: HttpHandler[] = [
    http.get(`${API}/availability/summary`, ({ request }) => {
      const user = authenticate(request);
      return user instanceof Response ? user : HttpResponse.json(state.summary);
    }),
    http.get(`${API}/plans`, ({ request }) => {
      const user = authenticate(request);
      if (user instanceof Response) return user;
      return HttpResponse.json({ items: state.plans, total: state.plans.length, limit: 100, offset: 0 });
    }),
    http.get(`${API}/dashboard`, ({ request }) => {
      const user = authenticate(request);
      return user instanceof Response ? user : HttpResponse.json(state.dashboard);
    }),
    http.post(`${API}/plans/compute`, async ({ request }) => {
      const user = authorize(request, ["dispatcher"]);
      if (user instanceof Response) return user;
      const body = (await request.json()) as { day: string };
      state.computeCalls.push(body);
      if ((state.summary.orders.by_status.confirmed ?? 0) === 0) {
        return errorResponse(
          409,
          "no_orders_to_plan",
          "Aucune commande confirmée à planifier pour le 12/01/2027.",
        );
      }
      state.taskPolls = 0;
      return HttpResponse.json({ task_id: `task-${state.computeCalls.length}` }, { status: 202 });
    }),
    http.get(`${API}/tasks/:taskId`, ({ request, params }) => {
      const user = authenticate(request);
      if (user instanceof Response) return user;
      const step = state.taskScript[Math.min(state.taskPolls, state.taskScript.length - 1)];
      state.taskPolls += 1;
      if (step.state === "succeeded" && !state.plans.some((plan) => plan.id === state.producedPlan.id)) {
        state.plans = [state.producedPlan, ...state.plans];
      }
      return HttpResponse.json({
        task_id: String(params.taskId),
        state: "pending",
        progress: 0,
        message: null,
        plan_id: null,
        error: null,
        ...step,
      });
    }),
  ];

  return { state, handlers };
}
