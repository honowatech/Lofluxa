/**
 * État du plan en cours d'édition (Zustand, spec §8.4).
 *
 * `plan` est ce que l'écran affiche : le dernier plan confirmé par le serveur (`confirmed`), ou — pendant
 * un appel — son état optimiste. Une seule modification à la fois : `begin` refuse tant qu'une autre attend.
 *   begin(op)  → état optimiste        commit(plan) → remplacement par la réponse du serveur
 *   rollback() → retour au plan confirmé (l'API a refusé)
 */
import { create } from "zustand";

import { applyOp, findStop, findTrip, remapSelection } from "./edits";
import type { EditOp, Plan, PlanView } from "./types";

export type StopZone = "detail" | "table";

export interface PlanEditState {
  plan: Plan | null;
  confirmed: Plan | null;
  pendingOp: EditOp | null;
  selectedTripId: string | null;
  selectedStopId: string | null;
  /** Tournée dont le tracé est survolé sur la carte (mise en évidence dans la liste). */
  hoveredTripId: string | null;
  /** Arrêt qui doit reprendre le focus clavier après le prochain rendu (suivi d'un déplacement). */
  focusStopId: string | null;
  /** Zone d'où vient la demande de focus : panneau de détail ou vue tableau. */
  focusZone: StopZone | null;
  view: PlanView;
  /** Message lu par les lecteurs d'écran après chaque modification. */
  announcement: string;

  load: (plan: Plan) => void;
  reset: () => void;
  begin: (op: EditOp) => boolean;
  commit: (plan: Plan) => void;
  rollback: () => void;
  selectTrip: (tripId: string | null) => void;
  selectStop: (stopId: string | null) => void;
  hoverTrip: (tripId: string | null) => void;
  requestFocus: (stopId: string | null, zone?: StopZone | null) => void;
  setView: (view: PlanView) => void;
  announce: (message: string) => void;
}

const INITIAL = {
  plan: null,
  confirmed: null,
  pendingOp: null,
  selectedTripId: null,
  selectedStopId: null,
  hoveredTripId: null,
  focusStopId: null,
  focusZone: null,
  announcement: "",
} satisfies Partial<PlanEditState>;

export const usePlanStore = create<PlanEditState>((set, get) => ({
  ...INITIAL,
  view: "map",

  load: (plan) => {
    const state = get();
    // Une réponse de lecture ne doit pas écraser une modification optimiste en attente.
    if (state.pendingOp) return;
    const selection = remapSelection(state.confirmed, plan, {
      tripId: state.selectedTripId,
      stopId: state.selectedStopId,
    });
    const sameLineage =
      !!state.confirmed &&
      (state.confirmed.id === plan.id ||
        (state.confirmed.root_plan_id ?? state.confirmed.id) === (plan.root_plan_id ?? plan.id));
    set({
      plan,
      confirmed: plan,
      selectedTripId: sameLineage ? selection.tripId : null,
      selectedStopId: sameLineage ? selection.stopId : null,
    });
  },

  reset: () => set({ ...INITIAL }),

  begin: (op) => {
    const { confirmed, pendingOp } = get();
    if (!confirmed || pendingOp) return false;
    const optimistic = applyOp(confirmed, op);
    if (optimistic === confirmed) return false;
    set({ plan: optimistic, pendingOp: op });
    return true;
  },

  commit: (plan) => {
    const state = get();
    const selection = remapSelection(state.plan, plan, {
      tripId: state.selectedTripId,
      stopId: state.selectedStopId,
    });
    const focus = remapSelection(state.plan, plan, { tripId: null, stopId: state.focusStopId }).stopId;
    set({
      plan,
      confirmed: plan,
      pendingOp: null,
      selectedTripId: selection.tripId,
      selectedStopId: selection.stopId,
      focusStopId: focus,
    });
  },

  rollback: () => set((state) => ({ plan: state.confirmed, pendingOp: null })),

  selectTrip: (tripId) =>
    set((state) => {
      if (!tripId || !findTrip(state.plan, tripId)) return { selectedTripId: null, selectedStopId: null };
      const keepStop = findStop(state.plan, state.selectedStopId)?.trip.id === tripId;
      return { selectedTripId: tripId, selectedStopId: keepStop ? state.selectedStopId : null };
    }),

  selectStop: (stopId) =>
    set((state) => {
      const at = findStop(state.plan, stopId);
      return at ? { selectedTripId: at.trip.id, selectedStopId: at.stop.id } : { selectedStopId: null };
    }),

  hoverTrip: (hoveredTripId) => set({ hoveredTripId }),
  requestFocus: (focusStopId, zone) =>
    set((state) => ({ focusStopId, focusZone: focusStopId ? (zone ?? state.focusZone) : null })),
  setView: (view) => set({ view }),
  announce: (announcement) => set({ announcement }),
}));
