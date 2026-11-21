/**
 * Édition manuelle du plan (F5.1 à F5.3) : mise à jour optimiste, appel à l'API, puis remplacement par le
 * plan renvoyé (distances, durées, heures, remplissage et violations recalculés par le serveur).
 * Si l'API refuse : retour au plan confirmé et message. Si le plan visé était publié, l'API renvoie une
 * NOUVELLE version brouillon (autre `id`, RM-18) : l'écran bascule dessus et l'annonce.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { notify, useConfirm } from "@/components";
import { fr } from "@/i18n/fr";
import { isApiError } from "@/lib/api";

import { planKeys, sendEdit, usePlanCache } from "./api";
import { findStop, findTrip } from "./edits";
import { usePlanStore, type StopZone } from "./store";
import type { EditOp, Plan } from "./types";

const t = fr.screens.plan;

/** Phrase décrivant la modification, lue par les lecteurs d'écran une fois le plan à jour. */
export function describeOp(before: Plan, after: Plan, op: EditOp): string {
  const seqBefore = findTrip(before, op.tripId)?.seq ?? 0;
  switch (op.type) {
    case "move":
    case "reorder": {
      const stopId = op.type === "move" ? op.stopId : null;
      if (!stopId) return t.edit.reorderedTrip(seqBefore);
      const station = findStop(before, stopId)?.stop.station_name ?? "";
      const origin = findStop(before, stopId)?.stop;
      const at =
        findStop(after, stopId) ??
        after.trips
          .flatMap((trip) => trip.stops.map((stop) => ({ trip, stop })))
          .find(
            ({ stop }) =>
              stop.station_id === origin?.station_id &&
              stop.deliveries.some((d) => origin?.deliveries.some((o) => o.order_id === d.order_id)),
          );
      if (!at) return t.edit.reorderedTrip(seqBefore);
      const text = t.edit.moved(station, at.trip.seq, at.stop.seq);
      const removed = !after.trips.some((trip) => trip.seq === seqBefore);
      return removed ? `${text} ${t.edit.tripRemoved(seqBefore)}` : text;
    }
    case "assign":
      return t.edit.assigned(seqBefore);
    case "lock":
      return op.locked ? t.edit.locked(seqBefore) : t.edit.unlocked(seqBefore);
  }
}

export interface PlanEditor {
  /** Applique une modification ; `true` si le serveur l'a acceptée. */
  edit: (op: EditOp, options?: { focusStopId?: string; zone?: StopZone }) => Promise<boolean>;
}

export function usePlanEditor(openPlan: (planId: string) => void): PlanEditor {
  const client = useQueryClient();
  const cache = usePlanCache();
  const confirm = useConfirm();

  const edit = useCallback<PlanEditor["edit"]>(
    async (op, options) => {
      const store = usePlanStore.getState();
      const before = store.confirmed;
      if (!before || !store.begin(op)) return false;
      if (options?.focusStopId) store.requestFocus(options.focusStopId, options.zone ?? null);
      try {
        const next = await sendEdit(before.id, op);
        usePlanStore.getState().commit(next);
        cache(next);
        usePlanStore.getState().announce(describeOp(before, next, op));
        if (next.id !== before.id) {
          // Plan publié → nouvelle version brouillon : nouveaux identifiants, nouvelle adresse.
          openPlan(next.id);
          notify.info(t.edit.newVersionTitle(next.version), t.edit.newVersionBody(before.version));
          usePlanStore.getState().announce(t.edit.newVersionTitle(next.version));
        }
        return true;
      } catch (error) {
        usePlanStore.getState().rollback();
        void client.invalidateQueries({ queryKey: planKeys.one(before.id) });
        void client.invalidateQueries({ queryKey: planKeys.ofDay(before.day) });
        if (isApiError(error) && error.code === "draft_version_exists") {
          const detail = error.details[0] as { draft_plan_id?: string; version?: number } | undefined;
          const draftId = detail?.draft_plan_id;
          if (
            draftId &&
            (await confirm({
              title: t.edit.draftExistsTitle,
              description: t.edit.draftExistsBody(detail?.version),
              confirmLabel: t.edit.draftExistsAction,
            }))
          ) {
            openPlan(draftId);
          } else if (!draftId) notify.apiError(error, t.edit.failed);
        } else if (isApiError(error) && ["plan_is_reference", "plan_archived"].includes(error.code)) {
          notify.warning(t.edit.readOnlyTitle, error.message);
        } else if (isApiError(error) && error.isNotFound) {
          notify.warning(t.edit.failed, t.edit.conflictReload);
        } else {
          notify.apiError(error, t.edit.failed);
        }
        return false;
      }
    },
    [cache, client, confirm, openPlan],
  );

  return { edit };
}
