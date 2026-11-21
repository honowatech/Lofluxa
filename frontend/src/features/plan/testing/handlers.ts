/**
 * Doublures MSW de l'API des plans pour les tests de l'écran (à brancher par `server.use(...planApi(state))`).
 * Le « serveur » applique la modification demandée, recalcule de façon reconnaissable (distance = 99,9 km),
 * joint `last_edit` (résumé journalisé) et, si le plan visé est publié, renvoie une nouvelle version brouillon
 * aux identifiants neufs (RM-18).
 */
import { http, HttpResponse, type HttpHandler } from "msw";

import { API, errorResponse } from "@/mocks/handlers/helpers";
import type { ApiErrorDetail } from "@/lib/types";

import { applyOp } from "../edits";
import type { EditOp, Plan, PlanVersion, TaskStatus } from "../types";
import { asNewVersion, DRIVER_DAYS, summaryOf, TRUCK_DAYS, versionOf } from "./fixtures";

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

export interface PlanApiState {
  plans: Plan[];
  calls: Call[];
  /** Erreur renvoyée par la prochaine écriture (puis effacée). */
  failNext?: { status: number; code: string; message: string; details?: ApiErrorDetail[] } | null;
  /** États successifs de `GET /tasks/{id}` (le dernier est répété). */
  taskSteps?: Partial<TaskStatus>[];
  versions?: PlanVersion[];
  /** Délai des écritures, pour observer l'état optimiste. */
  delayMs?: number;
}

export const SERVER_DISTANCE_M = 99_900;

const page = <T>(items: T[]) => ({ items, total: items.length, limit: 200, offset: 0 });

function toOp(action: string, tripId: string, body: Record<string, unknown>): EditOp | null {
  switch (action) {
    case "move-stop":
      return {
        type: "move",
        tripId,
        stopId: String(body.stop_id),
        toTripId: String(body.to_trip_id),
        toSeq: Number(body.to_seq),
      };
    case "reorder":
      return { type: "reorder", tripId, stopIds: body.stop_ids as string[] };
    case "lock":
    case "unlock":
      return { type: "lock", tripId, locked: action === "lock" };
    case "assign": {
      const truck = TRUCK_DAYS.find((t) => t.truck_id === body.truck_id);
      const driver = DRIVER_DAYS.find((d) => d.driver_id === body.driver_id);
      return {
        type: "assign",
        tripId,
        truck: truck
          ? { id: truck.truck_id, plate: truck.plate, capacity_l: truck.total_capacity_l }
          : undefined,
        driver:
          "driver_id" in body
            ? driver
              ? { id: driver.driver_id, name: driver.full_name }
              : null
            : undefined,
      };
    }
    default:
      return null;
  }
}

/** Résumé journalisé par le serveur (`last_edit.summary`), à la manière de l'API réelle. */
function summaryOfOp(plan: Plan, op: EditOp): string {
  const seq = plan.trips.find((trip) => trip.id === op.tripId)?.seq;
  switch (op.type) {
    case "move": {
      const code = plan.trips
        .flatMap((trip) => trip.stops)
        .find((stop) => stop.id === op.stopId)?.station_code;
      const target = plan.trips.find((trip) => trip.id === op.toTripId);
      const emptied = plan.trips.find((trip) => trip.id === op.tripId)?.stops.length === 1;
      return (
        `Arrêt ${code} déplacé de la tournée ${seq} vers la tournée ${target?.seq} (position ${op.toSeq}).` +
        (emptied ? ` La tournée ${seq}, vide, a été supprimée.` : "")
      );
    }
    case "reorder":
      return `Arrêts de la tournée ${seq} réordonnés.`;
    case "assign":
      return `Tournée ${seq} : affectation modifiée.`;
    case "lock":
      return `Tournée ${seq} ${op.locked ? "verrouillée" : "déverrouillée"}.`;
  }
}

export function planApi(state: PlanApiState): HttpHandler[] {
  const find = (id: unknown) => state.plans.find((plan) => plan.id === id);
  const save = (plan: Plan) => {
    state.plans = [...state.plans.filter((other) => other.id !== plan.id), plan];
    return plan;
  };
  const record = async (request: Request) => {
    let body: unknown = null;
    try {
      body = await request.clone().json();
    } catch {
      body = null;
    }
    state.calls.push({
      method: request.method,
      path: new URL(request.url).pathname.replace(/^.*\/api\/v1/, ""),
      body,
    });
    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    return (body ?? {}) as Record<string, unknown>;
  };
  const failure = () => {
    const fail = state.failNext;
    if (!fail) return null;
    state.failNext = null;
    return errorResponse(fail.status, fail.code, fail.message, fail.details ?? []);
  };
  let taskPolls = 0;

  return [
    http.get(`${API}/plans`, ({ request }) => {
      const day = new URL(request.url).searchParams.get("day");
      const items = state.plans.filter((plan) => !day || plan.day === day).map(summaryOf);
      return HttpResponse.json(page(items.reverse()));
    }),
    http.get(`${API}/plans/:id`, ({ params }) => {
      const plan = find(params.id);
      return plan ? HttpResponse.json(plan) : errorResponse(404, "not_found", "Plan introuvable.");
    }),
    http.get(`${API}/plans/:id/versions`, ({ params }) => {
      const plan = find(params.id);
      const root = plan?.root_plan_id ?? plan?.id;
      const items =
        state.versions ??
        state.plans
          .filter((other) => (other.root_plan_id ?? other.id) === root)
          .map((other) => versionOf(other));
      return HttpResponse.json(page(items));
    }),
    http.post(`${API}/plans/:id/trips/:tripId/:action`, async ({ request, params }) => {
      const body = await record(request);
      const failed = failure();
      if (failed) return failed;
      const plan = find(params.id);
      if (!plan) return errorResponse(404, "not_found", "Plan introuvable.");
      const op = toOp(String(params.action), String(params.tripId), body);
      if (!op) return errorResponse(404, "not_found", "Route inconnue.");
      let next = applyOp(plan, op);
      next = {
        ...next,
        trips: next.trips.map((trip) =>
          trip.id === op.tripId || (op.type === "move" && trip.id === op.toTripId)
            ? { ...trip, distance_m: SERVER_DISTANCE_M }
            : trip,
        ),
      };
      if (plan.status === "published") next = asNewVersion(next, `${plan.id}-draft`);
      save({ ...next, last_edit: null });
      return HttpResponse.json({ ...next, last_edit: { action: op.type, summary: summaryOfOp(plan, op) } });
    }),
    http.post(`${API}/plans/:id/publish`, async ({ request, params }) => {
      await record(request);
      const failed = failure();
      if (failed) return failed;
      const plan = find(params.id);
      if (!plan) return errorResponse(404, "not_found", "Plan introuvable.");
      return HttpResponse.json(save({ ...plan, status: "published", publishable: false }));
    }),
    http.post(`${API}/plans/:id/recompute`, async ({ request }) => {
      await record(request);
      const failed = failure();
      if (failed) return failed;
      taskPolls = 0;
      return HttpResponse.json({ task_id: "task-1" }, { status: 202 });
    }),
    http.get(`${API}/tasks/:id`, ({ params }) => {
      const steps = state.taskSteps ?? [{ state: "succeeded", progress: 100, plan_id: state.plans[0]?.id }];
      const step = steps[Math.min(taskPolls, steps.length - 1)];
      taskPolls += 1;
      return HttpResponse.json({
        task_id: String(params.id),
        state: "running",
        progress: 0,
        message: null,
        plan_id: null,
        error: null,
        ...step,
      });
    }),
    http.post(`${API}/plans/:id/versions/:version/restore`, async ({ request, params }) => {
      await record(request);
      const failed = failure();
      if (failed) return failed;
      const source = state.plans.find(
        (plan) =>
          plan.version === Number(params.version) &&
          (plan.root_plan_id ?? plan.id) === (find(params.id)?.root_plan_id ?? params.id),
      );
      if (!source) return errorResponse(404, "not_found", "Version introuvable.");
      const latest = Math.max(...state.plans.map((plan) => plan.version));
      return HttpResponse.json(save({ ...asNewVersion(source, "plan-restored"), version: latest + 1 }));
    }),
    http.post(`${API}/orders/:id/postpone`, async ({ request, params }) => {
      await record(request);
      const failed = failure();
      if (failed) return failed;
      // Comme l'API réelle : la commande passe `postponed` et les brouillons qui la portent sont recontrôlés
      // (plus de RM-15 pour une urgente reportée ; `blocking_count` et `publishable` à jour).
      state.plans = state.plans.map((plan) => {
        const unserved = plan.unserved.map((order) =>
          order.order_id === params.id ? { ...order, order_status: "postponed" as const } : order,
        );
        const openUrgent = unserved.some((o) => o.priority === "urgent" && o.order_status !== "postponed");
        const violations = plan.violations.filter((v) => v.rule_code !== "RM-15" || openUrgent);
        const blocking = violations.filter((v) => v.severity === "blocking").length;
        return { ...plan, unserved, violations, blocking_count: blocking, publishable: blocking === 0 };
      });
      return HttpResponse.json({ id: params.id, status: "postponed" });
    }),
    http.get(`${API}/availability/trucks`, () => HttpResponse.json(page(TRUCK_DAYS))),
    http.get(`${API}/availability/drivers`, () => HttpResponse.json(page(DRIVER_DAYS))),
    http.get(`${API}/trips/:id/route-sheet.pdf`, ({ request }) => {
      state.calls.push({
        method: "GET",
        path: new URL(request.url).pathname.replace(/^.*\/api\/v1/, ""),
        body: null,
      });
      return new HttpResponse("%PDF-1.4", {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'inline; filename="feuille.pdf"',
        },
      });
    }),
    http.get(`${API}/plans/:id/route-sheets.pdf`, ({ request }) => {
      state.calls.push({
        method: "GET",
        path: new URL(request.url).pathname.replace(/^.*\/api\/v1/, ""),
        body: null,
      });
      return new HttpResponse("%PDF-1.4", {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'inline; filename="feuilles.pdf"',
        },
      });
    }),
  ];
}
