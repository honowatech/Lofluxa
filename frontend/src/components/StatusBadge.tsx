/**
 * Pastilles de statut : même libellé et même couleur partout pour un même statut.
 *   <StatusBadge kind="truck" value={truck.status} />
 *   <ExpiryBadge date={driver.license_expiry} />
 */
import { AlertTriangle, CircleAlert } from "lucide-react";

import { Badge, type Tone } from "@/components/ui/badge";
import { fr } from "@/i18n/fr";
import { EXPIRY_WARNING_DAYS } from "@/lib/config";
import { daysUntil, EMPTY, formatDate, todayLocal } from "@/lib/format";
import type { IsoDate } from "@/lib/types";

const TONES = {
  truck: { available: "success", maintenance: "warning", broken: "blocking", reserved: "info" },
  driver: { available: "success", rest: "neutral", leave: "info", sick: "warning" },
  order: {
    draft: "neutral",
    confirmed: "info",
    planned: "primary",
    loaded: "primary",
    delivered: "success",
    cancelled: "muted",
    postponed: "warning",
  },
  plan: { draft: "neutral", published: "success", archived: "muted" },
  trip: {
    planned: "neutral",
    at_depot: "info",
    loaded: "primary",
    in_progress: "warning",
    completed: "success",
  },
  stop: { pending: "neutral", delivered: "success", skipped: "warning" },
  import: { previewed: "info", applied: "success", rejected: "blocking" },
  priority: { normal: "muted", urgent: "blocking" },
  active: { true: "success", false: "muted" },
  severity: { blocking: "blocking", warning: "warning" },
  audit: { insert: "success", update: "info", delete: "blocking" },
} as const satisfies Record<string, Record<string, Tone>>;

export type StatusKind = keyof typeof TONES;

export function StatusBadge<K extends StatusKind>({
  kind,
  value,
  className,
}: {
  kind: K;
  value: keyof (typeof TONES)[K] | boolean | null | undefined;
  className?: string;
}) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">{EMPTY}</span>;
  const key = String(value);
  const tone = (TONES[kind] as Record<string, Tone>)[key] ?? "neutral";
  const label = (fr.status[kind] as Record<string, string>)[key] ?? key;
  return (
    <Badge tone={tone} className={className}>
      {label}
    </Badge>
  );
}

export type ExpiryState = "expired" | "soon" | "valid" | "missing";

/** État d'une date d'expiration par rapport au jour courant (Douala). */
export function expiryState(date: IsoDate | null | undefined, today: IsoDate = todayLocal()): ExpiryState {
  if (!date) return "missing";
  const days = daysUntil(date, today);
  if (days < 0) return "expired";
  return days <= EXPIRY_WARNING_DAYS ? "soon" : "valid";
}

/** Date d'expiration (permis, habilitation) : rouge si expirée, orange si proche, neutre sinon. */
export function ExpiryBadge({
  date,
  today = todayLocal(),
}: {
  date: IsoDate | null | undefined;
  today?: IsoDate;
}) {
  const state = expiryState(date, today);
  if (state === "missing" || !date) {
    return <span className="text-xs text-muted-foreground">{fr.status.expiry.missing}</span>;
  }
  const formatted = formatDate(date);
  if (state === "valid") {
    return (
      <span className="num text-xs" title={fr.status.expiry.valid(formatted)}>
        {formatted}
      </span>
    );
  }
  const days = daysUntil(date, today);
  const label =
    state === "expired"
      ? fr.status.expiry.expired(formatted)
      : days === 0
        ? fr.status.expiry.expiresToday
        : fr.status.expiry.expiresIn(days, formatted);
  return (
    <Badge tone={state === "expired" ? "blocking" : "warning"} data-expiry={state}>
      {state === "expired" ? (
        <CircleAlert className="size-3" aria-hidden />
      ) : (
        <AlertTriangle className="size-3" aria-hidden />
      )}
      {label}
    </Badge>
  );
}
