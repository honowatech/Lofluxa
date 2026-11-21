import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { server } from "@/mocks/server";
import { loginAs, renderApp } from "@/test/utils";

import { createAvailabilityMocks, MOCK_DAY } from "./mocks";

const route = (tab: string) => `/disponibilite?day=${MOCK_DAY}&tab=${tab}`;

function setup() {
  const mocks = createAvailabilityMocks();
  server.use(...mocks.handlers);
  return mocks;
}

type User = ReturnType<typeof renderApp>["user"];
const dataRows = (table: HTMLElement) => within(table).getAllByRole("row").slice(1);
async function loadedGrid(name: string, count: number) {
  const table = await screen.findByRole("grid", { name });
  await waitFor(() => expect(dataRows(table)).toHaveLength(count));
  return table;
}
const rowOf = (table: HTMLElement, text: string) =>
  dataRows(table).find((row) => row.textContent?.includes(text)) as HTMLElement;
const openActions = async (user: User, row: HTMLElement, item: string) => {
  await user.click(within(row).getByRole("button", { name: /^Actions/ }));
  await user.click(await screen.findByRole("menuitem", { name: item }));
};
const cell = (name: string) => screen.getByRole("textbox", { name });
/** Valeur affichée d'une cellule de stock, espaces insécables normalisés. */
const shown = (name: string) => (cell(name) as HTMLInputElement).value.replace(/\s/g, " ");

describe("Disponibilité — stocks dépôt", () => {
  it("saisit rapidement la grille dépôt × produit et n'envoie que les cellules modifiées", async () => {
    const { state } = setup();
    loginAs("supply");
    const { user } = renderApp(route("stocks"));

    const grid = await screen.findByRole("table", { name: "Stock disponible par dépôt et par produit" });
    expect(within(grid).getAllByRole("textbox")).toHaveLength(6);
    expect(screen.getByText("5 stocks manquants")).toBeInTheDocument();
    expect(screen.getByText("1 / 6 renseignés")).toBeInTheDocument();
    // Valeur courante, heure (Douala) et auteur de la dernière saisie.
    expect(shown("SCDP-DLA — Gasoil")).toBe("120 000");
    expect(screen.getByTestId("stock-dep-dla:prod-gasoil")).toHaveTextContent("06:10 · Hervé Mbah");
    expect(screen.getByTestId("stock-dep-yde:prod-super")).toHaveTextContent("Non renseigné");
    expect(screen.getByRole("button", { name: "Enregistrer" })).toBeDisabled();

    await user.click(cell("SCDP-DLA — Super"));
    await user.keyboard("80000");
    // Flèche bas : même produit, dépôt suivant.
    await user.keyboard("{ArrowDown}");
    expect(cell("SCDP-YDE — Super")).toHaveFocus();
    await user.keyboard("45 500,5");
    await user.clear(cell("SCDP-DLA — Gasoil"));
    await user.type(cell("SCDP-DLA — Gasoil"), "118000");
    expect(screen.getByText("3 modifications non enregistrées")).toBeInTheDocument();
    expect(screen.getByTestId("stock-total-SUPER")).toHaveTextContent(/125\s501\sL/);

    // Entrée enregistre toute la grille.
    await user.keyboard("{Enter}");
    expect(await screen.findByText("3 stocks enregistrés")).toBeInTheDocument();
    expect(state.stockPuts).toHaveLength(1);
    expect(state.stockPuts[0]).toEqual(
      expect.arrayContaining([
        { depot_id: "dep-dla", product_id: "prod-super", available_l: 80000 },
        { depot_id: "dep-yde", product_id: "prod-super", available_l: 45500.5 },
        { depot_id: "dep-dla", product_id: "prod-gasoil", available_l: 118000 },
      ]),
    );
    expect(state.stockPuts[0]).toHaveLength(3);
    await waitFor(() => expect(screen.getByText("3 / 6 renseignés")).toBeInTheDocument());
    expect(screen.getByTestId("stock-dep-yde:prod-super")).toHaveTextContent("06:42 · Hervé Mbah");
    expect(screen.queryByText(/non enregistrée/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enregistrer" })).toBeDisabled();
  });

  it("refuse une valeur négative et permet d'annuler la saisie", async () => {
    const { state } = setup();
    loginAs("supply");
    const { user } = renderApp(route("stocks"));
    await screen.findByRole("table", { name: "Stock disponible par dépôt et par produit" });

    await user.type(cell("SCDP-YDE — Gasoil"), "-5");
    expect(within(screen.getByTestId("stock-dep-yde:prod-gasoil")).getByRole("alert")).toHaveTextContent(
      "Le volume ne peut pas être négatif",
    );
    expect(screen.getByRole("button", { name: "Enregistrer (1)" })).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(state.stockPuts).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Annuler les modifications" }));
    expect(shown("SCDP-YDE — Gasoil")).toBe("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // Zéro est une valeur saisie (≠ non renseigné).
    await user.type(cell("SCDP-YDE — Gasoil"), "0");
    await user.click(screen.getByRole("button", { name: "Enregistrer (1)" }));
    await waitFor(() =>
      expect(state.stockPuts).toEqual([[{ depot_id: "dep-yde", product_id: "prod-gasoil", available_l: 0 }]]),
    );
  });

  it("efface une saisie après confirmation : le stock redevient non renseigné, l'historique en garde la trace", async () => {
    const { state } = setup();
    loginAs("supply");
    const { user } = renderApp(route("stocks"));
    await screen.findByRole("table", { name: "Stock disponible par dépôt et par produit" });

    await user.clear(cell("SCDP-DLA — Gasoil"));
    expect(screen.getByTestId("stock-dep-dla:prod-gasoil")).toHaveTextContent("Sera effacé");
    await user.click(screen.getByRole("button", { name: "Enregistrer (1)" }));
    let dialog = await screen.findByRole("alertdialog", { name: "Effacer la saisie ?" });
    expect(dialog).toHaveTextContent("SCDP-DLA — Gasoil");
    // Sans confirmation, rien ne part.
    await user.click(within(dialog).getByRole("button", { name: "Annuler" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(state.stockPuts).toHaveLength(0);
    expect(screen.getByText("1 modification non enregistrée")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Enregistrer (1)" }));
    dialog = await screen.findByRole("alertdialog", { name: "Effacer la saisie ?" });
    await user.click(within(dialog).getByRole("button", { name: "Effacer" }));
    expect(await screen.findByText("1 saisie effacée")).toBeInTheDocument();
    expect(state.stockPuts).toEqual([
      [{ depot_id: "dep-dla", product_id: "prod-gasoil", available_l: null }],
    ]);
    await waitFor(() => expect(screen.getByText("0 / 6 renseignés")).toBeInTheDocument());
    expect(shown("SCDP-DLA — Gasoil")).toBe("");
    expect(screen.getByTestId("stock-dep-dla:prod-gasoil")).toHaveTextContent(
      /Non renseigné — effacé à \d\d:\d\d par Hervé Mbah/,
    );

    await user.click(screen.getByRole("button", { name: "Historique — SCDP-DLA — Gasoil" }));
    const history = await screen.findByRole("dialog", { name: "Historique des saisies — SCDP-DLA · Gasoil" });
    await waitFor(() => expect(within(history).getAllByRole("row")).toHaveLength(4));
    expect(within(history).getAllByRole("row")[1]).toHaveTextContent("Saisie effacée");
  });

  it("donne accès à l'historique d'une cellule et à celui du jour", async () => {
    setup();
    loginAs("supply");
    const { user } = renderApp(route("stocks"));
    await screen.findByRole("table", { name: "Stock disponible par dépôt et par produit" });

    await user.click(screen.getByRole("button", { name: "Historique — SCDP-DLA — Gasoil" }));
    let dialog = await screen.findByRole("dialog", { name: "Historique des saisies — SCDP-DLA · Gasoil" });
    await waitFor(() => expect(within(dialog).getAllByRole("row")).toHaveLength(3));
    const [, latest, previous] = within(dialog).getAllByRole("row");
    expect(latest).toHaveTextContent("12/01/2027 06:10");
    expect(latest).toHaveTextContent(/120\s000\sL/);
    expect(latest).toHaveTextContent("Valeur courante");
    expect(previous).toHaveTextContent(/110\s000\sL/);
    expect(previous).not.toHaveTextContent("Valeur courante");
    await user.click(within(dialog).getAllByRole("button", { name: "Fermer" })[0]);

    await user.click(screen.getByRole("button", { name: "Historique du jour" }));
    dialog = await screen.findByRole("dialog", { name: "Historique des saisies du jour" });
    await waitFor(() => expect(within(dialog).getAllByRole("row")).toHaveLength(3));
  });

  it("conserve une saisie en cours quand on change d'onglet", async () => {
    setup();
    loginAs("admin");
    const { user } = renderApp(route("stocks"));
    await screen.findByRole("table", { name: "Stock disponible par dépôt et par produit" });
    await user.type(cell("SCDP-YDE — Super"), "30000");
    await user.click(screen.getByRole("tab", { name: "Camions" }));
    await loadedGrid("Camions du jour", 5);
    await user.click(screen.getByRole("tab", { name: "Stocks dépôt" }));
    expect(shown("SCDP-YDE — Super")).toBe("30 000");
    expect(screen.getByText("1 modification non enregistrée")).toBeInTheDocument();
  });

  it("est en lecture seule pour le dispatcher", async () => {
    setup();
    loginAs("dispatcher");
    renderApp(route("stocks"));
    const grid = await screen.findByRole("table", { name: "Stock disponible par dépôt et par produit" });
    expect(screen.getByText(/saisie des stocks dépôt est réservée à l'agent Supply/)).toBeInTheDocument();
    expect(within(grid).queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByTestId("stock-dep-dla:prod-gasoil")).toHaveTextContent(/120\s000\sL/);
    expect(screen.queryByRole("button", { name: /Enregistrer/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Historique du jour" })).toBeInTheDocument();
  });
});

describe("Disponibilité — camions", () => {
  it("affiche l'affectabilité avec le motif RM-04 et marque / démarque un camion avec motif", async () => {
    const { state } = setup();
    loginAs("dispatcher");
    const { user } = renderApp(route("trucks"));
    const table = await loadedGrid("Camions du jour", 5);
    expect(screen.getByTestId("trucks-summary")).toHaveTextContent("3 / 5 affectables");
    expect(screen.getByText("2 camions non affectables ce jour (RM-04)")).toBeInTheDocument();
    expect(rowOf(table, "LT-456-CD")).toHaveTextContent("RM-04");
    expect(rowOf(table, "LT-456-CD")).toHaveTextContent("Camion en maintenance.");
    expect(rowOf(table, "LT-777-ZZ")).toHaveTextContent("Camion en panne.");
    expect(rowOf(table, "LT-401-AA")).toHaveTextContent("Roger Abega");
    expect(rowOf(table, "LT-401-AA")).toHaveTextContent("Affectable");

    await openActions(user, rowOf(table, "LT-401-AA"), "Marquer indisponible…");
    const dialog = await screen.findByRole("dialog", { name: "Marquer indisponible pour la journée" });
    expect(dialog).toHaveTextContent("LT-401-AA");
    await user.type(within(dialog).getByLabelText(/^Motif du jour/), "Contrôle technique");
    await user.click(within(dialog).getByRole("button", { name: "Marquer indisponible" }));
    await waitFor(() => expect(rowOf(table, "LT-401-AA")).toHaveTextContent("RM-04"));
    expect(state.truckPuts).toEqual([[{ truck_id: "t1", available: false, reason: "Contrôle technique" }]]);
    expect(rowOf(table, "LT-401-AA")).toHaveTextContent("Indisponible");
    expect(rowOf(table, "LT-401-AA")).toHaveTextContent(
      /marqué indisponible pour la journée : Contrôle technique/,
    );
    expect(screen.getByTestId("trucks-summary")).toHaveTextContent("2 / 5 affectables");

    await openActions(user, rowOf(table, "LT-401-AA"), "Rendre disponible");
    await waitFor(() => expect(rowOf(table, "LT-401-AA")).toHaveTextContent("Affectable"));
    expect(state.truckPuts.at(-1)).toEqual([{ truck_id: "t1", available: true, reason: null }]);
  });

  it("se saisit au clavier dans le tableau et en masse sur une sélection", async () => {
    const { state } = setup();
    loginAs("dispatcher");
    const { user } = renderApp(route("trucks"));
    const table = await loadedGrid("Camions du jour", 5);

    // Entrée sur la cellule « Ce jour » ouvre le choix ; Entrée valide.
    const dayCell = within(rowOf(table, "LT-402-AB")).getAllByRole("gridcell")[3];
    await user.click(dayCell);
    await user.keyboard("{Enter}");
    await user.selectOptions(within(dayCell).getByRole("combobox"), "false");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(state.truckPuts).toEqual([[{ truck_id: "t2", available: false, reason: null }]]),
    );
    await waitFor(() => expect(rowOf(table, "LT-402-AB")).toHaveTextContent("RM-04"));

    // Sélection de deux camions : un seul motif pour tous.
    await user.click(within(rowOf(table, "LT-401-AA")).getByRole("checkbox"));
    await user.click(within(rowOf(table, "LT-403-AC")).getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Marquer indisponibles…" }));
    const dialog = await screen.findByRole("dialog", { name: "Marquer indisponible pour la journée" });
    expect(dialog).toHaveTextContent("LT-401-AA, LT-403-AC");
    await user.type(within(dialog).getByLabelText(/^Motif du jour/), "Réquisition");
    await user.click(within(dialog).getByRole("button", { name: "Marquer indisponible" }));
    await waitFor(() =>
      expect(state.truckPuts.at(-1)).toEqual([
        { truck_id: "t1", available: false, reason: "Réquisition" },
        { truck_id: "t3", available: false, reason: "Réquisition" },
      ]),
    );
    await waitFor(() => expect(screen.getByTestId("trucks-summary")).toHaveTextContent("0 / 5 affectables"));
  });

  it("est en lecture seule pour l'agent Supply", async () => {
    setup();
    loginAs("supply");
    renderApp(route("trucks"));
    const table = await loadedGrid("Camions du jour", 5);
    expect(screen.getByText(/gérée par le dispatcher/)).toBeInTheDocument();
    expect(within(table).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(table).queryByRole("button", { name: /^Actions/ })).not.toBeInTheDocument();
    expect(table.querySelector("[data-editable]")).toBeNull();
  });
});

describe("Disponibilité — chauffeurs", () => {
  it("met en évidence le blocage RM-03 avec son message", async () => {
    setup();
    loginAs("dispatcher");
    const { user } = renderApp(route("drivers"));
    const table = await loadedGrid("Chauffeurs du jour", 6);
    expect(screen.getByTestId("drivers-summary")).toHaveTextContent("3 / 6 affectables");

    const notice = screen.getByText(/2 chauffeurs bloqués : permis ou habilitation expirés \(RM-03\)/);
    expect(notice.closest('[role="alert"]')).toHaveTextContent("Samuel Etoga");
    expect(notice.closest('[role="alert"]')).toHaveTextContent("Blaise Nkono");

    const samuel = rowOf(table, "Samuel Etoga");
    expect(samuel.className).toContain("bg-blocking-soft");
    expect(samuel.querySelector('[data-rule="RM-03"]')).toHaveTextContent(
      "RM-03Permis de conduire expiré depuis le 31/12/2026.",
    );
    expect(samuel).toHaveTextContent("Expiré le 31/12/2026");
    expect(rowOf(table, "Blaise Nkono")).toHaveTextContent(
      "Habilitation matières dangereuses expirée depuis le 05/01/2027.",
    );
    // Un chauffeur en congé est non affectable sans être en infraction.
    const aline = rowOf(table, "Aline Fotso");
    expect(aline.className).not.toContain("bg-blocking-soft");
    expect(aline).toHaveTextContent("Non affectable");
    expect(rowOf(table, "Yves Mbarga")).toHaveTextContent("Aucun camion");

    await user.selectOptions(screen.getByRole("combobox", { name: "Affectabilité" }), "false");
    await waitFor(() => expect(dataRows(table)).toHaveLength(3));
  });

  it("marque un chauffeur indisponible pour la journée, puis modifie le motif", async () => {
    const { state } = setup();
    loginAs("dispatcher");
    const { user } = renderApp(route("drivers"));
    const table = await loadedGrid("Chauffeurs du jour", 6);

    await openActions(user, rowOf(table, "Yves Mbarga"), "Marquer indisponible…");
    let dialog = await screen.findByRole("dialog", { name: "Marquer indisponible pour la journée" });
    await user.click(within(dialog).getByRole("button", { name: "Marquer indisponible" }));
    await waitFor(() => expect(rowOf(table, "Yves Mbarga")).toHaveTextContent("Indisponible"));
    expect(state.driverPuts).toEqual([[{ driver_id: "d3", available: false, reason: null }]]);

    await openActions(user, rowOf(table, "Yves Mbarga"), "Modifier le motif…");
    dialog = await screen.findByRole("dialog", { name: "Marquer indisponible pour la journée" });
    await user.type(within(dialog).getByLabelText(/^Motif du jour/), "Visite médicale");
    await user.click(within(dialog).getByRole("button", { name: "Marquer indisponible" }));
    await waitFor(() => expect(rowOf(table, "Yves Mbarga")).toHaveTextContent("Visite médicale"));
    expect(state.driverPuts.at(-1)).toEqual([
      { driver_id: "d3", available: false, reason: "Visite médicale" },
    ]);
  });

  it("modifie l'affectation chauffeur ↔ camion du jour et résout le conflit 409", async () => {
    const { state } = setup();
    loginAs("dispatcher");
    const { user } = renderApp(route("drivers"));
    const table = await loadedGrid("Chauffeurs du jour", 6);
    expect(rowOf(table, "Roger Abega")).toHaveTextContent("LT-401-AAhabituel");

    const assign = async (driver: string, truckId: string) => {
      const truckCell = within(rowOf(table, driver)).getAllByRole("gridcell")[3];
      await user.click(truckCell);
      await user.keyboard("{Enter}");
      await user.selectOptions(within(truckCell).getByRole("combobox"), truckId);
      await user.keyboard("{Enter}");
    };

    // Yves prend LT-403-AC pour la journée.
    await assign("Yves Mbarga", "t3");
    expect(await screen.findByText("LT-403-AC affecté à Yves Mbarga pour la journée")).toBeInTheDocument();
    expect(state.driverPuts).toEqual([[{ driver_id: "d3", truck_id: "t3" }]]);
    await waitFor(() => expect(rowOf(table, "Yves Mbarga")).toHaveTextContent("LT-403-ACjour"));

    // Roger demande le même camion : conflit expliqué, rien ne change si on renonce.
    await assign("Roger Abega", "t3");
    let dialog = await screen.findByRole("alertdialog", { name: "Camion déjà affecté" });
    expect(dialog).toHaveTextContent(
      "Le camion LT-403-AC est déjà affecté à Yves Mbarga pour cette journée.",
    );
    expect(dialog).toHaveTextContent(/L'affectation du jour de Yves Mbarga sera retirée/);
    await user.click(within(dialog).getByRole("button", { name: "Ne rien changer" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(state.driverPuts).toHaveLength(2);
    expect(state.daily).toEqual({ d3: "t3" });
    expect(rowOf(table, "Roger Abega")).toHaveTextContent("LT-401-AAhabituel");

    // Nouvelle tentative, réaffectation confirmée : les deux lignes partent dans la même saisie.
    await assign("Roger Abega", "t3");
    dialog = await screen.findByRole("alertdialog", { name: "Camion déjà affecté" });
    await user.click(within(dialog).getByRole("button", { name: "Réaffecter le camion" }));
    await waitFor(() =>
      expect(state.driverPuts.at(-1)).toEqual([
        { driver_id: "d3", truck_id: null },
        { driver_id: "d1", truck_id: "t3" },
      ]),
    );
    await waitFor(() => expect(rowOf(table, "Roger Abega")).toHaveTextContent("LT-403-ACjour"));
    expect(rowOf(table, "Yves Mbarga")).toHaveTextContent("Aucun camion");
    expect(state.daily).toEqual({ d1: "t3" });

    // Retour au camion habituel.
    await openActions(user, rowOf(table, "Roger Abega"), "Retirer l'affectation du jour");
    await waitFor(() => expect(rowOf(table, "Roger Abega")).toHaveTextContent("LT-401-AAhabituel"));
    expect(state.driverPuts.at(-1)).toEqual([{ driver_id: "d1", truck_id: null }]);
  });

  it("relaie le refus RM-04 d'une affectation sur un camion non affectable", async () => {
    const { state } = setup();
    loginAs("dispatcher");
    const { user } = renderApp(route("drivers"));
    const table = await loadedGrid("Chauffeurs du jour", 6);
    const truckCell = within(rowOf(table, "Yves Mbarga")).getAllByRole("gridcell")[3];
    await user.click(truckCell);
    await user.keyboard("{Enter}");
    await user.selectOptions(within(truckCell).getByRole("combobox"), "t5");
    await user.keyboard("{Enter}");
    expect(
      await screen.findByText("Le camion LT-777-ZZ n'est pas affectable : Camion en panne. (RM-04)"),
    ).toBeInTheDocument();
    expect(state.daily).toEqual({});
    await user.keyboard("{Escape}");
    expect(rowOf(table, "Yves Mbarga")).toHaveTextContent("Aucun camion");
  });

  it("est en lecture seule pour la direction, sur les trois onglets", async () => {
    setup();
    loginAs("manager");
    const { user } = renderApp(route("drivers"));
    const table = await loadedGrid("Chauffeurs du jour", 6);
    expect(
      screen.getByText(/votre rôle ne permet pas de modifier la disponibilité du jour/),
    ).toBeInTheDocument();
    expect(within(table).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(table).queryByRole("button", { name: /^Actions/ })).not.toBeInTheDocument();
    expect(table.querySelector("[data-editable]")).toBeNull();
    expect(rowOf(table, "Samuel Etoga")).toHaveTextContent("RM-03");
    await user.click(screen.getByRole("tab", { name: "Stocks dépôt" }));
    // Limité au contenu de l'onglet : le sélecteur de jour de la coquille est lui-même un champ de saisie.
    const panel = screen.getByRole("tabpanel", { name: "Stocks dépôt" });
    expect(within(panel).queryByRole("textbox")).not.toBeInTheDocument();
  });
});

describe("Disponibilité — onglet par défaut", () => {
  it("ouvre les stocks pour l'agent Supply et les camions pour le dispatcher", async () => {
    setup();
    loginAs("supply");
    const first = renderApp(`/disponibilite?day=${MOCK_DAY}`);
    expect(await screen.findByRole("tab", { name: "Stocks dépôt" })).toHaveAttribute("aria-selected", "true");
    first.unmount();
    loginAs("dispatcher");
    renderApp(`/disponibilite?day=${MOCK_DAY}`);
    expect(await screen.findByRole("tab", { name: "Camions" })).toHaveAttribute("aria-selected", "true");
  });
});
