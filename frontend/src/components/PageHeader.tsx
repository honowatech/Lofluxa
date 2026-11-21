import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** En-tête d'écran : titre, sous-titre, actions à droite. */
export function PageHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-wrap items-end gap-x-4 gap-y-2", className)}>
      <div className="min-w-0">
        <h1 className="text-lg font-semibold leading-tight tracking-tight">{title}</h1>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** Bandeau d'information au-dessus d'un contenu (lecture seule, alerte d'expiration…). */
export function Notice({
  tone = "info",
  icon,
  children,
  action,
  className,
}: {
  tone?: "info" | "success" | "warning" | "blocking" | "neutral";
  icon?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const tones = {
    info: "border-info/30 bg-info-soft text-info",
    success: "border-success/30 bg-success-soft text-success",
    warning: "border-warning/35 bg-warning-soft text-warning",
    blocking: "border-blocking/35 bg-blocking-soft text-blocking",
    neutral: "border-border bg-muted text-muted-foreground",
  };
  return (
    <div
      role={tone === "blocking" ? "alert" : "status"}
      className={cn("flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs", tones[tone], className)}
    >
      {icon}
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}
