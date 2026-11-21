import { lazy, Suspense } from "react";
import { createBrowserRouter, Navigate, type RouteObject } from "react-router-dom";

import { LoadingState } from "@/components/states";
import { useSession } from "@/lib/auth/session";

import { homePathFor, NotFoundPage, RequireAuth, RequireScreen, RouteErrorPage } from "./guards";
import { LOGIN_PATH, SCREENS } from "./screens";
import { AppShell } from "./shell/AppShell";

const LoginPage = lazy(() => import("@/features/login"));

function HomeRedirect() {
  const role = useSession((state) => state.user?.role ?? null);
  return <Navigate to={homePathFor(role)} replace />;
}

export const routes: RouteObject[] = [
  {
    path: LOGIN_PATH,
    element: (
      <Suspense fallback={<LoadingState className="h-screen" />}>
        <LoginPage />
      </Suspense>
    ),
  },
  {
    path: "/",
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <HomeRedirect /> },
      ...SCREENS.map((screen) => ({
        path: `${screen.path.slice(1)}/*`,
        errorElement: <RouteErrorPage />,
        element: (
          <RequireScreen screen={screen.id}>
            <screen.component />
          </RequireScreen>
        ),
      })),
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];

/** Drapeaux de compatibilité React Router v7 (comportements adoptés dès maintenant). */
export const ROUTER_FUTURE = {
  v7_relativeSplatPath: true,
  v7_fetcherPersist: true,
  v7_normalizeFormMethod: true,
  v7_partialHydration: true,
  v7_skipActionErrorRevalidation: true,
} as const;

export const createRouter = () => createBrowserRouter(routes, { future: ROUTER_FUTURE });
