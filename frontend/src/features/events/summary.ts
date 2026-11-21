/** Présentation d'un événement du journal : le résumé vient du serveur ; ici, alerte et liens. */
import { fr } from "@/i18n/fr";
import type { IsoDate } from "@/lib/types";
import { withDay } from "@/lib/useDay";

import type { EventOut, ShortageStatus } from "./api";

const t = fr.screens.events;

export interface EventLink {
  to: string;
  label: string;
}
export interface EventPresentation {
  /** Précisions tirées du `payload` réel (motif saisi, version restée en brouillon). */
  details: string[];
  /** Vrai : l'événement porte une alerte (écart RM-13, arrêt sauté, pénurie ouverte, brouillon bloqué). */
  warning: boolean;
  links: EventLink[];
  /** Pénurie déclarée : état de l'alerte (`payload.status`). */
  shortageStatus: ShortageStatus | null;
}

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export const planLink = (planId: string, day: IsoDate) => withDay(`/plan?plan=${planId}`, day);
export const tripLink = (tripId: string, day: IsoDate) => withDay(`/suivi?trip=${tripId}`, day);
export const loadingLink = (tripId: string, day: IsoDate) => withDay(`/chargement?trip=${tripId}`, day);

export function present(event: EventOut, day: IsoDate): EventPresentation {
  const p = event.payload;
  const planLinks: EventLink[] = event.plan_id
    ? [{ to: planLink(event.plan_id, day), label: t.feed.links.plan }]
    : [];
  const base: EventPresentation = { details: [], warning: false, links: planLinks, shortageStatus: null };

  switch (event.type) {
    case "truck_breakdown":
    case "driver_unavailable": {
      const details: string[] = [];
      const reason = str(p.reason);
      if (reason) details.push(t.feed.reason(reason));
      const blocking = num(p.blocking_count) ?? 0;
      return { ...base, details, warning: p.published === false && blocking > 0 };
    }
    case "product_shortage": {
      const status =
        p.action === "declared" &&
        (p.status === "open" || p.status === "resolved" || p.status === "no_impact")
          ? p.status
          : null;
      const comment = str(p.comment);
      return {
        ...base,
        details: comment ? [t.feed.comment(comment)] : [],
        warning: status === "open",
        shortageStatus: status,
      };
    }
    case "loading_recorded":
      return {
        ...base,
        warning: p.out_of_tolerance === true,
        links: event.trip_id ? [{ to: loadingLink(event.trip_id, day), label: t.feed.links.loading }] : [],
      };
    case "delivery_recorded":
      return {
        ...base,
        warning: p.status === "skipped",
        links: event.trip_id ? [{ to: tripLink(event.trip_id, day), label: t.feed.links.trip }] : [],
      };
    default:
      return base;
  }
}
