/** Résumé lisible d'un événement du journal, construit à partir de son `payload` (aucun appel réseau). */
import { fr } from "@/i18n/fr";
import { formatLiters, formatNumber } from "@/lib/format";
import { withDay } from "@/lib/useDay";
import type { IsoDate } from "@/lib/types";

import type { EventItem } from "./api";

const t = fr.screens.events;

export interface EventLink {
  to: string;
  label: string;
}
export interface EventSummary {
  /** Phrase principale. */
  title: string;
  /** Précisions (volumes, motif, arrêts transférés…). */
  details: string[];
  /** Vrai : l'événement porte une alerte (écart RM-13, arrêt sauté, tournées impactées). */
  warning: boolean;
  links: EventLink[];
}

type Payload = Record<string, unknown>;
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const list = (value: unknown): Payload[] =>
  Array.isArray(value)
    ? value.filter((item): item is Payload => typeof item === "object" && item !== null)
    : [];

/** Écart signé en pourcentage : `−0,17 %`. */
function signedPercent(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${formatNumber(Math.abs(value), 2)} %`;
}

export const planLink = (planId: string, day: IsoDate) => withDay(`/plan?plan=${planId}`, day);
export const tripLink = (tripId: string, day: IsoDate) => withDay(`/suivi?trip=${tripId}`, day);
export const loadingLink = (tripId: string, day: IsoDate) => withDay(`/chargement?trip=${tripId}`, day);

function reassignment(event: EventItem, p: Payload, day: IsoDate, kind: "truck" | "driver"): EventSummary {
  const replacementDriver = str(p.replacement_driver_name);
  const moved = num(p.transferred_stop_count);
  const details: string[] = [];
  if (kind === "truck" && replacementDriver) details.push(t.summary.withDriver(replacementDriver));
  if (moved !== null) details.push(t.summary.transferred(moved, num(p.kept_stop_count)));
  const newPlan = str(p.new_plan_id);
  const links: EventLink[] = [];
  if (newPlan) links.push({ to: planLink(newPlan, day), label: t.feed.links.newPlan });
  else if (event.plan_id) links.push({ to: planLink(event.plan_id, day), label: t.feed.links.plan });
  return {
    title:
      str(p.summary) ??
      (kind === "truck"
        ? t.summary.truckBreakdown(str(p.truck_plate) ?? event.truck_plate, str(p.replacement_truck_plate))
        : t.summary.driverUnavailable(str(p.driver_name), replacementDriver)),
    details,
    warning: true,
    links,
  };
}

export function summarize(event: EventItem, day: IsoDate): EventSummary {
  const p = event.payload;
  const planLinks: EventLink[] = event.plan_id
    ? [{ to: planLink(event.plan_id, day), label: t.feed.links.plan }]
    : [];

  switch (event.type) {
    case "truck_breakdown":
      return reassignment(event, p, day, "truck");
    case "driver_unavailable":
      return reassignment(event, p, day, "driver");

    case "product_shortage": {
      const impacted = Array.isArray(p.impacted_trips) ? p.impacted_trips.length : num(p.impacted_trip_count);
      const previous = num(p.previous_available_l);
      const details: string[] = [];
      if (previous !== null) details.push(t.summary.shortagePrevious(formatLiters(previous)));
      if (impacted !== null) details.push(t.summary.impacted(impacted));
      return {
        title:
          str(p.summary) ??
          t.summary.shortage(
            str(p.product_label) ?? str(p.product_code),
            str(p.depot_code) ?? str(p.depot_name),
            formatLiters(num(p.new_available_l)),
          ),
        details,
        warning: (impacted ?? 0) > 0,
        links: planLinks,
      };
    }

    case "manual_edit":
      return { title: str(p.summary) ?? t.summary.manualEdit, details: [], warning: false, links: planLinks };
    case "publish":
      return {
        title: str(p.summary) ?? t.summary.publish(num(p.plan_version)),
        details: [],
        warning: false,
        links: planLinks,
      };
    case "replan":
      return { title: str(p.summary) ?? t.summary.replan, details: [], warning: false, links: planLinks };

    case "loading_recorded": {
      const loaded = num(p.volume_15_total_l);
      const planned = num(p.planned_total_l);
      const gap = num(p.gap_pct);
      const out = p.out_of_tolerance === true;
      const details: string[] = [];
      if (loaded !== null && planned !== null) {
        details.push(
          t.summary.loadingVolumes(
            formatLiters(loaded),
            formatLiters(planned),
            gap !== null ? signedPercent(gap) : null,
          ),
        );
      }
      if (out) details.push(t.feed.rm13);
      return {
        title: t.summary.loading(p.updated === true, str(p.depot_ticket_no)),
        details,
        warning: out,
        links: event.trip_id ? [{ to: loadingLink(event.trip_id, day), label: t.feed.links.loading }] : [],
      };
    }

    case "delivery_recorded": {
      const skipped = p.status === "skipped";
      const lines = list(p.deliveries);
      const details: string[] = [];
      if (skipped) {
        const reason = str(p.skip_reason);
        if (reason) details.push(t.summary.skipReason(reason));
      } else if (lines.length > 0) {
        const total = (key: string) => lines.reduce((sum, line) => sum + (num(line[key]) ?? 0), 0);
        details.push(
          t.summary.deliveredVolumes(formatLiters(total("actual_l")), formatLiters(total("planned_l"))),
        );
      }
      const station = str(p.station_code);
      return {
        title: skipped ? t.summary.skipped(num(p.seq), station) : t.summary.delivered(num(p.seq), station),
        details,
        warning: skipped,
        links: event.trip_id ? [{ to: tripLink(event.trip_id, day), label: t.feed.links.trip }] : [],
      };
    }

    default:
      return { title: str(p.summary) ?? String(event.type), details: [], warning: false, links: planLinks };
  }
}
