/** États vide / chargement / erreur, identiques sur tous les écrans. */
import { AlertTriangle, Inbox, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { fr } from "@/i18n/fr";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { cn } from "@/lib/utils";

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-4 animate-spin text-muted-foreground", className)} aria-hidden />;
}

interface StateProps {
  title?: string;
  description?: ReactNode;
  /** Bouton ou lien d'action (ex. « Nouvelle station »). */
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
  /** `compact` : dans une cellule ou un panneau étroit. */
  compact?: boolean;
}

function Shell({
  title,
  description,
  action,
  icon,
  className,
  compact,
  role,
}: StateProps & { role?: string }) {
  return (
    <div
      role={role}
      className={cn(
        "flex flex-col items-center justify-center gap-2 text-center",
        compact ? "px-3 py-5" : "px-6 py-12",
        className,
      )}
    >
      {icon}
      {title && <p className="text-sm font-medium">{title}</p>}
      {description && <p className="max-w-md text-xs text-muted-foreground">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function EmptyState(props: StateProps) {
  return (
    <Shell
      {...props}
      title={props.title ?? fr.states.emptyTitle}
      icon={props.icon ?? <Inbox className="size-6 text-muted-foreground/60" aria-hidden />}
    />
  );
}

export function LoadingState({
  label = fr.states.loading,
  className,
  compact,
}: Pick<StateProps, "className" | "compact"> & { label?: string }) {
  return (
    <Shell
      role="status"
      compact={compact}
      className={className}
      icon={<Spinner className="size-5" />}
      description={label}
    />
  );
}

export function ErrorState({
  error,
  onRetry,
  title = fr.states.errorTitle,
  className,
  compact,
}: Pick<StateProps, "className" | "compact" | "title"> & { error: unknown; onRetry?: () => void }) {
  const codes = isApiError(error) ? error.ruleCodes : [];
  return (
    <Shell
      role="alert"
      compact={compact}
      className={className}
      title={title}
      icon={<AlertTriangle className="size-6 text-blocking" aria-hidden />}
      description={
        <>
          {errorMessage(error)}
          {codes.length > 0 && <span className="num ml-1">({codes.join(", ")})</span>}
        </>
      }
      action={
        onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            {fr.common.retry}
          </Button>
        )
      }
    />
  );
}

/** Squelette d'une ligne de texte en cours de chargement. */
export function Skeleton({ className }: { className?: string }) {
  return <span className={cn("block h-3.5 animate-pulse rounded-sm bg-muted", className)} />;
}
