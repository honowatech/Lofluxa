/** Gardes de routes : authentification, puis rôle. */
import type { ReactNode } from "react";
import { Link, Navigate, useLocation, useRouteError } from "react-router-dom";

import { LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { fr } from "@/i18n/fr";
import { canSee, type ScreenId } from "@/lib/auth/roles";
import { useSession } from "@/lib/auth/session";

import { HOME_PATH, LOGIN_PATH, SCREENS } from "./screens";

/** Premier écran accessible au rôle (redirection après connexion et depuis `/`). */
export function homePathFor(role: Parameters<typeof canSee>[0]): string {
  return SCREENS.find((screen) => canSee(role, screen.id))?.path ?? HOME_PATH;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const status = useSession((state) => state.status);
  const location = useLocation();
  if (status === "loading") return <LoadingState label={fr.auth.checking} className="h-screen" />;
  if (status === "anonymous") {
    return <Navigate to={LOGIN_PATH} replace state={{ from: `${location.pathname}${location.search}` }} />;
  }
  return <>{children}</>;
}

export function RequireScreen({ screen, children }: { screen: ScreenId; children: ReactNode }) {
  const role = useSession((state) => state.user?.role ?? null);
  if (!canSee(role, screen))
    return <MessagePage title={fr.errors.forbiddenTitle} body={fr.errors.forbiddenBody} />;
  return <>{children}</>;
}

export function MessagePage({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div
      className="flex h-full min-h-64 flex-col items-center justify-center gap-2 p-6 text-center"
      role="alert"
    >
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{body}</p>
      {action ?? (
        <Button asChild variant="outline" className="mt-2">
          <Link to={HOME_PATH}>{fr.errors.backHome}</Link>
        </Button>
      )}
    </div>
  );
}

export function NotFoundPage() {
  return <MessagePage title={fr.errors.pageNotFoundTitle} body={fr.errors.pageNotFoundBody} />;
}

/** Erreur de rendu d'un écran : la coquille reste utilisable. */
export function RouteErrorPage() {
  const error = useRouteError();
  console.error(error);
  return (
    <MessagePage
      title={fr.errors.crashTitle}
      body={fr.errors.crashBody}
      action={
        <Button className="mt-2" onClick={() => window.location.reload()}>
          {fr.errors.reload}
        </Button>
      }
    />
  );
}
