import { screen, waitFor, within } from "@testing-library/react";
import { http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { selectAlerts, useAlertsStore } from "@/lib/alerts";
import { API, errorResponse } from "@/mocks/handlers/helpers";
import { server } from "@/mocks/server";
import { loginAs, renderApp } from "@/test/utils";

import { COMPUTE_STORAGE_KEY, computeTiming } from "./api";
import { createDayMocks, MOCK_DAY, mockPlan } from "./mocks";

const ROUTE = `/journee?day=${MOCK_DAY}`;

function setup(overrides: Parameters<typeof createDayMocks>[0] = {}) {
  const mocks = createDayMocks(overrides);
  server.use(...mocks.handlers);
  return mocks;
}

const realTiming = { ...computeTiming };
beforeEach(() => {
  computeTiming.pollMs = 20;
});
afterEach(() => {
  Object.assign(computeTiming, realTiming);
});

describe("Journée — résumé du jour", () => {
  it("affiche commandes, ressources et stocks, avec la liste des manques et les raccourcis", async () => {
    setup();
    loginAs("dispatcher");
    renderApp(ROUTE);

    const orders = await screen.findByTestId("summary-orders");
    expect(within(orders).getByText("23 commandes")).toBeInTheDocument();
    expect(orders.querySelector('[data-status="draft"]')).toHaveTextContent("Brouillon4");
    expect(orders.querySelector('[data-status="confirmed"]')).toHaveTextContent("Confirmée17");
    expect(orders.querySelector('[data-status="planned"]')).toBeNull();
    expect(within(orders).getByText("2 commandes urgentes en attente")).toBeInTheDocument();
    // Raccourci vers les brouillons à confirmer : le jour J et le filtre suivent.
    expect(within(orders).getByRole("link", { name: /Confirmer les brouillons/ })).toHaveAttribute(
      "href",
      `/commandes?status=draft&day=${MOCK_DAY}`,
    );

    const trucks = screen.getByTestId("summary-trucks");
    expect(within(trucks).getByText("5 / 7 affectables")).toBeInTheDocument();
    expect(within(trucks).getByText("2 bloqués (RM-04)")).toBeInTheDocument();

    const drivers = screen.getByTestId("summary-drivers");
    expect(within(drivers).getByText("6 / 10 affectables")).toBeInTheDocument();
    expect(within(drivers).getByText(/dont 2 permis ou habilitations expirés \(RM-03\)/)).toBeInTheDocument();
    expect(within(drivers).getByText("1 chauffeur affectable sans camion")).toBeInTheDocument();

    const stocks = screen.getByTestId("summary-stocks");
    expect(within(stocks).getByText("4 / 6 renseignés")).toBeInTheDocument();
    expect(within(stocks).getByText("2 stocks manquants")).toBeInTheDocument();
    expect(
      within(within(stocks).getByRole("list", { name: "Stocks non renseignés" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["SCDP-YDE · SUPER", "SCDP-YDE · PETROLE"]);
    expect(within(stocks).getByText("Dernière saisie à 06:10")).toBeInTheDocument();
    expect(within(stocks).getByRole("link", { name: /Voir les stocks/ })).toHaveAttribute(
      "href",
      `/disponibilite?tab=stocks&day=${MOCK_DAY}`,
    );
  });

  it("propose la saisie des stocks manquants à l'agent Supply, sans bouton de calcul", async () => {
    setup();
    loginAs("supply");
    renderApp(ROUTE);
    const stocks = await screen.findByTestId("summary-stocks");
    expect(within(stocks).getByRole("link", { name: /Saisir les stocks/ })).toBeInTheDocument();
    expect(screen.getByText(/Lecture seule/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Calculer le plan" })).not.toBeInTheDocument();
  });

  it("signale une erreur de chargement du résumé et permet de réessayer", async () => {
    setup();
    server.use(
      http.get(
        `${API}/availability/summary`,
        () => errorResponse(500, "internal_error", "Le serveur a rencontré une erreur."),
        { once: true },
      ),
    );
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    const summary = await screen.findByTestId("day-summary");
    expect(await within(summary).findByRole("alert")).toHaveTextContent("Le serveur a rencontré une erreur.");
    await user.click(within(summary).getByRole("button", { name: "Réessayer" }));
    expect(await screen.findByText("23 commandes")).toBeInTheDocument();
  });
});

describe("Journée — alertes", () => {
  it("réunit les alertes du tableau de bord et celles de la préparation, bloquantes d'abord", async () => {
    setup();
    loginAs("dispatcher");
    renderApp(ROUTE);
    const panel = await screen.findByRole("region", { name: "Alertes du jour" });
    await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(5));
    const items = within(panel).getAllByRole("listitem");
    expect(items[0]).toHaveAttribute("data-severity", "blocking");
    expect(items[0]).toHaveTextContent("RM-15");
    expect(panel).toHaveTextContent("Tournée 3 — Arrivée 12 min après la fermeture de OLA Bonabéri.");
    expect(panel).toHaveTextContent(/2 stocks dépôt ne sont pas renseignés/);
    expect(panel).toHaveTextContent(/2 chauffeurs ne sont pas affectables/);
    // Alerte d'événement : résumé du serveur affiché tel quel, précédé de l'heure de Douala.
    expect(panel).toHaveTextContent(
      "Événement09:15 — Gasoil au dépôt SCDP-DLA : 8 000 L disponibles, 2 tournées impactées",
    );

    // La coquille reçoit ce qui reste à traiter, avec un lien vers l'écran concerné.
    await waitFor(() =>
      expect(selectAlerts(useAlertsStore.getState()).map((alert) => [alert.severity, alert.to])).toEqual(
        expect.arrayContaining([
          ["blocking", `/plan?day=${MOCK_DAY}`],
          ["warning", `/disponibilite?tab=stocks&day=${MOCK_DAY}`],
        ]),
      ),
    );
  });
});

describe("Journée — événements et liens", () => {
  it("affiche les derniers événements du jour avec l'accès au journal", async () => {
    setup();
    loginAs("dispatcher");
    renderApp(ROUTE);
    const card = await screen.findByTestId("recent-events");
    await waitFor(() => expect(within(card).getAllByRole("listitem")).toHaveLength(2));
    const [latest, older] = within(card).getAllByRole("listitem");
    expect(latest).toHaveTextContent("09:15");
    expect(latest).toHaveTextContent("Pénurie de produit");
    expect(latest).toHaveTextContent("Gasoil au dépôt SCDP-DLA : 8 000 L disponibles, 2 tournées impactées");
    expect(latest).toHaveTextContent("par Hervé Mbah");
    expect(older).toHaveTextContent("Plan v1 publié");
    expect(card).toHaveTextContent("7 événements plus anciens dans le journal");
    expect(within(card).getByRole("link", { name: /Ouvrir le journal/ })).toHaveAttribute(
      "href",
      `/journal?day=${MOCK_DAY}`,
    );
  });

  it("place en tête la version restée en brouillon, avec l'accès direct au plan", async () => {
    const { state } = setup();
    state.dashboard.pending_draft = {
      plan_id: "plan-brouillon",
      version: 3,
      created_at: "2027-01-12T09:20:00Z",
      created_by_name: "Awa Dispatcher",
      blocking_count: 0,
    } as typeof state.dashboard.pending_draft;
    state.dashboard.alerts.unshift({
      source: "plan",
      severity: "warning",
      code: "pending_draft",
      message: "La version 3 créée après la panne du camion LT 482 AB n'est pas publiée.",
      trip_id: null,
      trip_seq: null,
      event_id: null,
      event_type: null,
      occurred_at: "2027-01-12T09:20:00Z",
      payload: { plan_id: "plan-brouillon", version: 3 },
    });
    loginAs("dispatcher");
    renderApp(ROUTE);
    const alerts = await screen.findByTestId("day-alerts");
    const notice = await within(alerts).findByText("Version 3 du plan en brouillon, non publiée");
    // Premier élément de la colonne des alertes, avant le panneau des violations.
    expect(alerts.firstElementChild).toContainElement(notice);
    expect(alerts.firstElementChild).toHaveTextContent(
      "La version 3 créée après la panne du camion LT 482 AB n'est pas publiée.",
    );
    expect(within(alerts).getByRole("link", { name: /Ouvrir le brouillon/ })).toHaveAttribute(
      "href",
      `/plan?plan=plan-brouillon&day=${MOCK_DAY}`,
    );
    // Pas de doublon dans la liste des alertes.
    const panel = within(alerts).getByRole("region", { name: "Alertes du jour" });
    await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(5));
    expect(panel).not.toHaveTextContent("n'est pas publiée");
  });

  it("mène d'une alerte à l'écran où la traiter", async () => {
    setup();
    loginAs("dispatcher");
    const { user, router } = renderApp(ROUTE);
    const panel = await screen.findByRole("region", { name: "Alertes du jour" });
    await user.click(await within(panel).findByRole("button", { name: /Gasoil au dépôt SCDP-DLA/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/journal"));
    expect(router.state.location.search).toBe(`?day=${MOCK_DAY}`);
  });

  it("affiche aussi les derniers événements à l'agent Supply, qui a accès au journal", async () => {
    // Le journal est ouvert à tous les rôles (Supply y déclare les pénuries) : le bloc suit ce droit.
    setup();
    loginAs("supply");
    renderApp(ROUTE);
    await screen.findByTestId("summary-stocks");
    expect(await screen.findByTestId("recent-events")).toBeInTheDocument();
  });
});

describe("Journée — plans du jour et dernier calcul", () => {
  it("liste les plans avec statut, violations et accès à l'écran Plan", async () => {
    setup({
      plans: [
        mockPlan({ id: "plan-2", version: 2, status: "draft", approximate: false, blocking_count: 0 }),
        mockPlan({ id: "plan-1", version: 1, status: "published", warning_count: 0 }),
      ],
    });
    loginAs("manager");
    renderApp(ROUTE);
    const grid = await screen.findByRole("grid", { name: "Plans du jour" });
    await waitFor(() => expect(within(grid).getAllByRole("row")).toHaveLength(3));
    const [, draft, published] = within(grid).getAllByRole("row");
    expect(draft).toHaveTextContent("Plan calculé");
    expect(draft).toHaveTextContent("v2");
    expect(draft).toHaveTextContent("Brouillon");
    expect(draft).toHaveTextContent("19 / 20");
    expect(draft).toHaveTextContent(/89,3\skm/);
    expect(draft).toHaveTextContent(/78\s%/);
    expect(draft).toHaveTextContent("2 avertissements");
    expect(published).toHaveTextContent("Publié");
    expect(published).toHaveTextContent("1 bloquante");
    expect(published).toHaveTextContent("Distances approchées");
    expect(within(draft).getByRole("link", { name: "Ouvrir le plan Plan calculé v2" })).toHaveAttribute(
      "href",
      `/plan?plan=plan-2&day=${MOCK_DAY}`,
    );

    // État du dernier calcul : le plus récent des plans calculés.
    const last = screen.getByTestId("last-compute");
    expect(last).toHaveTextContent("12/01/2027 06:42");
    expect(last).toHaveTextContent(/3,5\ss/);
    expect(last).toHaveTextContent("moteur-1.4.2");
    expect(last).toHaveTextContent("Distances routières");
    expect(last).toHaveTextContent("Awa Dispatcher");
  });

  it("signale les distances approchées du dernier calcul", async () => {
    setup({ plans: [mockPlan()] });
    loginAs("dispatcher");
    renderApp(ROUTE);
    expect(await screen.findByTestId("approximate-flag")).toHaveTextContent("Distances approchées");
    expect(screen.getByRole("button", { name: "Recalculer un nouveau plan" })).toBeEnabled();
  });
});

describe("Journée — calcul du plan", () => {
  it("lance le calcul, suit la progression puis donne accès au plan produit", async () => {
    // Progression figée à 45 % le temps de l'observer, puis fin du calcul.
    const { state } = setup({
      taskScript: [{ state: "running", progress: 45, message: "Construction des tournées" }],
    });
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    expect(await screen.findByText(/17 commandes confirmées seront planifiées/)).toBeInTheDocument();
    expect(screen.getByText("Aucun plan calculé pour ce jour.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Calculer le plan" }));
    const progress = await screen.findByRole("progressbar", { name: "Progression du calcul" });
    await waitFor(() => expect(progress).toHaveAttribute("aria-valuenow", "45"));
    expect(screen.getByTestId("compute-progress")).toHaveTextContent("Construction des tournées");
    expect(screen.getByRole("button", { name: "Calculer le plan" })).toBeDisabled();
    expect(state.computeCalls).toEqual([{ day: MOCK_DAY }]);
    // L'identifiant de la tâche est conservé pour survivre à un rafraîchissement.
    expect(JSON.parse(window.localStorage.getItem(COMPUTE_STORAGE_KEY) ?? "{}")[MOCK_DAY].taskId).toBe(
      "task-1",
    );

    state.taskScript = [{ state: "succeeded", progress: 100, message: "Plan calculé", plan_id: "plan-new" }];
    expect(await screen.findByText("Calcul terminé")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Ouvrir le plan$/ })).toHaveAttribute(
      "href",
      `/plan?plan=plan-new&day=${MOCK_DAY}`,
    );
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    // La liste des plans et le dernier calcul sont rafraîchis ; le suivi n'est plus mémorisé.
    const grid = screen.getByRole("grid", { name: "Plans du jour" });
    await waitFor(() => expect(within(grid).getAllByRole("row")).toHaveLength(2));
    expect(screen.getByTestId("last-compute")).toHaveTextContent("moteur-1.4.2");
    expect(JSON.parse(window.localStorage.getItem(COMPUTE_STORAGE_KEY) ?? "{}")[MOCK_DAY]).toBeUndefined();
  });

  it("reprend le suivi d'un calcul en cours après un rafraîchissement de la page", async () => {
    const { state } = setup({
      taskScript: [{ state: "running", progress: 70, message: "Amélioration des tournées" }],
    });
    window.localStorage.setItem(
      COMPUTE_STORAGE_KEY,
      JSON.stringify({ [MOCK_DAY]: { taskId: "task-en-cours", startedAt: Date.now() } }),
    );
    loginAs("dispatcher");
    renderApp(ROUTE);
    const progress = await screen.findByRole("progressbar");
    await waitFor(() => expect(progress).toHaveAttribute("aria-valuenow", "70"));
    expect(screen.getByTestId("compute-progress")).toHaveTextContent("Amélioration des tournées");
    expect(state.computeCalls).toHaveLength(0);
    // Le suivi d'un autre jour n'est pas affiché.
    expect(screen.getByRole("button", { name: "Calculer le plan" })).toBeDisabled();
  });

  it("signale un calcul qui ne démarre pas et permet d'arrêter le suivi", async () => {
    setup({ taskScript: [{ state: "pending", progress: 0, message: "En attente de démarrage" }] });
    window.localStorage.setItem(
      COMPUTE_STORAGE_KEY,
      JSON.stringify({ [MOCK_DAY]: { taskId: "task-perdue", startedAt: Date.now() - 10 * 60_000 } }),
    );
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    expect(await screen.findByText(/n'a pas démarré depuis plus de deux minutes/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ne plus suivre ce calcul" }));
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Calculer le plan" })).toBeEnabled();
    expect(window.localStorage.getItem(COMPUTE_STORAGE_KEY)).toBe("{}");
  });

  it("explique le refus 409 quand aucune commande n'est confirmée", async () => {
    const { state } = setup();
    state.summary.orders.by_status.confirmed = 0;
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    expect(
      await screen.findByText(/Aucune commande confirmée : confirmez des commandes/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Calculer le plan" }));
    const alert = (await screen.findByText("Aucune commande confirmée à planifier")).closest(
      '[role="alert"]',
    ) as HTMLElement;
    expect(alert).toHaveTextContent("Aucune commande confirmée à planifier pour le 12/01/2027.");
    expect(within(alert).getByRole("link", { name: /Aller aux commandes/ })).toHaveAttribute(
      "href",
      `/commandes?day=${MOCK_DAY}`,
    );
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    await user.click(within(alert).getByRole("button", { name: "Fermer" }));
    expect(screen.queryByText("Aucune commande confirmée à planifier")).not.toBeInTheDocument();
  });

  it("affiche le message lisible d'un calcul en échec", async () => {
    setup({
      taskScript: [
        {
          state: "failed",
          progress: 0,
          message: "Échec du calcul",
          error: "Aucun camion affectable pour ce jour.",
        },
      ],
    });
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    await user.click(await screen.findByRole("button", { name: "Calculer le plan" }));
    const alert = (await screen.findByText("Le calcul a échoué")).closest('[role="alert"]') as HTMLElement;
    expect(alert).toHaveTextContent("Aucun camion affectable pour ce jour.");
    expect(screen.getByRole("button", { name: "Calculer le plan" })).toBeEnabled();
  });
});
