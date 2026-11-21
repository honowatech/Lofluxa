/** Contexte de l'écran Plan : droits d'édition et fonction de modification, partagés par les panneaux. */
import { createContext, useContext } from "react";

import { routeColor } from "@/components";

import type { EditOp, Trip } from "./types";
import type { StopZone } from "./store";

export interface PlanUi {
  /** Faux : plan en lecture seule (rôle, journée de référence, version archivée…). */
  canEdit: boolean;
  /** Une modification ou un recalcul est en cours : les valeurs calculées affichées sont provisoires. */
  busy: boolean;
  edit: (op: EditOp, options?: { focusStopId?: string; zone?: StopZone }) => Promise<boolean>;
  /** Les PDF des feuilles de route sont proposés (plan publié ou archivé, F5.4). */
  showRouteSheets: boolean;
}

export const PlanUiContext = createContext<PlanUi>({
  canEdit: false,
  busy: false,
  edit: async () => false,
  showRouteSheets: false,
});

export const usePlanUi = (): PlanUi => useContext(PlanUiContext);

/** Couleur d'une tournée : stable d'un rendu à l'autre (liée à son numéro), identique dans la liste, la carte et le tableau. */
export const tripColor = (trip: Pick<Trip, "seq">): string => routeColor(Math.max(0, trip.seq - 1));
