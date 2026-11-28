/** Éléments communs aux onglets Camions et Chauffeurs : marquage du jour, cellule d'affectabilité. */
import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import { z } from "zod";

import { EntityFormDialog, TextField, zOptionalText } from "@/components/forms";
import { Badge } from "@/components/ui/badge";
import { fr } from "@/i18n/fr";

const t = fr.screens.availability.resource;

/** Noms cités dans un bandeau : les premiers, puis « et n autres » (le tableau donne la liste complète). */
const MAX_NAMES = 6;
export function nameList(names: string[]): string {
  if (names.length <= MAX_NAMES) return names.join(", ");
  return `${names.slice(0, MAX_NAMES).join(", ")} ${t.andOthers(names.length - MAX_NAMES)}`;
}

export const dayOptions = [
  { value: "true", label: t.availableToday },
  { value: "false", label: t.unavailableToday },
];
export const assignableOptions = [
  { value: "true", label: t.assignable },
  { value: "false", label: t.notAssignable },
];

const markSchema = z.object({ reason: zOptionalText(200) });

/** Motif (facultatif, question L4-13) du marquage « indisponible pour la journée ». */
export function MarkUnavailableDialog({
  target,
  onClose,
  onSubmit,
}: {
  /** Ressources à marquer (libellés affichés) ; `null` = boîte fermée. */
  target: { labels: string[]; reason?: string | null } | null;
  onClose: () => void;
  onSubmit: (reason: string | null) => Promise<unknown>;
}) {
  return (
    <EntityFormDialog
      open={target !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t.markTitle}
      description={target?.labels.join(", ")}
      schema={markSchema}
      defaultValues={{ reason: target?.reason ?? "" }}
      submitLabel={t.markSubmit}
      placement="center"
      onSubmit={(values) => onSubmit(values.reason)}
    >
      <TextField
        name="reason"
        label={t.reason}
        required={false}
        placeholder={t.reasonPlaceholder}
        hint={t.markHint}
        autoFocus
      />
    </EntityFormDialog>
  );
}

export function DayBadge({ available, reason }: { available: boolean; reason?: string | null }) {
  if (available) return <span className="text-xs text-muted-foreground">{t.availableShort}</span>;
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={reason ?? undefined}>
      <Badge tone="warning" className="shrink-0">
        {t.unavailableShort}
      </Badge>
      {reason && <span className="max-w-40 truncate text-xs">{reason}</span>}
    </span>
  );
}

/** Affectabilité d'une ressource : motif du blocage toujours lisible, code RM-xx en tête. */
export function AssignabilityCell({
  assignable,
  reason,
  ruleCode,
  blocking,
}: {
  assignable: boolean;
  reason: string | null;
  ruleCode: string | null;
  /** Blocage par une règle bloquante mise en évidence (RM-03). */
  blocking?: boolean;
}) {
  if (assignable) {
    return (
      <Badge tone="success">
        <CircleCheck className="size-3" aria-hidden />
        {t.assignable}
      </Badge>
    );
  }
  const Icon = blocking ? CircleAlert : TriangleAlert;
  return (
    <span
      className="flex min-w-0 items-center gap-1.5"
      data-rule={ruleCode ?? undefined}
      title={reason ?? undefined}
    >
      <Badge tone={blocking ? "blocking" : "warning"} className="shrink-0">
        <Icon className="size-3" aria-hidden />
        {ruleCode ?? t.notAssignable}
      </Badge>
      <span
        className={
          blocking ? "max-w-48 truncate text-xs font-medium text-blocking" : "max-w-48 truncate text-xs"
        }
      >
        {reason ?? t.notAssignable}
      </span>
    </span>
  );
}
