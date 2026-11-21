/**
 * Doublures MSW de l'écran Commandes du jour (routes du lot L4), au plus près du comportement réel :
 * transitions, contrôle de volume F3.4 (refus 422 `order_exceeds_tank_capacity` ou avertissement `tank_unknown`),
 * confirmation en masse avec un résultat par commande. Stations et produits viennent du jeu fictif commun.
 * À brancher par `server.use(...createOrdersMocks().handlers)`.
 */
import { http, HttpResponse, type HttpHandler } from "msw";

import { db } from "@/mocks/db";
import { API, authenticate, authorize, errorResponse, notFound } from "@/mocks/handlers/helpers";

import type { Order, OrderInput, OrderPatch, OrderWarning } from "./api";

export const MOCK_DAY = "2027-01-12";

type Check = { blocking?: string; max_l?: number; warnings: OrderWarning[] };

const liters = (value: number) => new Intl.NumberFormat("fr-FR").format(value).replace(/\s/g, " ");

export function createOrdersMocks() {
  const [superP, gasoil, petrole] = db.products;
  const [akwa, bonanjo, bonapriso, deido] = db.stations;
  let counter = 0;

  const make = (
    station: (typeof db.stations)[number],
    product: (typeof db.products)[number],
    requested_l: number,
    extra: Partial<Order> = {},
  ): Order => ({
    id: `order-${(counter += 1)}`,
    day: MOCK_DAY,
    station_id: station.id,
    station_code: station.code,
    station_name: station.name,
    product_id: product.id,
    product_code: product.code,
    product_label: product.label,
    requested_l,
    priority: "normal",
    window_start: null,
    window_end: null,
    comment: null,
    status: "draft",
    source: "manual",
    import_batch_id: null,
    created_at: "2027-01-11T15:00:00Z",
    updated_at: "2027-01-11T15:00:00Z",
    warnings: [],
    ...extra,
  });

  const state = {
    orders: [
      make(akwa, superP, 12000, { window_start: "08:00", window_end: "12:00" }),
      make(akwa, gasoil, 15000, { priority: "urgent", status: "confirmed" }),
      make(bonanjo, gasoil, 9000, { comment: "Livrer avant midi" }),
      make(bonapriso, superP, 6000, { status: "planned" }),
      make(deido, petrole, 4000, { status: "cancelled", source: "import" }),
      make(deido, superP, 8000),
      make(akwa, superP, 3000, { day: "2027-01-13" }),
    ] as Order[],
    /** Requêtes reçues, pour vérifier ce que l'écran envoie. */
    listQueries: [] as string[],
    patches: [] as { id: string; body: OrderPatch }[],
    bulkConfirms: [] as string[][],
  };

  /** Contrôle F3.4 : volume ≤ capacité de cuve − stock de sécurité ; cuve inconnue → avertissement. */
  const check = (order: Pick<Order, "station_id" | "product_id" | "requested_l">): Check => {
    const station = db.stations.find((candidate) => candidate.id === order.station_id);
    const tank = station?.tanks.find((candidate) => candidate.product_id === order.product_id);
    if (!tank) {
      return {
        warnings: [
          {
            code: "tank_unknown",
            message:
              "Cuve non renseignée pour cette station et ce produit : le volume demandé n'a pas pu être contrôlé.",
          },
        ],
      };
    }
    const max = tank.capacity_l - tank.safety_stock_l;
    if (order.requested_l > max) {
      return {
        max_l: max,
        warnings: [],
        blocking: `Volume demandé (${liters(order.requested_l)} L) supérieur au volume recevable par la cuve (${liters(max)} L = capacité ${liters(tank.capacity_l)} L − stock de sécurité ${liters(tank.safety_stock_l)} L).`,
      };
    }
    return { max_l: max, warnings: [] };
  };

  const capacityError = (order: Order, result: Check) =>
    errorResponse(422, "order_exceeds_tank_capacity", result.blocking as string, [
      { order_id: order.id, field: "requested_l", message: result.blocking, max_l: result.max_l },
    ]);

  const transitionError = (order: Order) =>
    errorResponse(
      409,
      "order_transition_forbidden",
      `Transition interdite pour une commande « ${order.status} ».`,
      [{ order_id: order.id, status: order.status }],
    );

  const find = (id: unknown) => state.orders.find((order) => order.id === id);

  const labels = (input: Pick<OrderInput, "station_id" | "product_id">) => {
    const station = db.stations.find((candidate) => candidate.id === input.station_id);
    const product = db.products.find((candidate) => candidate.id === input.product_id);
    return {
      station_code: station?.code ?? "",
      station_name: station?.name ?? "",
      product_code: product?.code ?? "",
      product_label: product?.label ?? "",
    };
  };

  /** Modification d'une commande `draft` ou `confirmed` ; le contrôle F3.4 est rejoué si elle est confirmée. */
  const update = (order: Order, changes: OrderPatch) => {
    if (order.status !== "draft" && order.status !== "confirmed") {
      return errorResponse(
        409,
        "order_not_editable",
        "Seules les commandes en brouillon ou confirmées peuvent être modifiées.",
      );
    }
    const next = { ...order, ...changes } as Order;
    Object.assign(next, labels(next));
    let warnings: OrderWarning[] = [];
    if (next.status === "confirmed") {
      const result = check(next);
      if (result.blocking) return capacityError(order, result);
      warnings = result.warnings;
    }
    Object.assign(order, next, { updated_at: new Date().toISOString() });
    return HttpResponse.json({ ...order, warnings });
  };

  const handlers: HttpHandler[] = [
    http.get(`${API}/orders`, ({ request }) => {
      const user = authenticate(request);
      if (user instanceof Response) return user;
      const url = new URL(request.url);
      state.listQueries.push(url.search);
      const params = url.searchParams;
      const statuses = params.getAll("status");
      const rows = state.orders.filter(
        (order) =>
          (!params.get("day") || order.day === params.get("day")) &&
          (!params.get("station_id") || order.station_id === params.get("station_id")) &&
          (!params.get("product_id") || order.product_id === params.get("product_id")) &&
          (statuses.length === 0 || statuses.includes(order.status)) &&
          (!params.get("priority") || order.priority === params.get("priority")),
      );
      const limit = Number(params.get("limit") ?? 50);
      const offset = Number(params.get("offset") ?? 0);
      // Comme le serveur réel : les avertissements ne sont pas renvoyés par la liste.
      return HttpResponse.json({
        items: rows.slice(offset, offset + limit).map((order) => ({ ...order, warnings: [] })),
        total: rows.length,
        limit,
        offset,
      });
    }),

    http.post(`${API}/orders/confirm`, async ({ request }) => {
      const user = authorize(request, ["dispatcher"]);
      if (user instanceof Response) return user;
      const { order_ids } = (await request.json()) as { order_ids: string[] };
      state.bulkConfirms.push(order_ids);
      const results = order_ids.map((order_id) => {
        const order = find(order_id);
        if (!order) {
          return {
            order_id,
            ok: false,
            order: null,
            warnings: [],
            error: { code: "not_found", message: "Commande introuvable." },
          };
        }
        if (order.status !== "draft") {
          return {
            order_id,
            ok: false,
            order: null,
            warnings: [],
            error: {
              code: "order_transition_forbidden",
              message: `Transition interdite pour une commande « ${order.status} ».`,
            },
          };
        }
        const result = check(order);
        if (result.blocking) {
          return {
            order_id,
            ok: false,
            order: null,
            warnings: [],
            error: { code: "order_exceeds_tank_capacity", message: result.blocking },
          };
        }
        order.status = "confirmed";
        return {
          order_id,
          ok: true,
          order: { ...order, warnings: result.warnings },
          warnings: result.warnings,
          error: null,
        };
      });
      return HttpResponse.json({
        confirmed: results.filter((item) => item.ok).length,
        failed: results.filter((item) => !item.ok).length,
        results,
      });
    }),

    http.post(`${API}/orders`, async ({ request }) => {
      const user = authorize(request, ["dispatcher"]);
      if (user instanceof Response) return user;
      const input = (await request.json()) as OrderInput;
      if (input.window_start && input.window_end && input.window_start >= input.window_end) {
        const message = "Le début de la fenêtre de livraison doit précéder la fin.";
        return errorResponse(422, "validation_error", message, [{ field: "window_start", message }]);
      }
      const station = db.stations.find((candidate) => candidate.id === input.station_id);
      const product = db.products.find((candidate) => candidate.id === input.product_id);
      if (!station || !product) return errorResponse(422, "validation_error", "Station ou produit inconnu.");
      const order = make(station, product, input.requested_l, {
        day: input.day,
        priority: input.priority,
        window_start: input.window_start ?? null,
        window_end: input.window_end ?? null,
        comment: input.comment ?? null,
      });
      state.orders.push(order);
      return HttpResponse.json(order, { status: 201 });
    }),

    http.put(`${API}/orders/:id`, async ({ request, params }) => {
      const user = authorize(request, ["dispatcher"]);
      if (user instanceof Response) return user;
      const order = find(params.id);
      if (!order) return notFound("Commande");
      return update(order, (await request.json()) as OrderInput);
    }),

    http.patch(`${API}/orders/:id`, async ({ request, params }) => {
      const user = authorize(request, ["dispatcher"]);
      if (user instanceof Response) return user;
      const order = find(params.id);
      if (!order) return notFound("Commande");
      const body = (await request.json()) as OrderPatch;
      state.patches.push({ id: order.id, body });
      return update(order, body);
    }),

    http.delete(`${API}/orders/:id`, ({ request, params }) => {
      const user = authorize(request, ["dispatcher"]);
      if (user instanceof Response) return user;
      const order = find(params.id);
      if (!order) return notFound("Commande");
      if (order.status !== "draft") {
        return errorResponse(
          409,
          "order_not_deletable",
          "Seule une commande en brouillon peut être supprimée.",
        );
      }
      state.orders = state.orders.filter((candidate) => candidate.id !== order.id);
      return new HttpResponse(null, { status: 204 });
    }),

    http.post(`${API}/orders/:id/:action`, ({ request, params }) => {
      const user = authorize(request, ["dispatcher"]);
      if (user instanceof Response) return user;
      const order = find(params.id);
      if (!order) return notFound("Commande");
      if (params.action === "confirm") {
        if (order.status !== "draft") return transitionError(order);
        const result = check(order);
        if (result.blocking) return capacityError(order, result);
        order.status = "confirmed";
        return HttpResponse.json({ ...order, warnings: result.warnings });
      }
      if (order.status !== "draft" && order.status !== "confirmed") return transitionError(order);
      order.status = params.action === "cancel" ? "cancelled" : "postponed";
      return HttpResponse.json(order);
    }),
  ];

  return { state, handlers };
}
