/**
 * Saisie d'une date au format français `jj/mm/aaaa`, quelle que soit la langue du navigateur
 * (le champ natif `type="date"` suit la langue du navigateur : `mm/dd/yyyy` sur un poste en anglais).
 *
 *   <DateInput value={day} onChange={setDay} aria-label="Jour J" required />
 *
 * Valeur : `YYYY-MM-DD` ou `null`. Au clavier : saisie libre (`12/01/2027`, `12012027`, `12/1/27`,
 * ou `2027-01-12`), flèches haut / bas = jour suivant / précédent. Le bouton calendrier ouvre le
 * sélecteur natif du navigateur.
 */
import { CalendarDays } from "lucide-react";
import { forwardRef, useRef, useState, type InputHTMLAttributes } from "react";

import { Input } from "@/components/ui/input";
import { fr } from "@/i18n/fr";
import { addDays, formatDate, isValidDay } from "@/lib/format";
import type { IsoDate } from "@/lib/types";
import { cn } from "@/lib/utils";

/** `12/01/2027`, `12-1-27`, `12.01.2027`, `12012027`, `120127`, `2027-01-12` → `2027-01-12` ; sinon `null`. */
export function parseDayInput(text: string): IsoDate | null {
  const raw = text.trim();
  let day: string, month: string, year: string;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  const parts = /^(\d{1,2})[/.\-\s](\d{1,2})[/.\-\s](\d{2}|\d{4})$/.exec(raw);
  const digits = /^(\d{2})(\d{2})(\d{2}|\d{4})$/.exec(raw);
  if (iso) [, year, month, day] = iso;
  else if (parts) [, day, month, year] = parts;
  else if (digits) [, day, month, year] = digits;
  else return null;
  if (year.length === 2) year = `20${year}`;
  const candidate = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return isValidDay(candidate) ? candidate : null;
}

export interface DateInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "type" | "min" | "max"
> {
  value: IsoDate | null | undefined;
  /** Appelé avec une date valide, ou `null` quand le champ est vidé (jamais avec une saisie incomplète). */
  onChange: (value: IsoDate | null) => void;
  /** Bornes `YYYY-MM-DD` du sélecteur natif. */
  min?: IsoDate;
  max?: IsoDate;
  /** Classes du conteneur (largeur). */
  wrapperClassName?: string;
}

export const DateInput = forwardRef<HTMLInputElement, DateInputProps>(function DateInput(
  { value, onChange, onBlur, onKeyDown, min, max, disabled, required, className, wrapperClassName, ...props },
  ref,
) {
  const [draft, setDraft] = useState<string | null>(null);
  const nativeRef = useRef<HTMLInputElement>(null);
  const current = isValidDay(value) ? value : null;
  const invalid = draft !== null && draft.trim() !== "" && parseDayInput(draft) === null;

  const openPicker = () => {
    const native = nativeRef.current;
    if (!native) return;
    try {
      native.showPicker();
    } catch {
      native.focus();
    }
  };

  return (
    <span className={cn("relative inline-flex", wrapperClassName)}>
      <Input
        ref={ref}
        type="text"
        // Modèle ARIA « sélecteur de date » : champ de saisie associé à un calendrier (le sélecteur natif).
        role="combobox"
        aria-haspopup="dialog"
        aria-expanded={false}
        inputMode="numeric"
        autoComplete="off"
        placeholder={fr.fields.datePlaceholder}
        maxLength={10}
        disabled={disabled}
        aria-required={required}
        {...props}
        aria-invalid={invalid || props["aria-invalid"]}
        value={draft ?? (current ? formatDate(current) : "")}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          if (text.trim() === "") {
            if (!required) onChange(null);
            return;
          }
          const parsed = parseDayInput(text);
          if (parsed && parsed !== current) onChange(parsed);
        }}
        onBlur={(event) => {
          // Saisie incomplète ou invalide : retour à la dernière date valide.
          setDraft(null);
          onBlur?.(event);
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented || !current) return;
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            setDraft(null);
            onChange(addDays(current, event.key === "ArrowUp" ? 1 : -1));
          }
        }}
        className={cn("num pr-7", className)}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={openPicker}
        aria-label={fr.fields.openCalendar}
        title={fr.fields.openCalendar}
        className="absolute right-0.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground hover:bg-muted focus-ring disabled:opacity-50"
      >
        <CalendarDays className="size-3.5" />
      </button>
      {/* Sélecteur natif, hors du parcours clavier et des lecteurs d'écran : il ne sert qu'à afficher le calendrier. */}
      <input
        ref={nativeRef}
        type="date"
        tabIndex={-1}
        aria-hidden
        value={current ?? ""}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(event) => {
          setDraft(null);
          if (isValidDay(event.target.value)) onChange(event.target.value);
          else if (!required) onChange(null);
        }}
        className="pointer-events-none absolute bottom-0 right-0 size-0 opacity-0"
      />
    </span>
  );
});
