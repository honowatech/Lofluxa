/** Aides de test : rendu avec fournisseurs + routeur, session simulée par rôle. */
import { render, type RenderResult } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { createMemoryRouter, RouterProvider, type RouteObject } from "react-router-dom";

import { AppProviders, createQueryClient } from "@/app/providers";
import { ROUTER_FUTURE, routes as appRoutes } from "@/app/router";
import { useSession } from "@/lib/auth/session";
import { setTokens } from "@/lib/auth/tokens";
import type { Role } from "@/lib/types";
import { db, type MockUser } from "@/mocks/db";
import { makeToken } from "@/mocks/handlers/helpers";

export function mockUser(role: Role): MockUser {
  return db.users.find((user) => user.role === role && user.active) as MockUser;
}

/** Ouvre une session simulée (jetons acceptés par les doublures) pour le rôle donné. */
export function loginAs(role: Role = "admin"): MockUser {
  const user = mockUser(role);
  setTokens({ access_token: makeToken("access", user.id), refresh_token: makeToken("refresh", user.id) });
  useSession.setState({
    status: "authenticated",
    expired: false,
    user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role },
  });
  return user;
}

type Rendered = RenderResult & { user: UserEvent; router: ReturnType<typeof createMemoryRouter> };

function mount(routes: RouteObject[], route: string): Rendered {
  const router = createMemoryRouter(routes, { initialEntries: [route], future: ROUTER_FUTURE });
  const user = userEvent.setup();
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false, staleTime: 0 } });
  const result = render(
    <AppProviders client={client}>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </AppProviders>,
  );
  return { ...result, user, router };
}

/** Rend un composant isolé sous les fournisseurs de l'application (requêtes, confirmations, routeur). */
export function renderWithProviders(ui: ReactElement, { route = "/" }: { route?: string } = {}): Rendered {
  return mount([{ path: "*", element: ui }], route);
}

/** Rend l'application entière (coquille, gardes, écrans) à l'adresse donnée. */
export function renderApp(route: string): Rendered {
  return mount(appRoutes, route);
}
