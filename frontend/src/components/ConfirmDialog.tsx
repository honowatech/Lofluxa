/**
 * Confirmation avant toute action destructive (principe UI de la spec §10).
 *
 * Forme déclarative :
 *   <ConfirmDialog open={open} onOpenChange={setOpen} title="Supprimer ?" destructive onConfirm={remove} />
 *
 * Forme impérative (fournie par `ConfirmProvider`, monté dans l'application) :
 *   const confirm = useConfirm();
 *   if (await confirm({ title: fr.confirm.deleteTitle, description: …, destructive: true })) { … }
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { fr } from "@/i18n/fr";

import { Spinner } from "./states";

export interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Bouton de confirmation rouge ; le focus initial est sur « Annuler ». */
  destructive?: boolean;
}

export interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Peut être asynchrone : le bouton affiche l'attente et la boîte se ferme à la fin. */
  onConfirm: () => void | Promise<void>;
  children?: ReactNode;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel = fr.common.cancel,
  destructive,
  children,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      // L'appelant notifie l'erreur ; la boîte reste ouverte pour permettre un nouvel essai.
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialogContent
        onOpenAutoFocus={(event) => {
          // Action destructive : Entrée ne doit pas confirmer par réflexe.
          if (destructive) {
            event.preventDefault();
            cancelRef.current?.focus();
          }
        }}
      >
        <div className="flex flex-col gap-2 px-5 pb-4 pt-5">
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? (
            <AlertDialogDescription asChild>
              <div>{description}</div>
            </AlertDialogDescription>
          ) : (
            <AlertDialogDescription className="sr-only">{title}</AlertDialogDescription>
          )}
          {children}
        </div>
        <div className="flex justify-end gap-2 border-t bg-muted/40 px-5 py-3">
          <AlertDialogCancel asChild>
            <Button ref={cancelRef} variant="outline" disabled={busy}>
              {cancelLabel}
            </Button>
          </AlertDialogCancel>
          <Button variant={destructive ? "destructive" : "default"} onClick={handleConfirm} disabled={busy}>
            {busy && <Spinner className="text-current" />}
            {confirmLabel ?? (destructive ? fr.common.delete : fr.common.confirm)}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [open, setOpen] = useState(false);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((next) => {
    resolver.current?.(false);
    setOptions(next);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = (value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
  };

  const value = useMemo(() => confirm, [confirm]);
  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {options && (
        <ConfirmDialog
          {...options}
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) settle(false);
          }}
          onConfirm={() => settle(true)}
        />
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm doit être utilisé sous <ConfirmProvider>.");
  return confirm;
}
