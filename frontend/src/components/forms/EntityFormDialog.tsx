/**
 * Boîte de saisie d'une entité : formulaire react-hook-form + zod dans un panneau latéral.
 * Gère la validation, l'attente, les erreurs de champ renvoyées par le serveur (422) et la confirmation
 * avant d'abandonner des modifications.
 *
 *   <EntityFormDialog
 *     open={open} onOpenChange={setOpen}
 *     title="Nouvelle station" schema={stationSchema} defaultValues={defaults}
 *     onSubmit={async (values) => { await create.mutateAsync(values); }}
 *   >
 *     <TextField name="code" label="Code" required />
 *   </EntityFormDialog>
 */
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState, type ReactNode } from "react";
import {
  FormProvider,
  useForm,
  type DefaultValues,
  type FieldValues,
  type Path,
  type UseFormReturn,
} from "react-hook-form";
import type { z } from "zod";

import { useConfirm } from "@/components/ConfirmDialog";
import { notify } from "@/components/notify";
import { Notice } from "@/components/PageHeader";
import { Spinner } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fr } from "@/i18n/fr";
import { errorMessage, isApiError } from "@/lib/api/errors";

/** Formulaire validé par un schéma zod : valeurs saisies = entrée du schéma, valeurs soumises = sortie. */
export function useZodForm<S extends z.ZodTypeAny>(schema: S, defaultValues: DefaultValues<z.input<S>>) {
  return useForm<z.input<S>, unknown, z.output<S>>({
    resolver: zodResolver(schema),
    defaultValues,
    mode: "onTouched",
  });
}

/** Reporte sur les champs les erreurs de validation du serveur. Renvoie `true` si au moins une a trouvé son champ. */
export function applyApiErrors<T extends FieldValues>(
  form: UseFormReturn<T, unknown, never> | UseFormReturn<T>,
  error: unknown,
): boolean {
  if (!isApiError(error)) return false;
  const known = form.getValues();
  let applied = false;
  for (const [field, message] of Object.entries(error.fieldErrors)) {
    if (field.split(".")[0] in known) {
      (form as UseFormReturn<T>).setError(field as Path<T>, { type: "server", message });
      applied = true;
    }
  }
  return applied;
}

export interface EntityFormDialogProps<S extends z.ZodTypeAny> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  schema: S;
  defaultValues: DefaultValues<z.input<S>>;
  /** Lève une exception pour laisser la boîte ouverte (l'erreur est affichée en tête du formulaire). */
  onSubmit: (values: z.output<S>) => Promise<unknown>;
  submitLabel?: string;
  readOnly?: boolean;
  /** `side` (défaut) : panneau latéral ; `center` : petite boîte pour 2 ou 3 champs. */
  placement?: "side" | "center";
  children: ReactNode | ((form: UseFormReturn<z.input<S>, unknown, z.output<S>>) => ReactNode);
}

export function EntityFormDialog<S extends z.ZodTypeAny>({
  open,
  onOpenChange,
  title,
  description,
  schema,
  defaultValues,
  onSubmit,
  submitLabel = fr.common.save,
  readOnly,
  placement = "side",
  children,
}: EntityFormDialogProps<S>) {
  const form = useZodForm(schema, defaultValues);
  const confirm = useConfirm();
  const [serverError, setServerError] = useState<string | null>(null);
  const { isSubmitting, isDirty } = form.formState;

  // À chaque ouverture, repartir des valeurs fournies (création ou autre ligne à modifier).
  const signature = JSON.stringify(defaultValues);
  useEffect(() => {
    if (open) {
      form.reset(JSON.parse(signature) as DefaultValues<z.input<S>>);
      setServerError(null);
    }
  }, [open, signature, form]);

  const requestClose = async () => {
    if (isSubmitting) return;
    if (
      isDirty &&
      !(await confirm({
        title: fr.confirm.unsavedTitle,
        description: fr.confirm.unsavedBody,
        confirmLabel: fr.confirm.discard,
        cancelLabel: fr.confirm.keepEditing,
        destructive: true,
      }))
    )
      return;
    onOpenChange(false);
  };

  const submit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      await onSubmit(values);
      onOpenChange(false);
    } catch (error) {
      const onFields = applyApiErrors(form as unknown as UseFormReturn<FieldValues>, error);
      setServerError(errorMessage(error));
      if (!onFields && !isApiError(error)) notify.apiError(error, fr.errors.saveFailed);
    }
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : void requestClose())}>
      <DialogContent placement={placement} className={placement === "center" ? "max-w-md" : undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={description ? undefined : "sr-only"}>
            {description ?? title}
          </DialogDescription>
        </DialogHeader>
        <FormProvider {...form}>
          <form onSubmit={(event) => void submit(event)} noValidate className="flex min-h-0 flex-1 flex-col">
            <DialogBody>
              <fieldset disabled={readOnly} className="flex flex-col gap-5">
                {serverError && <Notice tone="blocking">{serverError}</Notice>}
                {typeof children === "function" ? children(form) : children}
              </fieldset>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => void requestClose()} disabled={isSubmitting}>
                {readOnly ? fr.common.close : fr.common.cancel}
              </Button>
              {!readOnly && (
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting && <Spinner className="text-current" />}
                  {isSubmitting ? fr.common.saving : submitLabel}
                </Button>
              )}
            </DialogFooter>
          </form>
        </FormProvider>
      </DialogContent>
    </Dialog>
  );
}
