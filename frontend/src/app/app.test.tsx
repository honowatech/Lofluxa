import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { can, canSee, CAPABILITIES, SCREEN_IDS, type Capability } from "@/lib/auth/roles";
import { useSession } from "@/lib/auth/session";
import { getTokens, setTokens } from "@/lib/auth/tokens";
import { addDays, todayLocal } from "@/lib/format";
import { ROLES } from "@/lib/types";
import { makeToken } from "@/mocks/handlers/helpers";
import { loginAs, mockUser, renderApp } from "@/test/utils";

import { SCREENS } from "./screens";

const nav = () => screen.getByRole("navigation", { name: "Navigation principale" });
const navLabels = () =>
  within(nav())
    .getAllByRole("link")
    .map((link) => link.textContent);

describe("connexion", () => {
  it("route protégée → connexion → retour à la page demandée, jour J conservé", async () => {
    const { user, router } = renderApp("/plan?day=2027-01-12");
    expect(await screen.findByRole("heading", { name: "Connexion" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/connexion");

    await user.click(screen.getByRole("button", { name: "Se connecter" }));
    expect(await screen.findByText("Adresse e-mail invalide")).toBeInTheDocument();
    expect(screen.getByText("Saisissez votre mot de passe")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Adresse e-mail"), "admin@honowa.tech");
    await user.type(screen.getByLabelText("Mot de passe"), "mauvais");
    await user.click(screen.getByRole("button", { name: "Se connecter" }));
    expect(await screen.findByText("E-mail ou mot de passe incorrect.")).toBeInTheDocument();
    expect(getTokens()).toBeNull();

    await user.clear(screen.getByLabelText("Mot de passe"));
    await user.type(screen.getByLabelText("Mot de passe"), "admin-dev-only");
    await user.click(screen.getByRole("button", { name: "Se connecter" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Plan de tournées" })).toBeInTheDocument();
    expect(router.state.location.pathname + router.state.location.search).toBe("/plan?day=2027-01-12");
    expect(getTokens()?.access_token).toMatch(/^mock\.access\./);
    expect(screen.getByTestId("user-name")).toHaveTextContent("Administrateur Honowa");
  });

  it("afficher / masquer le mot de passe", async () => {
    const { user } = renderApp("/connexion");
    const password = await screen.findByLabelText("Mot de passe");
    expect(password).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Afficher le mot de passe" }));
    expect(password).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: "Masquer le mot de passe" }));
    expect(password).toHaveAttribute("type", "password");
  });

  it("jetons stockés : session restaurée au démarrage, rafraîchissement transparent si l'accès a expiré", async () => {
    const admin = mockUser("admin");
    setTokens({
      access_token: makeToken("access", admin.id, -1),
      refresh_token: makeToken("refresh", admin.id),
    });
    useSession.setState({ status: "loading", user: null });
    renderApp("/referentiels");
    expect(screen.getByText("Vérification de la session…")).toBeInTheDocument();
    await act(() => useSession.getState().bootstrap());
    expect(await screen.findByRole("heading", { level: 1, name: "Référentiels" })).toBeInTheDocument();
    expect(useSession.getState().user?.email).toBe("admin@honowa.tech");
  });

  it("session expirée en cours d'utilisation : retour à la connexion avec explication", async () => {
    const admin = loginAs("admin");
    renderApp("/administration?tab=users");
    expect(await screen.findByRole("grid", { name: "Utilisateurs" })).toBeInTheDocument();
    setTokens({
      access_token: makeToken("access", admin.id, -1),
      refresh_token: makeToken("refresh", admin.id, -1),
    });
    await act(() => useSession.getState().bootstrap());
    expect(
      await screen.findByText("Votre session a expiré. Reconnectez-vous pour continuer."),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Connexion" })).toBeInTheDocument();
    expect(getTokens()).toBeNull();
  });

  it("déconnexion : jetons effacés, retour à la connexion", async () => {
    loginAs("dispatcher");
    const { user, router } = renderApp("/journee");
    await user.click(await screen.findByTestId("user-menu"));
    expect(screen.getByText("dispatch@ola.example")).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Se déconnecter" }));
    expect(await screen.findByText("Vous êtes déconnecté.")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/connexion");
    expect(getTokens()).toBeNull();
  });
});

describe("coquille", () => {
  it("admin : les dix écrans de la spec §10, dans l'ordre, groupés", async () => {
    loginAs("admin");
    renderApp("/journee");
    await screen.findByTestId("screen-day");
    expect(navLabels()).toEqual([
      "Journée",
      "Commandes du jour",
      "Disponibilité du jour",
      "Plan de tournées",
      "Journal des événements",
      "Chargement",
      "Suivi des livraisons",
      "Comparaison A / B",
      "Référentiels",
      "Administration",
    ]);
    expect(SCREENS.map((screen) => screen.number)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(within(nav()).getByRole("link", { name: "Journée" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("user-role")).toHaveTextContent("Administrateur");
  });

  it.each([
    [
      "fleet",
      [
        "Journée",
        "Disponibilité du jour",
        "Plan de tournées",
        "Journal des événements",
        "Chargement",
        "Suivi des livraisons",
      ],
    ],
    ["supply", ["Journée", "Commandes du jour", "Disponibilité du jour", "Plan de tournées"]],
    [
      "manager",
      [
        "Journée",
        "Commandes du jour",
        "Disponibilité du jour",
        "Plan de tournées",
        "Journal des événements",
        "Chargement",
        "Suivi des livraisons",
        "Comparaison A / B",
        "Référentiels",
      ],
    ],
  ] as const)("navigation filtrée pour le rôle %s", async (role, expected) => {
    loginAs(role);
    renderApp("/journee");
    await screen.findByTestId("screen-day");
    expect(navLabels()).toEqual(expected);
  });

  it("garde par rôle : adresse saisie à la main refusée, sans appel aux données", async () => {
    loginAs("fleet");
    renderApp("/administration");
    expect(await screen.findByRole("heading", { name: "Accès refusé" })).toBeInTheDocument();
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(nav()).toBeInTheDocument();
  });

  it("adresse inconnue : page introuvable dans la coquille ; racine → premier écran du rôle", async () => {
    loginAs("supply");
    const { router } = renderApp("/nimporte-quoi");
    expect(await screen.findByRole("heading", { name: "Page introuvable" })).toBeInTheDocument();
    await act(() => router.navigate("/"));
    expect(await screen.findByTestId("screen-day")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/journee");
  });

  it("jour J : par défaut aujourd'hui (Douala), modifiable, conservé dans l'URL et d'un écran à l'autre", async () => {
    loginAs("dispatcher");
    const { user, router } = renderApp("/journee");
    await screen.findByTestId("screen-day");
    const today = todayLocal();
    const input = screen.getByLabelText("Jour J", { selector: "input" });
    expect(input).toHaveValue(today);
    expect(screen.getByRole("button", { name: "Aujourd'hui" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Jour suivant" }));
    expect(router.state.location.search).toBe(`?day=${addDays(today, 1)}`);
    expect(input).toHaveValue(addDays(today, 1));

    await user.click(within(nav()).getByRole("link", { name: "Commandes du jour" }));
    expect(await screen.findByTestId("screen-orders")).toBeInTheDocument();
    expect(router.state.location.pathname + router.state.location.search).toBe(
      `/commandes?day=${addDays(today, 1)}`,
    );

    await user.click(screen.getByRole("button", { name: "Jour précédent" }));
    await user.click(screen.getByRole("button", { name: "Jour précédent" }));
    expect(router.state.location.search).toBe(`?day=${addDays(today, -1)}`);
    await user.click(screen.getByRole("button", { name: "Aujourd'hui" }));
    expect(router.state.location.search).toBe(`?day=${today}`);
  });

  it("jour J invalide dans l'URL : repli sur aujourd'hui", async () => {
    loginAs("dispatcher");
    renderApp("/plan?day=2027-13-45");
    await screen.findByTestId("screen-plan");
    expect(screen.getByLabelText("Jour J", { selector: "input" })).toHaveValue(todayLocal());
  });

  it("zone d'alertes : documents de chauffeurs expirés, visibles depuis n'importe quel écran", async () => {
    loginAs("dispatcher");
    const { user } = renderApp("/journee");
    expect(await screen.findByTestId("alerts-count")).toHaveTextContent("2");
    await user.click(screen.getByRole("button", { name: /Alertes : 2 alertes/ }));
    expect(
      await screen.findByText("2 chauffeurs ont un permis ou une habilitation expiré"),
    ).toBeInTheDocument();
    expect(screen.getByText("Aboubakar Hamadou, Martin Essomba")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /documents? qui expire/ })).toHaveAttribute(
      "href",
      "/referentiels?tab=drivers",
    );
  });

  it("menu réductible : libellés toujours accessibles", async () => {
    loginAs("admin");
    const { user } = renderApp("/journee");
    await screen.findByTestId("screen-day");
    await user.click(screen.getByRole("button", { name: "Réduire le menu" }));
    expect(within(nav()).getByRole("link", { name: "Référentiels" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Déployer le menu" }));
  });
});

describe("rôles (spec §2)", () => {
  it("chaque rôle voit au moins la journée ; l'administration est réservée à admin", () => {
    for (const role of ROLES) expect(canSee(role, "day")).toBe(true);
    expect(ROLES.filter((role) => canSee(role, "administration"))).toEqual(["admin"]);
    expect(SCREEN_IDS.every((id) => canSee("admin", id))).toBe(true);
    expect(canSee(null, "day")).toBe(false);
  });

  it("écritures : admin partout, manager nulle part, chaque métier dans son domaine", () => {
    expect(can("admin", "referentials.write")).toBe(true);
    expect(can("dispatcher", "referentials.write")).toBe(false);
    expect(can("dispatcher", "orders.write")).toBe(true);
    expect(can("dispatcher", "plan.write")).toBe(true);
    expect(can("fleet", "loading.write")).toBe(true);
    expect(can("fleet", "plan.write")).toBe(false);
    expect(can("supply", "availability.stocks.write")).toBe(true);
    expect(can("supply", "orders.write")).toBe(false);
    expect(
      (Object.keys(CAPABILITIES) as Capability[]).filter((capability) => can("manager", capability)),
    ).toEqual([]);
    expect(can(null, "orders.write")).toBe(false);
  });
});
