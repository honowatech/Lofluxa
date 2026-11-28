import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { api } from "@/lib/api/client";
import type { ApiError } from "@/lib/api/errors";
import { ROLES } from "@/lib/types";
import { API, makeToken } from "@/mocks/handlers/helpers";
import { server } from "@/mocks/server";
import { mockUser } from "@/test/utils";

import { can, canSee } from "./roles";
import { useSession } from "./session";
import { getTokens, setTokens } from "./tokens";

function storedSession(accessTtl = 3600) {
  const admin = mockUser("admin");
  const tokens = {
    access_token: makeToken("access", admin.id, accessTtl),
    refresh_token: makeToken("refresh", admin.id),
  };
  setTokens(tokens);
  useSession.setState({ status: "loading", user: null, expired: false, bootstrapError: null });
  return tokens;
}

describe("démarrage de session (bootstrap)", () => {
  it("`/me` interrompu (rechargement, réseau coupé) : jetons conservés, nouvel essai possible", async () => {
    const tokens = storedSession();
    server.use(http.get(`${API}/me`, () => HttpResponse.error(), { once: true }));
    await useSession.getState().bootstrap();
    expect(getTokens()).toEqual(tokens);
    expect(useSession.getState()).toMatchObject({
      status: "loading",
      user: null,
      bootstrapError: "Serveur injoignable. Vérifiez la connexion puis réessayez.",
    });

    // Le réseau revient : le même démarrage aboutit, sans reconnexion.
    await useSession.getState().bootstrap();
    expect(useSession.getState()).toMatchObject({ status: "authenticated", bootstrapError: null });
    expect(useSession.getState().user?.email).toBe("admin@honowa.tech");
  });

  it("erreur du serveur (503) : jetons conservés", async () => {
    const tokens = storedSession();
    server.use(
      http.get(`${API}/me`, () =>
        HttpResponse.json({ code: "unavailable", message: "Indisponible" }, { status: 503 }),
      ),
    );
    await useSession.getState().bootstrap();
    expect(getTokens()).toEqual(tokens);
    expect(useSession.getState()).toMatchObject({ status: "loading", bootstrapError: "Indisponible" });
  });

  it("rafraîchissement interrompu par une coupure réseau : jetons conservés", async () => {
    const tokens = storedSession(-1); // jeton d'accès expiré → 401 puis rafraîchissement
    server.use(http.post(`${API}/auth/refresh`, () => HttpResponse.error()));
    await useSession.getState().bootstrap();
    expect(getTokens()).toEqual(tokens);
    expect(useSession.getState()).toMatchObject({ status: "loading", expired: false });
    expect(useSession.getState().bootstrapError).not.toBeNull();
  });

  it("refus d'authentification (jeton révoqué) : session effacée, retour à la connexion", async () => {
    storedSession();
    server.use(
      http.get(`${API}/me`, () =>
        HttpResponse.json({ code: "token_revoked", message: "Session révoquée." }, { status: 401 }),
      ),
      http.post(`${API}/auth/refresh`, () =>
        HttpResponse.json({ code: "token_revoked", message: "Session révoquée." }, { status: 401 }),
      ),
    );
    await useSession.getState().bootstrap();
    expect(getTokens()).toBeNull();
    expect(useSession.getState()).toMatchObject({ status: "anonymous", user: null, bootstrapError: null });
  });

  it("compte refusé (403 sur `/me`) : session effacée", async () => {
    storedSession();
    server.use(
      http.get(`${API}/me`, () =>
        HttpResponse.json({ code: "forbidden", message: "Compte désactivé." }, { status: 403 }),
      ),
    );
    await useSession.getState().bootstrap();
    expect(getTokens()).toBeNull();
    expect(useSession.getState().status).toBe("anonymous");
  });

  it("en cours d'utilisation : un rafraîchissement en panne passagère (503) ne ferme pas la session", async () => {
    const tokens = storedSession(-1);
    useSession.setState({ status: "authenticated", user: mockUser("admin") as never });
    server.use(
      http.post(`${API}/auth/refresh`, () => HttpResponse.json({ message: "Indisponible" }, { status: 503 })),
    );
    const error = (await api("/stations").catch((failure: unknown) => failure)) as ApiError;
    expect(error.status).toBe(503);
    expect(getTokens()).toEqual(tokens);
    expect(useSession.getState().status).toBe("authenticated");
  });
});

describe("droits alignés sur les rôles exigés par l'API", () => {
  it("chargement et livraisons : fleet et dispatcher", () => {
    for (const capability of ["loading.write", "deliveries.write"] as const) {
      expect(ROLES.filter((role) => can(role, capability))).toEqual(["dispatcher", "fleet", "admin"]);
    }
  });

  it("événements : réaffectation par le dispatcher, pénurie déclarée par Supply, journal visible de tous", () => {
    expect(ROLES.filter((role) => can(role, "events.write"))).toEqual(["dispatcher", "admin"]);
    expect(ROLES.filter((role) => can(role, "events.shortage.write"))).toEqual(["supply", "admin"]);
    expect(ROLES.every((role) => canSee(role, "events"))).toBe(true);
  });

  it("journal d'audit : direction et administration ; reste de l'administration : admin seul", () => {
    expect(ROLES.filter((role) => can(role, "audit.read"))).toEqual(["manager", "admin"]);
    expect(ROLES.filter((role) => canSee(role, "administration"))).toEqual(["manager", "admin"]);
    expect(ROLES.filter((role) => can(role, "administration.write"))).toEqual(["admin"]);
    expect(ROLES.filter((role) => can(role, "referentials.write"))).toEqual(["admin"]);
  });

  it("commandes, plans, comparaison, ressources : dispatcher ; stocks : supply", () => {
    for (const capability of [
      "orders.write",
      "plan.write",
      "comparison.write",
      "availability.resources.write",
    ] as const) {
      expect(ROLES.filter((role) => can(role, capability))).toEqual(["dispatcher", "admin"]);
    }
    expect(ROLES.filter((role) => can(role, "availability.stocks.write"))).toEqual(["supply", "admin"]);
  });
});
