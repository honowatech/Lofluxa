import { useId, type ReactNode } from "react";
import { get, useFormContext, type FieldValues, type Path } from "react-hook-form";

import { Label } from "@/components/ui/label";
import { fr } from "@/i18n/fr";
import { cn } from "@/lib/utils";

export interface FieldProps {
  label: string;
  hint?: ReactNode;
  required?: boolean;
  /** Libellé réservé aux lecteurs d'écran (champs alignés en colonnes sous un en-tête commun). */
  hideLabel?: boolean;
  className?: string;
}

/** Message d'erreur du champ `name` dans le formulaire courant (chemins imbriqués compris). */
export function useFieldError<T extends FieldValues>(name: Path<T> | string): string | undefined {
  const { formState } = useFormContext<T>();
  const error = get(formState.errors, name) as { message?: string; root?: { message?: string } } | undefined;
  return error?.message ?? error?.root?.message;
}

/** Habillage commun d'un champ : libellé, aide, message d'erreur relié par `aria-describedby`. */
export function Field({
  label,
  hint,
  required,
  hideLabel,
  error,
  className,
  children,
}: FieldProps & {
  error?: string;
  children: (ids: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <Label htmlFor={id} className={hideLabel ? "sr-only" : undefined}>
        {label}
        {required && (
          <span className="ml-0.5 text-destructive" aria-hidden>
            *
          </span>
        )}
        {required === false && (
          <span className="ml-1 font-normal text-muted-foreground">({fr.common.optional})</span>
        )}
      </Label>
      {children({ id, describedBy, invalid: !!error })}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : (
        hint && (
          <p id={hintId} className="text-xs text-muted-foreground">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

/** Groupe de champs titré dans un formulaire long. */
export function FormSection({
  title,
  hint,
  children,
  className,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={cn("flex flex-col gap-3", className)}>
      <legend className="mb-2 flex w-full items-baseline gap-2 border-b pb-1 text-xs font-semibold uppercase tracking-wide text-foreground/60">
        {title}
        {hint && (
          <span className="font-normal normal-case tracking-normal text-muted-foreground">{hint}</span>
        )}
      </legend>
      {children}
    </fieldset>
  );
}

/** Grille de champs : `cols` colonnes égales. */
export function FieldRow({
  cols = 2,
  children,
  className,
}: {
  cols?: 2 | 3 | 4;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid gap-3",
        cols === 2 && "sm:grid-cols-2",
        cols === 3 && "sm:grid-cols-3",
        cols === 4 && "sm:grid-cols-4",
        className,
      )}
    >
      {children}
    </div>
  );
}
