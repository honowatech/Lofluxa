/**
 * Choix des deux plans à comparer (F8.4 : « deux plans quelconques »). Chaque côté a son jour, car la
 * journée A (référence) et la journée B (plan exécuté) peuvent être deux dates différentes.
 */
import { ArrowLeftRight } from "lucide-react";
import { useId } from "react";

import { Spinner, Tip } from "@/components";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/forms";
import { NativeSelect } from "@/components/ui/input";
import { fr } from "@/i18n/fr";
import { errorMessage } from "@/lib/api";
import { formatLocalTime } from "@/lib/format";
import type { IsoDate } from "@/lib/types";

import { SIDE_LABEL, type PlanRow, type Side } from "./api";
import { SideChip } from "./shared";

const t = fr.screens.comparison;

export function planOptionLabel(plan: PlanRow): string {
  const base = t.picker.option(
    t.kinds[plan.kind],
    plan.version,
    fr.status.plan[plan.status],
    plan.label ?? null,
  );
  return plan.computed_at ? `${base} (${formatLocalTime(plan.computed_at)})` : base;
}

export interface SidePickerProps {
  side: Side;
  day: IsoDate;
  planId: string | null;
  plans: PlanRow[] | undefined;
  loading: boolean;
  error: unknown;
  onDayChange: (day: IsoDate) => void;
  onPlanChange: (planId: string | null) => void;
}

function SidePicker({
  side,
  day,
  planId,
  plans,
  loading,
  error,
  onDayChange,
  onPlanChange,
}: SidePickerProps) {
  const ids = useId();
  const label = SIDE_LABEL[side];
  const known = plans?.some((plan) => plan.id === planId) ?? false;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1" data-testid={`picker-${side}`}>
      <p className="flex items-center gap-1.5 text-xs font-semibold">
        <SideChip side={side} />
        {side === "a" ? t.picker.sideA : t.picker.sideB}
        {loading && <Spinner className="size-3" />}
      </p>
      <div className="flex min-w-0 gap-1.5">
        <DateInput
          id={`${ids}-day`}
          value={day}
          required
          aria-label={t.picker.day(label)}
          onChange={(next) => next && onDayChange(next)}
          wrapperClassName="w-[9rem] shrink-0"
        />
        <NativeSelect
          id={`${ids}-plan`}
          aria-label={t.picker.plan(label)}
          value={known ? (planId ?? "") : ""}
          disabled={!plans || plans.length === 0}
          onChange={(event) => onPlanChange(event.target.value || null)}
          className="min-w-0 flex-1"
        >
          <option value="">{plans && plans.length === 0 ? t.picker.none : t.picker.choose}</option>
          {plans?.map((plan) => (
            <option key={plan.id} value={plan.id}>
              {planOptionLabel(plan)}
            </option>
          ))}
        </NativeSelect>
      </div>
      {!!error && (
        <p role="alert" className="text-2xs text-blocking">
          {t.picker.loadFailed} : {errorMessage(error)}
        </p>
      )}
    </div>
  );
}

export function PlanPicker({
  a,
  b,
  onSwap,
  auto,
}: {
  a: Omit<SidePickerProps, "side">;
  b: Omit<SidePickerProps, "side">;
  onSwap: () => void;
  /** Vrai tant que la sélection est la présélection automatique. */
  auto: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-1 rounded-md border bg-card px-3 py-2.5">
      <legend className="sr-only">{t.picker.legend}</legend>
      <div className="flex flex-wrap items-end gap-x-2 gap-y-2">
        <SidePicker side="a" {...a} />
        <Tip label={t.picker.swap}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t.picker.swap}
            disabled={!a.planId && !b.planId}
            onClick={onSwap}
          >
            <ArrowLeftRight />
          </Button>
        </Tip>
        <SidePicker side="b" {...b} />
      </div>
      {auto && (a.planId || b.planId) && <p className="text-2xs text-muted-foreground">{t.picker.auto}</p>}
    </fieldset>
  );
}
