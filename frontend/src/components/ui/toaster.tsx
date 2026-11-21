import { Toaster as Sonner } from "sonner";

/** Conteneur des notifications (monté une fois dans les fournisseurs de l'application). */
export function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      closeButton
      duration={4500}
      toastOptions={{
        classNames: {
          toast:
            "!rounded-md !border !border-border !bg-card !text-foreground !shadow-pop !text-sm !font-sans",
          description: "!text-muted-foreground !text-xs",
          error: "!border-blocking/40",
          success: "!border-success/40",
          warning: "!border-warning/40",
        },
      }}
    />
  );
}
