import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { server } from "@/mocks/server";
import { loginAs, renderApp } from "@/test/utils";

import type { PlanMetrics } from "./api";
import { comparisonHandlers, DASHBOARD_NO_PLAN, DAY, FAVORABLE, IDS, PLANS } from "./fixtures";
import { preselect } from "./index";
import { formatDelta, formatDeltaPct, formatMetric } from "./metricFormat";
import { sharedPoints } from "./RouteMaps";
import { replayConfig } from "./useReplay";
import { verdictOutcome } from "./VerdictBanner";

const URL_BASE = `/comparaison?day=${DAY}`;
const pair = (b: string) => `${URL_BASE}&a=${IDS.reference}&b=${b}`;
const nbsp = (text: string) => text.replace(/ /g, " ");

function use(options?: Parameters<typeof comparisonHandlers>[0]) {
  const { handlers, recorded } = comparisonHandlers(options);
  server.use(...handlers);
  return recorded;
}

const metricRow = (key: keyof PlanMetrics) => document.querySelector(`[data-metric="${key}"]`) as HTMLElement;
const cells = (row: HTMLElement) => within(row).getAllByRole("cell");
const xlsx = (name: string) =>
  new File(["classeur"], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

beforeEach(() => {
  replayConfig.pollMs = 5;
});

describe("Comparaison — verdict et indicateurs", () => {
  it("présélectionne la journée de référence et son rejeu, et affiche un verdict favorable", async () => {
    use();
    loginAs("manager");
    renderApp(URL_BASE);

    const verdict = await screen.findByTestId("verdict");
    expect(verdict).toHaveAttribute("data-outcome", "success");
    expect(within(verdict).getByTestId("verdict-status")).toHaveTextContent("Objectif atteint");
    expect(within(verdict).getByTestId("verdict-hero")).toHaveTextContent(
      /^−27,9 %\s?de kilomètres avec le plan B$/,
    );
    // Le message est celui du serveur, tel quel.
    expect(within(verdict).getByTestId("verdict-message")).toHaveTextContent(FAVORABLE.verdict.message);
    expect(verdict.querySelectorAll('[data-met="true"]')).toHaveLength(3);
    expect(within(verdict).getByText("Gain kilométrique d'au moins 10,0 %")).toBeInTheDocument();
    expect(within(verdict).getByText("B : 15 · A : 14")).toBeInTheDocument();
    expect(within(verdict).getByRole("img", { name: /^Plan A : 183\skm$/ })).toBeInTheDocument();
    expect(within(verdict).getByRole("img", { name: /^Plan B : 132\skm$/ })).toBeInTheDocument();
    // Distances approchées : signalées, pour les deux plans.
    expect(within(verdict).getByTestId("verdict-approximate")).toHaveTextContent(
      /Distances approchées\. Plans A et B/,
    );

    // Sélecteurs : la référence non archivée et son rejeu ; rien n'est écrit dans l'URL tant que c'est automatique.
    expect(screen.getByRole("combobox", { name: "Plan A" })).toHaveValue(IDS.reference);
    expect(screen.getByRole("combobox", { name: "Plan B" })).toHaveValue(IDS.replay);
    expect(screen.getByText(/Présélection : journée de référence du jour/)).toBeInTheDocument();
  });

  it("affiche les écarts en valeur et en %, et le plan avantagé donné par le serveur", async () => {
    use();
    loginAs("manager");
    renderApp(URL_BASE);
    await screen.findByTestId("metrics-table");

    const distance = metricRow("distance_estimated_m");
    expect(within(distance).getByRole("rowheader")).toHaveTextContent("Kilomètres estimés");
    expect(cells(distance).map((cell) => cell.textContent)).toEqual([
      nbsp("183 km"),
      nbsp("132 km"),
      nbsp("−51,1 km"),
      nbsp("−27,9 %"),
      "",
      "BPlan B",
    ]);
    expect(distance).toHaveAttribute("data-better", "b");

    // Un indicateur où le plan manuel fait mieux est attribué à A, sans maquillage.
    const warnings = metricRow("violations_warning");
    expect(cells(warnings).at(-1)).toHaveTextContent("Plan A");
    expect(cells(warnings)[2]).toHaveTextContent("+1");

    // Taux en points, temps de préparation avec sa source, calcul de quelques secondes ≠ « 0 min ».
    expect(cells(metricRow("fill_rate_avg_pct"))[2]).toHaveTextContent("+3,4 pt");
    const prep = cells(metricRow("prep_time_s"));
    expect(prep[0]).toHaveTextContent(/^1 h 45\s?\(saisi\)$/);
    expect(prep[1]).toHaveTextContent(/^< 1 min\s?\(temps de calcul\)$/);

    // Égalité et grandeur de contexte.
    expect(cells(metricRow("stations_served")).at(-1)).toHaveTextContent("Égalité");
    expect(metricRow("orders_requested")).toHaveAttribute("data-better", "none");
  });

  it("affiche « — » et non 0 pour les valeurs inconnues", async () => {
    use();
    loginAs("manager");
    renderApp(URL_BASE);
    await screen.findByTestId("metrics-table");

    for (const key of ["distance_actual_m", "stations_delivered", "volume_delivered_l"] as const) {
      const [a, b, delta, deltaPct, , better] = cells(metricRow(key));
      expect(a).not.toHaveTextContent("—");
      expect(b).toHaveTextContent(/^—$/);
      expect(delta).toHaveTextContent(/^—$/);
      expect(deltaPct).toHaveTextContent(/^—$/);
      expect(better).toHaveTextContent(/^—$/);
    }
    // Écart relatif non calculable (A = 0) : « — », l'écart en valeur reste affiché.
    const blocking = cells(metricRow("violations_blocking"));
    expect(blocking[2]).toHaveTextContent(/^0$/);
    expect(blocking[3]).toHaveTextContent(/^—$/);
  });

  it("affiche un résultat défavorable aussi clairement qu'un résultat favorable", async () => {
    use();
    loginAs("manager");
    renderApp(pair(IDS.computed));

    const verdict = await screen.findByTestId("verdict");
    expect(verdict).toHaveAttribute("data-outcome", "failure");
    expect(within(verdict).getByTestId("verdict-status")).toHaveTextContent("Objectif non atteint");
    expect(within(verdict).getByTestId("verdict-hero")).toHaveTextContent("+5,2 %");
    expect(within(verdict).getByTestId("verdict-message")).toHaveTextContent(
      /le plan B parcourt 5,2 % de kilomètres en plus/,
    );
    expect(verdict.querySelectorAll('[data-met="false"]')).toHaveLength(3);
    expect(within(verdict).getByText("2 violations bloquantes")).toBeInTheDocument();
    expect(within(verdict).getByText("B : 13 · A : 14")).toBeInTheDocument();
    // Seul le plan A est approché ici ; pas de comparaison aux km réels (non fournie par le serveur).
    expect(within(verdict).getByTestId("verdict-approximate")).toHaveTextContent(/Plan A :/);
    expect(within(verdict).queryByText(/À titre indicatif/)).not.toBeInTheDocument();

    expect(cells(metricRow("distance_estimated_m")).at(-1)).toHaveTextContent("Plan A");
    expect(cells(metricRow("distance_estimated_m"))[3]).toHaveTextContent("+5,2 %");
    // Km réels partiels de A : signalés.
    expect(screen.getByTestId("partial-actual")).toHaveTextContent(
      "Plan A : km réels connus pour 1 tournée sur 2 — total partiel.",
    );
  });

  it("gère un plan sans tournée : objectif kilométrique atteint « sous réserve », carte vide, non servies listées", async () => {
    use();
    loginAs("manager");
    renderApp(pair(IDS.empty));

    const verdict = await screen.findByTestId("verdict");
    expect(verdict).toHaveAttribute("data-outcome", "reserve");
    expect(within(verdict).getByTestId("verdict-status")).toHaveTextContent(
      "Objectif kilométrique atteint, sous réserve",
    );
    expect(within(verdict).getByText("B : 0 · A : 14").closest("li")).toHaveAttribute("data-met", "false");

    const planB = screen.getByTestId("plan-b");
    expect(within(planB).getByText("Ce plan ne contient aucune tournée.")).toBeInTheDocument();
    expect(within(planB).getByText("Commandes non servies (1)")).toBeInTheDocument();
    expect(within(planB).getByText("Aucun camion affectable")).toBeInTheDocument();
    expect(cells(metricRow("fill_rate_avg_pct"))[1]).toHaveTextContent(/^—$/);
    // Les deux cartes gardent le même cadrage : mêmes marqueurs des deux côtés.
    const markers = (side: string) =>
      [...screen.getByTestId(side).querySelectorAll("[data-point]")].map((node) =>
        node.getAttribute("data-point"),
      );
    expect(markers("plan-b")).toEqual(markers("plan-a"));
    expect(markers("plan-a")).toHaveLength(5);
  });
});

describe("Comparaison — cartes et tournées", () => {
  it("trace les tournées de chaque plan et détaille la tournée sélectionnée", async () => {
    use();
    loginAs("manager");
    const { user } = renderApp(URL_BASE);
    const planA = await screen.findByTestId("plan-a");
    const planB = screen.getByTestId("plan-b");

    expect(within(planA).getByRole("figure", { name: "Carte du plan A" })).toBeInTheDocument();
    expect(planA.querySelectorAll("[data-route]")).toHaveLength(2);
    expect(planB.querySelectorAll("[data-route]")).toHaveLength(2);
    expect(within(planA).getByText("Commandes non servies (1)")).toBeInTheDocument();
    expect(within(planB).getByText("Toutes les commandes demandées sont servies.")).toBeInTheDocument();
    expect(within(planB).getByText("Sans chauffeur")).toBeInTheDocument();

    await user.click(within(planB).getByRole("button", { name: "Tournée 1" }));
    const detail = within(planB).getByTestId("trip-detail");
    expect(within(detail).getByText("OLA Ndokoti")).toBeInTheDocument();
    expect(within(detail).getByText("GASOIL 10 000 L")).toBeInTheDocument();
    expect(within(detail).getAllByRole("row")).toHaveLength(4);
    // Heures affichées en heure de Douala (UTC+1).
    expect(within(detail).getByText("07:30")).toBeInTheDocument();
    // Les autres tournées du même plan sont atténuées, l'autre carte ne bouge pas.
    expect(planB.querySelectorAll('[data-route][opacity="0.35"]')).toHaveLength(1);
    expect(planA.querySelectorAll('[data-route][opacity="0.35"]')).toHaveLength(0);

    await user.click(within(planB).getByRole("button", { name: "Tournée 1" }));
    expect(within(planB).queryByTestId("trip-detail")).not.toBeInTheDocument();
  });

  it("réunit les marqueurs des deux plans sans doublon", () => {
    const points = sharedPoints(FAVORABLE.routes_a, FAVORABLE.routes_b);
    expect(points.map((point) => point.id).sort()).toEqual([
      "depot:SCDP-DLA",
      "station:ST-AKWA",
      "station:ST-BONAB",
      "station:ST-MAKEP",
      "station:ST-NDOKO",
    ]);
  });
});

describe("Comparaison — choix des plans", () => {
  it("conserve le choix dans l'URL et signale deux plans identiques", async () => {
    use();
    loginAs("manager");
    const { user, router } = renderApp(URL_BASE);
    await screen.findByTestId("verdict");

    await user.selectOptions(screen.getByRole("combobox", { name: "Plan B" }), IDS.computed);
    await waitFor(() => expect(screen.getByTestId("verdict")).toHaveAttribute("data-outcome", "failure"));
    const query = new URLSearchParams(router.state.location.search);
    expect(Object.fromEntries(query)).toEqual({
      day: DAY,
      a: IDS.reference,
      b: IDS.computed,
      da: DAY,
      db: DAY,
    });
    expect(screen.queryByText(/Présélection/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Inverser A et B" }));
    expect(new URLSearchParams(router.state.location.search).get("a")).toBe(IDS.computed);

    await user.selectOptions(screen.getByRole("combobox", { name: "Plan B" }), IDS.computed);
    expect(await screen.findByText(/Les deux sélecteurs désignent le même plan/)).toBeInTheDocument();
    expect(screen.queryByTestId("verdict")).not.toBeInTheDocument();
  });

  it("décrit chaque plan : type, version, statut, libellé", async () => {
    use();
    loginAs("manager");
    renderApp(URL_BASE);
    const select = await screen.findByRole("combobox", { name: "Plan A" });
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(PLANS.length + 1));
    expect(
      within(select).getByRole("option", {
        name: "Journée de référence · v1 · Archivé — Journée A — ancienne",
      }),
    ).toBeInTheDocument();
    expect(
      within(select).getByRole("option", { name: "Plan calculé · v1 · Publié — Plan du jour (06:10)" }),
    ).toBeInTheDocument();
  });

  it("sans journée de référence : invite à choisir, et à importer pour le dispatcher seulement", async () => {
    use({ plans: [] });
    loginAs("manager");
    const first = renderApp(URL_BASE);
    expect(await screen.findByText("Choisissez deux plans à comparer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Importer la journée A" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Exporter le PDF" })).toBeDisabled();
    first.unmount();

    loginAs("dispatcher");
    renderApp(URL_BASE);
    expect(await screen.findByText(/Importez la journée A telle qu'elle a été faite/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Importer la journée A" })).toHaveLength(2);
  });

  it("présélection : référence non archivée la plus récente et son rejeu", () => {
    expect(preselect(PLANS)).toEqual({ a: IDS.reference, b: IDS.replay });
    expect(preselect(PLANS.filter((plan) => plan.kind !== "replay"))).toEqual({
      a: IDS.reference,
      b: null,
    });
    expect(preselect(PLANS.filter((plan) => plan.kind === "computed"))).toEqual({ a: null, b: null });
  });
});

describe("Comparaison — droits et export", () => {
  it("la direction consulte et exporte le PDF, sans import ni rejeu", async () => {
    const recorded = use();
    loginAs("manager");
    const { user } = renderApp(URL_BASE);
    await screen.findByTestId("verdict");

    expect(screen.getByText(/réservés au dispatcher/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Rejouer/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Importer la journée A" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Exporter le PDF" }));
    await waitFor(() => expect(recorded.pdf).toEqual([`?plan_a=${IDS.reference}&plan_b=${IDS.replay}`]));
  });
});

describe("Comparaison — journée de référence et rejeu (dispatcher)", () => {
  it("contrôle le fichier, montre le rapport ligne par ligne et bloque l'import en cas d'erreur", async () => {
    const recorded = use();
    loginAs("dispatcher");
    const { user } = renderApp(URL_BASE);
    await screen.findByTestId("verdict");

    await user.click(screen.getByRole("button", { name: "Importer la journée A" }));
    const dialog = await screen.findByRole("dialog", { name: "Importer une journée de référence" });
    expect(within(dialog).getByRole("button", { name: "Contrôler le fichier" })).toBeDisabled();

    await user.upload(within(dialog).getByLabelText("Fichier de la journée"), xlsx("journee_erreur.xlsx"));
    await user.click(within(dialog).getByRole("button", { name: "Contrôler le fichier" }));

    const report = await within(dialog).findByTestId("reference-report");
    expect(within(report).getByText(/Fichier rejeté : 2 erreur\(s\)/)).toBeInTheDocument();
    const rows = within(report).getAllByRole("row").slice(1);
    expect(
      rows.map((row) =>
        within(row)
          .getAllByRole("cell")
          .map((cell) => cell.textContent),
      ),
    ).toEqual([
      ["Erreur", "Tournées", "3", "Code station", "Station inconnue : ST-XXX."],
      ["Erreur", "Tournées", "5", "Camion", "Camion inconnu : LT 999 ZZ."],
    ]);
    // Pas de bouton d'import tant qu'il reste des erreurs ; rien d'autre qu'un contrôle n'a été envoyé.
    expect(within(dialog).queryByRole("button", { name: "Importer la journée" })).not.toBeInTheDocument();
    expect(recorded.imports).toEqual([{ dry_run: "true", filename: "journee_erreur.xlsx" }]);
  });

  it("importe après contrôle, remplace la journée existante après confirmation, puis propose le rejeu", async () => {
    const recorded = use();
    loginAs("dispatcher");
    const { user, router } = renderApp(URL_BASE);
    await screen.findByTestId("verdict");

    await user.click(screen.getByRole("button", { name: "Importer la journée A" }));
    const dialog = await screen.findByRole("dialog", { name: "Importer une journée de référence" });
    await user.upload(within(dialog).getByLabelText("Fichier de la journée"), xlsx("journee.xlsx"));
    await user.type(within(dialog).getByLabelText("Temps de préparation du plan manuel"), "-5");
    expect(within(dialog).getByText("Saisissez un nombre de minutes positif.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Contrôler le fichier" })).toBeDisabled();
    await user.clear(within(dialog).getByLabelText("Temps de préparation du plan manuel"));
    await user.type(within(dialog).getByLabelText("Temps de préparation du plan manuel"), "105");
    await user.type(within(dialog).getByLabelText("Libellé"), "Journée A du 12 janvier");
    await user.click(within(dialog).getByRole("button", { name: "Contrôler le fichier" }));

    const report = await within(dialog).findByTestId("reference-report");
    expect(within(report).getByText("Fichier valide pour la journée du 12/01/2027.")).toBeInTheDocument();
    expect(within(report).getByTestId("reference-summary")).toHaveTextContent(
      "15 commandes · 6 tournées · 14 arrêts · 133 500 L livrés · km réels sur 6 tournées sur 6",
    );
    expect(within(report).getByText("Avertissement")).toBeInTheDocument();

    // Une journée existe déjà : 409, puis remplacement seulement après confirmation.
    await user.click(within(dialog).getByRole("button", { name: "Importer la journée" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Remplacer la journée de référence ?" });
    expect(confirm).toHaveTextContent(/L'ancienne journée sera archivée/);
    await user.click(within(confirm).getByRole("button", { name: "Remplacer" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(recorded.imports).toEqual([
      { dry_run: "true", prep_time_min: "105", label: "Journée A du 12 janvier", filename: "journee.xlsx" },
      { prep_time_min: "105", label: "Journée A du 12 janvier", filename: "journee.xlsx" },
      {
        prep_time_min: "105",
        label: "Journée A du 12 janvier",
        replace: "true",
        filename: "journee.xlsx",
      },
    ]);

    // La nouvelle journée devient le plan A ; il manque B : le rejeu est proposé.
    await waitFor(() =>
      expect(new URLSearchParams(router.state.location.search).get("a")).toBe(IDS.newReference),
    );
    expect(new URLSearchParams(router.state.location.search).has("b")).toBe(false);
    expect(await screen.findByText("Il manque le plan B")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Rejouer avec le moteur" })).toHaveLength(2),
    );
  });

  it("annuler la confirmation ne remplace rien", async () => {
    const recorded = use();
    loginAs("dispatcher");
    const { user } = renderApp(URL_BASE);
    await screen.findByTestId("verdict");
    await user.click(screen.getByRole("button", { name: "Importer la journée A" }));
    const dialog = await screen.findByRole("dialog", { name: "Importer une journée de référence" });
    await user.upload(within(dialog).getByLabelText("Fichier de la journée"), xlsx("journee.xlsx"));
    await user.click(within(dialog).getByRole("button", { name: "Contrôler le fichier" }));
    await user.click(await within(dialog).findByRole("button", { name: "Importer la journée" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Annuler" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(recorded.imports.filter((fields) => fields.replace === "true")).toHaveLength(0);
    expect(screen.getByRole("dialog", { name: "Importer une journée de référence" })).toBeInTheDocument();
  });

  it("rejoue la journée de référence, suit la progression et ouvre la comparaison A ↔ rejeu", async () => {
    replayConfig.pollMs = 60;
    const recorded = use();
    loginAs("dispatcher");
    const { user, router } = renderApp(URL_BASE);
    await screen.findByTestId("verdict");

    await user.click(screen.getByRole("button", { name: "Rejouer à nouveau" }));
    const progress = await screen.findByTestId("replay-progress");
    await waitFor(() =>
      expect(within(progress).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40"),
    );
    expect(progress).toHaveTextContent("Calcul des tournées");

    await waitFor(() =>
      expect(new URLSearchParams(router.state.location.search).get("b")).toBe(IDS.newReplay),
    );
    expect(new URLSearchParams(router.state.location.search).get("a")).toBe(IDS.reference);
    expect(recorded.replays).toEqual([IDS.reference]);
    await waitFor(() => expect(screen.queryByTestId("replay-progress")).not.toBeInTheDocument());
    expect(await screen.findByTestId("verdict")).toHaveAttribute("data-outcome", "success");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Plan B" })).toHaveValue(IDS.newReplay));
  });

  it("signale un rejeu en échec avec le message du moteur", async () => {
    use({ taskStates: [{ state: "failed", progress: 30, error: "Aucun camion disponible ce jour-là." }] });
    loginAs("dispatcher");
    const { user } = renderApp(URL_BASE);
    await screen.findByTestId("verdict");
    await user.click(screen.getByRole("button", { name: "Rejouer à nouveau" }));
    const alert = await screen.findByText("Aucun camion disponible ce jour-là.");
    expect(alert.closest('[role="alert"]')).toHaveTextContent("Le rejeu a échoué.");
    expect(screen.getByRole("button", { name: "Relancer" })).toBeInTheDocument();
  });

  it("ne propose pas de rejouer un plan qui n'est pas une journée de référence", async () => {
    use();
    loginAs("dispatcher");
    renderApp(`${URL_BASE}&a=${IDS.computed}&b=${IDS.replay}`);
    const button = await screen.findByRole("button", { name: "Rejouer à nouveau" });
    await waitFor(() => expect(button).toBeDisabled());
  });
});

describe("Comparaison — suivi de la journée B", () => {
  it("affiche l'avancement, les retards estimés et les alertes actives du plan publié", async () => {
    use();
    loginAs("manager");
    renderApp(`${URL_BASE}&vue=suivi`);

    const panel = await screen.findByTestId("dashboard-panel");
    expect(
      within(panel).getByRole("heading", { name: "Suivi de la journée du 12/01/2027" }),
    ).toBeInTheDocument();
    const tiles = await within(panel).findByTestId("dashboard-tiles");
    expect(tiles).toHaveTextContent("Tournées terminées1 sur 3");
    expect(tiles).toHaveTextContent("Arrêts livrés4 sur 7");
    expect(tiles).toHaveTextContent("1 arrêt sauté");
    expect(tiles).toHaveTextContent("Retard maximal : 25 min");
    expect(tiles).toHaveTextContent("Alertes actives2");
    expect(within(panel).getByText("Plan publié · version 3")).toBeInTheDocument();

    const trips = within(panel).getByTestId("dashboard-trips");
    const first = within(trips).getAllByRole("row")[1];
    expect(within(first).getByText("En cours")).toBeInTheDocument();
    expect(within(first).getByRole("meter", { name: "2 arrêts livrés sur 3" })).toBeInTheDocument();
    expect(within(first).getByText("+ 25 min")).toBeInTheDocument();
    expect(first).toHaveTextContent("OLA Makepe prévue 10:00 · arrivée estimée 10:25");
    expect(within(within(trips).getAllByRole("row")[2]).getByText("À l'heure")).toBeInTheDocument();

    const alerts = within(panel).getByTestId("dashboard-alerts");
    expect(within(alerts).getAllByRole("listitem")).toHaveLength(2);
    expect(alerts).toHaveTextContent("Panne du camion LT 306 DB sur la tournée 3.");
    expect(alerts).toHaveTextContent("Tournée 3 · 09:10");
    expect(within(panel).getByTestId("dashboard-delays")).toHaveTextContent("OLA Ndokoti");
  });

  it("sans plan publié : l'état vide l'explique", async () => {
    use({ dashboard: DASHBOARD_NO_PLAN });
    loginAs("manager");
    const { user } = renderApp(URL_BASE);
    await screen.findByTestId("verdict");
    await user.click(screen.getByRole("tab", { name: "Suivi de la journée B" }));
    expect(await screen.findByText("Aucun plan publié pour ce jour")).toBeInTheDocument();
    expect(screen.getByText("Aucune alerte active.")).toBeInTheDocument();
    expect(screen.getByText("Aucun arrêt livré en retard.")).toBeInTheDocument();
  });
});

describe("Comparaison — mise en forme", () => {
  it("met en forme valeurs et écarts selon l'unité, inconnues en « — »", () => {
    expect(formatMetric("m", 182934)).toBe(nbsp("183 km"));
    expect(formatMetric("l", 138500)).toBe(nbsp("138 500 L"));
    expect(formatMetric("s", 6300)).toBe(nbsp("1 h 45"));
    expect(formatMetric("s", 6)).toBe("< 1 min");
    expect(formatMetric("s", 0)).toBe(nbsp("0 min"));
    expect(formatMetric("pct", 85.67)).toBe(nbsp("85,7 %"));
    expect(formatMetric("count", 0)).toBe("0");
    expect(formatMetric("count", null)).toBe("—");
    expect(formatDelta("m", -51056)).toBe(nbsp("−51,1 km"));
    expect(formatDelta("count", 2)).toBe("+2");
    expect(formatDelta("count", 0)).toBe("0");
    expect(formatDelta("l", null)).toBe("—");
    expect(formatDeltaPct(-27.91)).toBe(nbsp("−27,9 %"));
    expect(formatDeltaPct(null)).toBe("—");
  });

  it("ton du verdict : réserve si un critère de service ou de violation n'est pas tenu", () => {
    const verdict = FAVORABLE.verdict;
    expect(verdictOutcome(verdict)).toBe("success");
    expect(verdictOutcome({ ...verdict, no_blocking_violation: false })).toBe("reserve");
    expect(verdictOutcome({ ...verdict, success: false })).toBe("failure");
    expect(verdictOutcome({ ...verdict, success: null, gain_pct: null })).toBe("unknown");
  });
});
