/**
 * Horaires d'ouverture par jour de semaine (dépôts, stations).
 * Valeur : `{}` = ouvert en continu ; sinon `{ mon: [["06:00","18:00"]], …, sun: [] }` (jour sans plage = fermé).
 *   <OpeningHoursField name="opening_hours" label="Horaires de réception" />
 */
import { Copy, Plus, X } from "lucide-react";
import { Controller, useFormContext, type FieldValues, type Path } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/checkbox";
import { fr } from "@/i18n/fr";
import { WEEKDAY_KEYS, type OpeningHours, type WeekdayKey } from "@/lib/types";
import { cn } from "@/lib/utils";

import { TimeInput } from "./fields";
import { useFieldError } from "./Field";

const t = fr.fields.openingHours;
const DEFAULT_RANGE: [string, string] = ["06:00", "18:00"];
const WORKDAYS: WeekdayKey[] = ["mon", "tue", "wed", "thu", "fri"];

export const isAlwaysOpen = (value: OpeningHours | null | undefined): boolean =>
  !value || Object.keys(value).length === 0;

/** Résumé d'une ligne pour les tableaux : « lun.–ven. 06:00–18:00 · sam. 06:00–12:00 ». */
export function summarizeOpeningHours(value: OpeningHours | null | undefined): string {
  if (isAlwaysOpen(value)) return t.alwaysShort;
  const text = (day: WeekdayKey) => (value?.[day] ?? []).map(([a, b]) => `${a}–${b}`).join(", ");
  const groups: { from: WeekdayKey; to: WeekdayKey; text: string }[] = [];
  for (const day of WEEKDAY_KEYS) {
    const current = text(day);
    const last = groups[groups.length - 1];
    if (last && last.text === current) last.to = day;
    else groups.push({ from: day, to: day, text: current });
  }
  return (
    groups
      .filter((group) => group.text !== "")
      .map(
        (g) =>
          `${g.from === g.to ? t.daysShort[g.from] : `${t.daysShort[g.from]}–${t.daysShort[g.to]}`} ${g.text}`,
      )
      .join(" · ") || t.closed
  );
}

export function OpeningHoursInput({
  value,
  onChange,
  disabled,
  errors,
}: {
  value: OpeningHours;
  onChange: (value: OpeningHours) => void;
  disabled?: boolean;
  /** Message d'erreur par jour. */
  errors?: Partial<Record<WeekdayKey, string>>;
}) {
  const always = isAlwaysOpen(value);
  const setDay = (day: WeekdayKey, ranges: [string, string][]) => onChange({ ...value, [day]: ranges });

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={!always}
          disabled={disabled}
          onCheckedChange={(custom) =>
            onChange(
              custom
                ? (Object.fromEntries(
                    WEEKDAY_KEYS.map((day) => [day, day === "sun" ? [] : [[...DEFAULT_RANGE]]]),
                  ) as OpeningHours)
                : {},
            )
          }
        />
        {always ? t.always : t.custom}
      </label>

      {!always && (
        <div className="rounded-md border">
          {WEEKDAY_KEYS.map((day) => {
            const ranges = value[day] ?? [];
            return (
              <div
                key={day}
                role="group"
                aria-label={t.days[day]}
                className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 border-b px-2 py-1 last:border-b-0"
              >
                <span className="w-20 shrink-0 text-xs font-medium">{t.days[day]}</span>
                {ranges.length === 0 && <span className="text-xs text-muted-foreground">{t.closed}</span>}
                {ranges.map(([start, end], index) => (
                  <span key={index} className="flex items-center gap-1">
                    <TimeInput
                      aria-label={`${t.days[day]} ${t.from}`}
                      disabled={disabled}
                      value={start}
                      onChange={(next) =>
                        setDay(
                          day,
                          ranges.map((r, i) => (i === index ? [next, r[1]] : r)),
                        )
                      }
                      className="h-7"
                    />
                    <span className="text-xs text-muted-foreground">{t.to}</span>
                    <TimeInput
                      aria-label={`${t.days[day]} ${t.to}`}
                      disabled={disabled}
                      value={end}
                      onChange={(next) =>
                        setDay(
                          day,
                          ranges.map((r, i) => (i === index ? [r[0], next] : r)),
                        )
                      }
                      className="h-7"
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={disabled}
                      aria-label={`${t.removeRange} (${t.days[day]})`}
                      title={t.removeRange}
                      onClick={() =>
                        setDay(
                          day,
                          ranges.filter((_, i) => i !== index),
                        )
                      }
                    >
                      <X />
                    </Button>
                  </span>
                ))}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={disabled}
                  aria-label={`${t.addRange} (${t.days[day]})`}
                  title={t.addRange}
                  onClick={() => {
                    const last = ranges[ranges.length - 1];
                    setDay(day, [...ranges, last ? [last[1], "23:59"] : [...DEFAULT_RANGE]]);
                  }}
                >
                  <Plus />
                </Button>
                {day === "mon" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    className="ml-auto text-muted-foreground"
                    onClick={() =>
                      onChange({
                        ...value,
                        ...Object.fromEntries(
                          WORKDAYS.map((d) => [d, ranges.map((r) => [...r] as [string, string])]),
                        ),
                      })
                    }
                  >
                    <Copy />
                    {t.copyToAll}
                  </Button>
                )}
                {errors?.[day] && (
                  <p role="alert" className="w-full pl-[5.5rem] text-xs text-destructive">
                    {errors[day]}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function OpeningHoursField<T extends FieldValues>({
  name,
  label = t.label,
  disabled,
  className,
}: {
  name: Path<T>;
  label?: string;
  disabled?: boolean;
  className?: string;
}) {
  const { control, formState } = useFormContext<T>();
  const rootError = useFieldError<T>(name);
  // Erreurs par jour : zod les range sous `opening_hours.<jour>` (ou `.<jour>.<index>` pour une plage).
  const dayErrors: Partial<Record<WeekdayKey, string>> = {};
  const node = name
    .split(".")
    .reduce<unknown>((acc, key) => (acc as Record<string, unknown> | undefined)?.[key], formState.errors) as
    Record<string, unknown> | undefined;
  for (const day of WEEKDAY_KEYS) {
    const entry = node?.[day] as
      { message?: string; root?: { message?: string } } | { message?: string }[] | undefined;
    if (!entry) continue;
    const message = Array.isArray(entry)
      ? entry.flat().find((e) => e?.message)?.message
      : (entry.message ??
        entry.root?.message ??
        (
          Object.values(entry)
            .flat()
            .find((e) => (e as { message?: string })?.message) as { message?: string } | undefined
        )?.message);
    if (message) dayErrors[day] = message;
  }
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <span className="text-xs font-medium text-foreground/80">{label}</span>
      <Controller
        control={control}
        name={name}
        render={({ field }) => (
          <OpeningHoursInput
            value={(field.value as OpeningHours | null) ?? {}}
            onChange={field.onChange}
            disabled={disabled}
            errors={dayErrors}
          />
        )}
      />
      {rootError && (
        <p role="alert" className="text-xs text-destructive">
          {rootError}
        </p>
      )}
    </div>
  );
}
