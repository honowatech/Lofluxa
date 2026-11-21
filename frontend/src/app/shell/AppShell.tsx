/** Coquille : navigation latérale filtrée par rôle, barre du jour J, alertes, identité, contenu de l'écran. */
import { FlaskConical } from "lucide-react";
import { Suspense } from "react";
import { Outlet } from "react-router-dom";

import { LoadingState } from "@/components/states";
import { Tip } from "@/components/ui/tooltip";
import { useDriverDocumentIssues } from "@/features/referentials/driverAlerts";
import { fr } from "@/i18n/fr";
import { usePublishAlerts } from "@/lib/alerts";
import { useCanSee } from "@/lib/auth/session";
import { MOCKS_MODE } from "@/lib/config";

import { AlertsButton } from "./AlertsButton";
import { DaySelector } from "./DaySelector";
import { Sidebar } from "./Sidebar";
import { UserMenu } from "./UserMenu";

/** Alertes globales calculées par la coquille (indépendantes de l'écran affiché). */
function useGlobalAlerts() {
  const { alerts } = useDriverDocumentIssues(useCanSee("referentials"));
  usePublishAlerts("drivers-documents", alerts);
}

export function AppShell() {
  useGlobalAlerts();
  return (
    <div className="flex h-screen min-w-[64rem] overflow-hidden">
      <a
        href="#contenu"
        className="sr-only z-50 rounded-md bg-card px-3 py-1.5 shadow-pop focus:not-sr-only focus:absolute focus:left-2 focus:top-2"
      >
        {fr.shell.skipToContent}
      </a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-3 border-b bg-card px-3">
          <DaySelector />
          <span className="hidden text-2xs text-muted-foreground xl:inline">{fr.shell.timezoneHint}</span>
          <div className="ml-auto flex items-center gap-1.5">
            {MOCKS_MODE !== "off" && (
              <Tip label={fr.shell.mocksHint} side="bottom">
                <span
                  tabIndex={0}
                  data-testid="mocks-badge"
                  className="flex items-center gap-1 rounded-sm border border-warning/40 bg-warning-soft px-1.5 py-0.5 text-2xs font-medium text-warning focus-ring"
                >
                  <FlaskConical className="size-3" aria-hidden />
                  {MOCKS_MODE === "full" ? fr.shell.mocksFull : fr.shell.mocksPartial}
                </span>
              </Tip>
            )}
            <AlertsButton />
            <span className="h-5 w-px bg-border" aria-hidden />
            <UserMenu />
          </div>
        </header>
        <main id="contenu" tabIndex={-1} className="min-h-0 flex-1 overflow-auto outline-none">
          <Suspense fallback={<LoadingState />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
