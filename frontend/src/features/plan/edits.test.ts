import { beforeEach, describe, expect, it } from "vitest";

import {
  applyOp,
  dropOp,
  findStop,
  keyboardMove,
  opRequest,
  reconcileUrgentViolations,
  remapSelection,
} from "./edits";
import { usePlanStore } from "./store";
import { asNewVersion, makePlan, unserved, violation } from "./testing/fixtures";

const stopsOf = (plan: ReturnType<typeof makePlan>, tripId: string) =>
  plan.trips.find((trip) => trip.id === tripId)?.stops.map((stop) => `${stop.seq}:${stop.station_code}`);

describe("modifications optimistes (edits)", () => {
  it("réordonne les arrêts d'une tournée et renumérote", () => {
    const plan = makePlan();
    const next = applyOp(plan, {
      type: "reorder",
      tripId: "trip-1",
      stopIds: ["stop-c", "stop-a", "stop-b"],
    });
    expect(stopsOf(next, "trip-1")).toEqual(["1:DLA04", "2:DLA01", "3:DLA02"]);
    expect(stopsOf(plan, "trip-1")).toEqual(["1:DLA01", "2:DLA02", "3:DLA04"]); // l'original n'est pas modifié
  });

  it("déplace un arrêt vers une autre tournée : volumes et remplissage suivent", () => {
    const next = applyOp(makePlan(), {
      type: "move",
      tripId: "trip-1",
      stopId: "stop-b",
      toTripId: "trip-2",
      toSeq: 1,
    });
    expect(stopsOf(next, "trip-1")).toEqual(["1:DLA01", "2:DLA04"]);
    expect(stopsOf(next, "trip-2")).toEqual(["1:DLA02", "2:DLA07"]);
    expect(next.trips[0].planned_l).toBe(16000);
    expect(next.trips[1].planned_l).toBe(11000);
    expect(next.trips[1].fill_rate).toBeCloseTo(0.44);
  });

  it("supprime la tournée vidée de son dernier arrêt (L5-10)", () => {
    const next = applyOp(makePlan(), {
      type: "move",
      tripId: "trip-2",
      stopId: "stop-d",
      toTripId: "trip-1",
      toSeq: 4,
    });
    expect(next.trips.map((trip) => trip.id)).toEqual(["trip-1"]);
    expect(stopsOf(next, "trip-1")).toEqual(["1:DLA01", "2:DLA02", "3:DLA04", "4:DLA07"]);
  });

  it("change le camion (plan de chargement à recalculer) ou retire le chauffeur", () => {
    const plan = makePlan();
    const truck = applyOp(plan, {
      type: "assign",
      tripId: "trip-1",
      truck: { id: "truck-9", plate: "CE-409-ZZ", capacity_l: 13000 },
    });
    expect(truck.trips[0]).toMatchObject({ truck_plate: "CE-409-ZZ", loads: [], driver_name: "Roger Abega" });
    expect(truck.trips[0].fill_rate).toBeCloseTo(20000 / 13000);
    const driver = applyOp(plan, { type: "assign", tripId: "trip-1", driver: null });
    expect(driver.trips[0]).toMatchObject({ driver_id: null, driver_name: null, truck_plate: "LT-401-AA" });
  });

  it("une opération qui ne s'applique pas laisse le plan intact (même référence)", () => {
    const plan = makePlan();
    expect(applyOp(plan, { type: "lock", tripId: "inconnue", locked: true })).toBe(plan);
    expect(applyOp(plan, { type: "reorder", tripId: "trip-1", stopIds: ["stop-a"] })).toBe(plan);
  });

  it("traduit chaque opération en appel de l'API (spec §9)", () => {
    expect(opRequest("p", { type: "move", tripId: "t1", stopId: "s", toTripId: "t2", toSeq: 3 })).toEqual({
      path: "/plans/p/trips/t1/move-stop",
      body: { stop_id: "s", to_trip_id: "t2", to_seq: 3 },
    });
    expect(opRequest("p", { type: "reorder", tripId: "t1", stopIds: ["a", "b"] })).toEqual({
      path: "/plans/p/trips/t1/reorder",
      body: { stop_ids: ["a", "b"] },
    });
    expect(opRequest("p", { type: "lock", tripId: "t1", locked: false })).toEqual({
      path: "/plans/p/trips/t1/unlock",
    });
    // `driver: null` retire le chauffeur ; un champ absent reste inchangé.
    expect(opRequest("p", { type: "assign", tripId: "t1", driver: null }).body).toEqual({ driver_id: null });
    expect(opRequest("p", { type: "assign", tripId: "t1", truck: { id: "k", plate: "X" } }).body).toEqual({
      truck_id: "k",
    });
  });
});

describe("déplacement au clavier (Alt + ↑ / ↓)", () => {
  it("dans la tournée : réordonnancement d'un cran", () => {
    expect(keyboardMove(makePlan(), "stop-a", "down")).toEqual({
      type: "reorder",
      tripId: "trip-1",
      stopIds: ["stop-b", "stop-a", "stop-c"],
    });
  });

  it("au bord : passage à la tournée voisine (début de la suivante, fin de la précédente)", () => {
    expect(keyboardMove(makePlan(), "stop-c", "down")).toEqual({
      type: "move",
      tripId: "trip-1",
      stopId: "stop-c",
      toTripId: "trip-2",
      toSeq: 1,
    });
    expect(keyboardMove(makePlan(), "stop-d", "up")).toEqual({
      type: "move",
      tripId: "trip-2",
      stopId: "stop-d",
      toTripId: "trip-1",
      toSeq: 4,
    });
  });

  it("impossible au-delà de la première et de la dernière tournée, ou pour un arrêt déjà livré", () => {
    const plan = makePlan();
    expect(keyboardMove(plan, "stop-a", "up")).toBeNull();
    expect(keyboardMove(plan, "stop-d", "down")).toBeNull();
    plan.trips[0].stops[1].status = "delivered";
    expect(keyboardMove(plan, "stop-b", "down")).toBeNull();
  });
});

describe("dépôt d'un arrêt (glisser-déposer)", () => {
  it("sur un arrêt d'une autre tournée : insertion à sa place", () => {
    expect(dropOp(makePlan(), "stop-a", { type: "stop", stopId: "stop-d" })).toEqual({
      type: "move",
      tripId: "trip-1",
      stopId: "stop-a",
      toTripId: "trip-2",
      toSeq: 1,
    });
  });
  it("sur une autre tournée : ajout en fin ; sur sa propre tournée : rien", () => {
    expect(dropOp(makePlan(), "stop-a", { type: "trip", tripId: "trip-2" })).toMatchObject({ toSeq: 2 });
    expect(dropOp(makePlan(), "stop-a", { type: "trip", tripId: "trip-1" })).toBeNull();
  });
  it("sur un arrêt de la même tournée : réordonnancement", () => {
    expect(dropOp(makePlan(), "stop-c", { type: "stop", stopId: "stop-a" })).toEqual({
      type: "reorder",
      tripId: "trip-1",
      stopIds: ["stop-c", "stop-a", "stop-b"],
    });
  });
});

describe("nouvelle version d'un plan publié (RM-18)", () => {
  it("retrouve la tournée et l'arrêt sélectionnés malgré les nouveaux identifiants", () => {
    const published = makePlan({ status: "published" });
    const draft = asNewVersion(published);
    expect(remapSelection(published, draft, { tripId: "trip-1", stopId: "stop-b" })).toEqual({
      tripId: "trip-1-v2",
      stopId: "stop-b-v2",
    });
    expect(remapSelection(published, draft, { tripId: "trip-2", stopId: null })).toEqual({
      tripId: "trip-2-v2",
      stopId: null,
    });
  });
});

describe("RM-15 — commande urgente non servie", () => {
  const rm15 = violation("u", "RM-15", "blocking", "Commande urgente non servie : station DLA09.");

  it("reste bloquante tant que la commande n'est pas reportée", () => {
    const plan = makePlan({
      unserved: [unserved("u", "DLA09", "OLA Makepe", true)],
      violations: [rm15],
      blocking_count: 1,
      publishable: false,
    });
    expect(reconcileUrgentViolations(plan)).toBe(plan);
  });

  it("n'est plus comptée une fois la commande reportée, même si le plan lu la porte encore", () => {
    const plan = makePlan({
      unserved: [unserved("u", "DLA09", "OLA Makepe", true, "postponed")],
      violations: [rm15, violation("w", "RM-10", "warning", "Arrivée tardive.")],
      blocking_count: 1,
      publishable: false,
    });
    const reconciled = reconcileUrgentViolations(plan);
    expect(reconciled.violations.map((v) => v.rule_code)).toEqual(["RM-10"]);
    expect(reconciled).toMatchObject({ blocking_count: 0, publishable: true });
  });
});

describe("store d'édition", () => {
  beforeEach(() => {
    usePlanStore.getState().reset();
    usePlanStore.getState().load(makePlan());
  });
  const reorder = { type: "reorder", tripId: "trip-1", stopIds: ["stop-b", "stop-a", "stop-c"] } as const;

  it("begin affiche l'état optimiste, commit le remplace par la réponse du serveur", () => {
    const store = usePlanStore.getState();
    expect(store.begin(reorder)).toBe(true);
    expect(usePlanStore.getState().plan?.trips[0].stops[0].id).toBe("stop-b");
    expect(usePlanStore.getState().confirmed?.trips[0].stops[0].id).toBe("stop-a");
    const server = applyOp(makePlan(), reorder);
    server.trips[0].distance_m = 1234;
    store.commit(server);
    expect(usePlanStore.getState()).toMatchObject({ pendingOp: null, plan: server, confirmed: server });
  });

  it("rollback revient exactement au plan confirmé", () => {
    const confirmed = usePlanStore.getState().confirmed;
    usePlanStore.getState().begin(reorder);
    usePlanStore.getState().rollback();
    expect(usePlanStore.getState().plan).toBe(confirmed);
    expect(usePlanStore.getState().pendingOp).toBeNull();
  });

  it("une seule modification à la fois ; une lecture ne l'écrase pas", () => {
    const store = usePlanStore.getState();
    expect(store.begin(reorder)).toBe(true);
    expect(store.begin({ type: "lock", tripId: "trip-2", locked: true })).toBe(false);
    store.load(makePlan({ version: 7 }));
    expect(usePlanStore.getState().plan?.trips[0].stops[0].id).toBe("stop-b");
    expect(usePlanStore.getState().plan?.version).toBe(1);
  });

  it("la sélection suit le plan : arrêt → tournée, nouvelle version → nouveaux identifiants", () => {
    const store = usePlanStore.getState();
    store.selectStop("stop-d");
    expect(usePlanStore.getState()).toMatchObject({ selectedTripId: "trip-2", selectedStopId: "stop-d" });
    store.selectTrip("trip-1");
    expect(usePlanStore.getState()).toMatchObject({ selectedTripId: "trip-1", selectedStopId: null });
    store.selectStop("stop-b");
    store.requestFocus("stop-b", "detail");
    store.commit(asNewVersion(makePlan({ status: "published" })));
    expect(usePlanStore.getState()).toMatchObject({
      selectedTripId: "trip-1-v2",
      selectedStopId: "stop-b-v2",
      focusStopId: "stop-b-v2",
    });
    expect(findStop(usePlanStore.getState().plan, "stop-b-v2")?.trip.seq).toBe(1);
  });

  it("changer de plan (autre lignée) efface la sélection", () => {
    usePlanStore.getState().selectTrip("trip-1");
    usePlanStore.getState().load(makePlan({ id: "autre", root_plan_id: "autre" }));
    expect(usePlanStore.getState().selectedTripId).toBeNull();
  });
});
