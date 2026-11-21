/** Zone d'alertes de la coquille : compteur + liste, alimentée par `usePublishAlerts` (lib/alerts). */
import { Bell, CircleAlert, Info, TriangleAlert } from "lucide-react";
import { Link } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fr } from "@/i18n/fr";
import { selectAlerts, useAlertsStore } from "@/lib/alerts";
import { cn } from "@/lib/utils";

const ICONS = { blocking: CircleAlert, warning: TriangleAlert, info: Info };
const COLORS = { blocking: "text-blocking", warning: "text-warning", info: "text-info" };

export function AlertsButton() {
  const alerts = useAlertsStore(useShallow(selectAlerts));
  const hasBlocking = alerts.some((alert) => alert.severity === "blocking");
  const count = alerts.length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="relative gap-1.5"
          aria-label={`${fr.shell.alerts} : ${fr.shell.alertsCount(count)}`}
        >
          <Bell />
          <span className="hidden lg:inline">{fr.shell.alerts}</span>
          {count > 0 && (
            <span
              data-testid="alerts-count"
              className={cn(
                "num min-w-4 rounded-full px-1 text-center text-2xs font-medium leading-4 text-white",
                hasBlocking ? "bg-blocking" : "bg-warning",
              )}
            >
              {count}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0">
        <p className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-foreground/70">
          {fr.shell.alerts} — {fr.shell.alertsCount(count)}
        </p>
        {count === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">{fr.shell.noAlerts}</p>
        ) : (
          <ul className="max-h-80 divide-y overflow-y-auto">
            {alerts.map((alert) => {
              const Icon = ICONS[alert.severity];
              const body = (
                <>
                  <Icon className={cn("mt-0.5 size-3.5 shrink-0", COLORS[alert.severity])} aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium">{alert.title}</span>
                    {alert.description && (
                      <span className="block text-xs text-muted-foreground">{alert.description}</span>
                    )}
                  </span>
                </>
              );
              return (
                <li key={alert.id}>
                  {alert.to ? (
                    <Link to={alert.to} className="flex gap-2 px-3 py-2 hover:bg-muted focus-ring">
                      {body}
                    </Link>
                  ) : (
                    <div className="flex gap-2 px-3 py-2">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
