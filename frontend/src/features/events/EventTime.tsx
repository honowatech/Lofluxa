/** Heure de l'événement, facultative : heure locale de Douala du jour J → horodatage UTC (`occurred_at`). */
import { useId } from "react";

import { normalizeTime, TimeInput } from "@/components/forms";
import { Label } from "@/components/ui/label";
import { fr } from "@/i18n/fr";
import { dayBoundsUtc, hmToSeconds } from "@/lib/format";
import type { IsoDate } from "@/lib/types";

const t = fr.screens.events.eventTime;

/** `valid` : saisie vide ou heure correcte ; `occurredAt` : `null` si vide (le serveur prend « maintenant »). */
export function parseEventTime(day: IsoDate, text: string): { valid: boolean; occurredAt: string | null } {
  const local = normalizeTime(text);
  if (local === "") return { valid: true, occurredAt: null };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(local)) return { valid: false, occurredAt: null };
  return {
    valid: true,
    occurredAt: new Date(Date.parse(dayBoundsUtc(day).from) + hmToSeconds(local) * 1000).toISOString(),
  };
}

export function EventTimeField({
  label,
  hint = t.hint,
  value,
  onChange,
  invalid,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>
        {label}
        <span className="ml-1 font-normal text-muted-foreground">({fr.common.optional})</span>
      </Label>
      <TimeInput
        id={id}
        value={value}
        onChange={onChange}
        aria-invalid={invalid}
        aria-describedby={`${id}-hint`}
      />
      <p id={`${id}-hint`} className={invalid ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
        {invalid ? t.invalid : hint}
      </p>
    </div>
  );
}
