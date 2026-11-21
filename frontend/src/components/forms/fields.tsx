/**
 * Champs de formulaire liés à react-hook-form (à placer sous `<FormProvider>` ou `EntityFormDialog`).
 *   <TextField name="code" label="Code" required />
 *   <LitersField name="capacity_l" label="Capacité" required />
 *   <NumberField name="unload_time_min" label="Temps de dépotage" unit="min" integer placeholder="45" />
 *   <TimeField name="window_start" label="Début de fenêtre" />
 *   <SelectField name="size" label="Gabarit" options={[{ value: "small", label: "Petit" }]} />
 */
import {
  forwardRef,
  useLayoutEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { Controller, useFormContext, type FieldValues, type Path } from "react-hook-form";

import { Switch } from "@/components/ui/checkbox";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fr } from "@/i18n/fr";
import { formatNumber, parseDecimal } from "@/lib/format";
import { cn } from "@/lib/utils";

import { DateInput } from "./DateInput";
import { Field, useFieldError, type FieldProps } from "./Field";
import { TIME_RE } from "./schemas";

interface Named<T extends FieldValues> extends FieldProps {
  name: Path<T>;
  disabled?: boolean;
}

type InputExtras = Pick<
  InputHTMLAttributes<HTMLInputElement>,
  "placeholder" | "autoFocus" | "autoComplete" | "maxLength" | "type"
>;

export function TextField<T extends FieldValues>({
  name,
  disabled,
  mono,
  uppercase,
  ...rest
}: Named<T> & InputExtras & { mono?: boolean; uppercase?: boolean }) {
  const { label, hint, required, hideLabel, className, ...input } = rest;
  const { control } = useFormContext<T>();
  const error = useFieldError<T>(name);
  return (
    <Field
      label={label}
      hint={hint}
      required={required}
      hideLabel={hideLabel}
      error={error}
      className={className}
    >
      {({ id, describedBy, invalid }) => (
        <Controller
          control={control}
          name={name}
          render={({ field }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              aria-required={required}
              disabled={disabled}
              {...input}
              ref={field.ref}
              name={field.name}
              value={(field.value as string | null) ?? ""}
              onBlur={field.onBlur}
              onChange={(event) =>
                field.onChange(uppercase ? event.target.value.toUpperCase() : event.target.value)
              }
              className={cn(mono && "num")}
            />
          )}
        />
      )}
    </Field>
  );
}

export function TextAreaField<T extends FieldValues>({
  name,
  disabled,
  rows,
  placeholder,
  ...rest
}: Named<T> & { rows?: number; placeholder?: string }) {
  const { control } = useFormContext<T>();
  const error = useFieldError<T>(name);
  return (
    <Field {...rest} error={error}>
      {({ id, describedBy, invalid }) => (
        <Controller
          control={control}
          name={name}
          render={({ field }) => (
            <Textarea
              id={id}
              rows={rows}
              placeholder={placeholder}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              disabled={disabled}
              ref={field.ref}
              name={field.name}
              value={(field.value as string | null) ?? ""}
              onBlur={field.onBlur}
              onChange={field.onChange}
            />
          )}
        />
      )}
    </Field>
  );
}

/** Saisie numérique contrôlée : valeur de formulaire `number | null`, virgule ou point acceptés. */
export const NumberInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
    value: number | null | undefined;
    onChange: (value: number | null) => void;
    unit?: string;
    /** Affiche les milliers groupés hors saisie (volumes). */
    grouped?: boolean;
    fractionDigits?: number;
  }
>(function NumberInput({ value, onChange, onBlur, unit, grouped, fractionDigits, className, ...props }, ref) {
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const editing = draft !== null;
  // À l'entrée dans le champ, la valeur brute remplace la valeur groupée : on la sélectionne aussitôt
  // (avant toute frappe, pour qu'une saisie rapide ne soit jamais écrasée par une sélection tardive).
  useLayoutEffect(() => {
    if (editing && document.activeElement === inputRef.current) inputRef.current?.select();
  }, [editing]);
  // Valeur changée de l'extérieur pendant la saisie (collage de coordonnées, « utiliser la somme ») : on la reprend.
  const emitted = useRef<number | null | undefined>(undefined);
  useLayoutEffect(() => {
    if (!editing || Object.is(value ?? null, emitted.current ?? null)) return;
    emitted.current = value;
    setDraft(
      value === null || value === undefined || Number.isNaN(value) ? "" : String(value).replace(".", ","),
    );
  }, [value, editing]);
  const display =
    draft ??
    (value === null || value === undefined || Number.isNaN(value)
      ? ""
      : grouped
        ? formatNumber(value, fractionDigits ?? (Number.isInteger(value) ? 0 : 2))
        : String(value).replace(".", ","));
  return (
    <div className="relative">
      <Input
        ref={(node) => {
          inputRef.current = node;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        inputMode="decimal"
        autoComplete="off"
        {...props}
        value={display}
        onFocus={(event) => {
          emitted.current = value;
          setDraft(value === null || value === undefined ? "" : String(value).replace(".", ","));
          props.onFocus?.(event);
        }}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          const parsed = parseDecimal(text);
          // Saisie non numérique : NaN, pour que la validation signale « nombre invalide » plutôt que « vide ».
          const next = text.trim() === "" ? null : (parsed ?? Number.NaN);
          emitted.current = next;
          onChange(next);
        }}
        onBlur={(event) => {
          setDraft(null);
          onBlur?.(event);
        }}
        style={unit ? { paddingRight: `${unit.length * 0.45 + 1.1}rem` } : undefined}
        className={cn("num text-right", className)}
      />
      {unit && (
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
          {unit}
        </span>
      )}
    </div>
  );
});

export function NumberField<T extends FieldValues>({
  name,
  disabled,
  unit,
  placeholder,
  grouped,
  ...rest
}: Named<T> & { unit?: string; placeholder?: string; grouped?: boolean }) {
  const { control } = useFormContext<T>();
  const error = useFieldError<T>(name);
  return (
    <Field {...rest} error={error}>
      {({ id, describedBy, invalid }) => (
        <Controller
          control={control}
          name={name}
          render={({ field }) => (
            <NumberInput
              id={id}
              ref={field.ref}
              name={field.name}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              aria-required={rest.required}
              disabled={disabled}
              unit={unit}
              grouped={grouped}
              placeholder={placeholder}
              value={field.value as number | null}
              onChange={field.onChange}
              onBlur={field.onBlur}
            />
          )}
        />
      )}
    </Field>
  );
}

/** Volume en litres : milliers groupés, suffixe « L ». */
export function LitersField<T extends FieldValues>(props: Named<T> & { placeholder?: string }) {
  return <NumberField {...props} unit={fr.fields.litersUnit} grouped />;
}

/** `630` → `06:30`, `6` → `06:00`, `6h30` → `06:30`. Renvoie la saisie telle quelle si elle n'est pas interprétable. */
export function normalizeTime(text: string): string {
  const raw = text
    .trim()
    .toLowerCase()
    .replace(/[h.\s]/g, ":")
    .replace(/:+$/, "");
  if (raw === "") return "";
  let hours: string;
  let minutes: string;
  if (raw.includes(":")) [hours, minutes = "0"] = raw.split(":");
  else if (raw.length <= 2) [hours, minutes] = [raw, "0"];
  else [hours, minutes] = [raw.slice(0, -2), raw.slice(-2)];
  const candidate = `${hours.padStart(2, "0")}:${minutes.padEnd(2, "0").slice(0, 2)}`;
  return TIME_RE.test(candidate) ? candidate : text.trim();
}

/** Saisie d'une heure locale `HH:mm` (texte, tolérante : normalisée à la sortie du champ). */
export const TimeInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
    value: string;
    onChange: (value: string) => void;
  }
>(function TimeInput({ value, onChange, onBlur, className, ...props }, ref) {
  return (
    <Input
      ref={ref}
      inputMode="numeric"
      autoComplete="off"
      placeholder={fr.fields.timePlaceholder}
      maxLength={5}
      {...props}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onBlur={(event) => {
        const normalized = normalizeTime(event.target.value);
        if (normalized !== event.target.value) onChange(normalized);
        onBlur?.(event);
      }}
      className={cn("num w-[4.5rem] text-center", className)}
    />
  );
});

export function TimeField<T extends FieldValues>({ name, disabled, ...rest }: Named<T>) {
  const { control } = useFormContext<T>();
  const error = useFieldError<T>(name);
  return (
    <Field {...rest} error={error}>
      {({ id, describedBy, invalid }) => (
        <Controller
          control={control}
          name={name}
          render={({ field }) => (
            <TimeInput
              id={id}
              ref={field.ref}
              name={field.name}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              disabled={disabled}
              value={(field.value as string | null) ?? ""}
              onChange={field.onChange}
              onBlur={field.onBlur}
            />
          )}
        />
      )}
    </Field>
  );
}

/** Date (valeur de formulaire : `YYYY-MM-DD` ou `null`), saisie et affichée en `jj/mm/aaaa`. */
export function DateField<T extends FieldValues>({ name, disabled, ...rest }: Named<T>) {
  const { control } = useFormContext<T>();
  const error = useFieldError<T>(name);
  return (
    <Field {...rest} error={error}>
      {({ id, describedBy, invalid }) => (
        <Controller
          control={control}
          name={name}
          render={({ field }) => (
            <DateInput
              id={id}
              ref={field.ref}
              name={field.name}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              disabled={disabled}
              value={(field.value as string | null) ?? null}
              onChange={field.onChange}
              onBlur={field.onBlur}
              wrapperClassName="w-40"
              className="w-full"
            />
          )}
        />
      )}
    </Field>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** Liste déroulante. `emptyLabel` ajoute un choix vide (valeur de formulaire `null`). */
export function SelectField<T extends FieldValues>({
  name,
  disabled,
  options,
  emptyLabel,
  autoFocus,
  ...rest
}: Named<T> & { options: SelectOption[]; emptyLabel?: string; autoFocus?: boolean }) {
  const { control } = useFormContext<T>();
  const error = useFieldError<T>(name);
  return (
    <Field {...rest} error={error}>
      {({ id, describedBy, invalid }) => (
        <Controller
          control={control}
          name={name}
          render={({ field }) => (
            <NativeSelect
              id={id}
              ref={field.ref}
              name={field.name}
              autoFocus={autoFocus}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              aria-required={rest.required}
              disabled={disabled}
              value={(field.value as string | null) ?? ""}
              onChange={(event) => field.onChange(event.target.value === "" ? null : event.target.value)}
              onBlur={field.onBlur}
            >
              {(emptyLabel !== undefined ||
                field.value === null ||
                field.value === "" ||
                field.value === undefined) && <option value="">{emptyLabel ?? fr.fields.choose}</option>}
              {options.map((option) => (
                <option key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          )}
        />
      )}
    </Field>
  );
}

/** Interrupteur oui / non, libellé à droite. */
export function SwitchField<T extends FieldValues>({ name, label, hint, disabled, className }: Named<T>) {
  const { control } = useFormContext<T>();
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <div className={cn("flex items-center gap-2", className)}>
          <Switch
            id={`switch-${name}`}
            ref={field.ref}
            checked={!!field.value}
            onCheckedChange={field.onChange}
            onBlur={field.onBlur}
            disabled={disabled}
          />
          <Label htmlFor={`switch-${name}`} className="text-sm font-normal text-foreground">
            {label}
          </Label>
          {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
        </div>
      )}
    />
  );
}

/** Couleur `#RRGGBB` : pastille cliquable + saisie hexadécimale. */
export function ColorField<T extends FieldValues>({ name, disabled, ...rest }: Named<T>) {
  const { control } = useFormContext<T>();
  const error = useFieldError<T>(name);
  return (
    <Field {...rest} error={error}>
      {({ id, describedBy, invalid }) => (
        <Controller
          control={control}
          name={name}
          render={({ field }) => {
            const value = (field.value as string | null) ?? "";
            return (
              <div className="flex items-center gap-1.5">
                <input
                  type="color"
                  aria-label={rest.label}
                  disabled={disabled}
                  value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#888888"}
                  onChange={(event) => field.onChange(event.target.value)}
                  className="size-8 shrink-0 cursor-pointer rounded-md border border-input bg-card p-0.5"
                />
                <Input
                  id={id}
                  ref={field.ref}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  disabled={disabled}
                  value={value}
                  maxLength={7}
                  onChange={(event) => field.onChange(event.target.value)}
                  onBlur={field.onBlur}
                  className="num w-24"
                />
              </div>
            );
          }}
        />
      )}
    </Field>
  );
}

/** Choix multiples sous forme de pastilles. Valeur `null` = « tous » quand `allLabel` est fourni. */
export function ChipsInput({
  value,
  onChange,
  options,
  allLabel,
  disabled,
  label,
}: {
  value: string[] | null;
  onChange: (value: string[] | null) => void;
  options: { value: string; label: string; color?: string }[];
  allLabel?: string;
  disabled?: boolean;
  label: string;
}) {
  const selected = new Set(value ?? []);
  const chip = (active: boolean) =>
    cn(
      "inline-flex h-6 items-center gap-1 rounded-sm border px-1.5 text-xs focus-ring disabled:opacity-50",
      active
        ? "border-primary bg-accent font-medium text-accent-foreground"
        : "border-input bg-card text-muted-foreground hover:bg-muted",
    );
  const toggle = (option: string) => {
    const next = new Set(selected);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    const list = options.map((o) => o.value).filter((v) => next.has(v));
    onChange(list.length === 0 && allLabel ? null : list);
  };
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1">
      {allLabel && (
        <button
          type="button"
          disabled={disabled}
          aria-pressed={value === null}
          onClick={() => onChange(null)}
          className={chip(value === null)}
        >
          {allLabel}
        </button>
      )}
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          aria-pressed={selected.has(option.value)}
          onClick={() => toggle(option.value)}
          className={chip(selected.has(option.value))}
        >
          {option.color && <span className="size-2 rounded-full" style={{ background: option.color }} />}
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Ligne libellé / contenu libre, alignée sur les autres champs (sous-formulaires). */
export function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="text-xs font-medium text-foreground/80">{children}</span>;
}
