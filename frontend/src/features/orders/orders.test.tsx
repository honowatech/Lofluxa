import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { db } from "@/mocks/db";
import { server } from "@/mocks/server";
import { loginAs, renderApp } from "@/test/utils";

import { createOrdersMocks, MOCK_DAY } from "./mocks";

const ROUTE = `/commandes?day=${MOCK_DAY}`;

function setup() {
  const mocks = createOrdersMocks();
  server.use(...mocks.handlers);
  return mocks;
}

const dataRows = (table: HTMLElement) => within(table).getAllByRole("row").slice(1);
async function loadedGrid(count: number) {
  const table = await screen.findByRole("grid", { name: "Commandes du jour" });
  await waitFor(() => expect(dataRows(table)).toHaveLength(count));
  return table;
}
const rowOf = (table: HTMLElement, ...texts: string[]) =>
  dataRows(table).find((row) => texts.every((text) => row.textContent?.includes(text))) as HTMLElement;
const openActions = async (user: ReturnType<typeof renderApp>["user"], row: HTMLElement, item: string) => {
  await user.click(within(row).getByRole("button", { name: /^Actions/ }));
  await user.click(await screen.findByRole("menuitem", { name: item }));
};

describe("Commandes du jour — tableau", () => {
  it("liste les commandes du jour avec les totaux par produit et par statut", async () => {
    const { state } = setup();
    loginAs("dispatcher");
    renderApp(ROUTE);
    const table = await loadedGrid(6);
    expect(state.listQueries[0]).toContain(`day=${MOCK_DAY}`);
    // Tri par station : les deux commandes d'Akwa d'abord.
    expect(dataRows(table)[0]).toHaveTextContent("DLA-001");
    expect(dataRows(table)[0]).toHaveTextContent("08:00");
    expect(rowOf(table, "OLA Akwa Boulevard", "Gasoil")).toHaveTextContent("Urgente");
    expect(rowOf(table, "OLA Bonanjo")).toHaveTextContent("Livrer avant midi");

    expect(screen.getByTestId("total-product-SUPER")).toHaveTextContent(/26\s000\sL\(3\)/);
    expect(screen.getByTestId("total-product-GASOIL")).toHaveTextContent(/24\s000\sL\(2\)/);
    expect(screen.getByTestId("total-product-PETROLE")).toHaveTextContent(/4\s000\sL\(1\)/);
    expect(screen.getByTestId("total-status-draft")).toHaveTextContent(/29\s000\sL\(3\)/);
    expect(screen.getByTestId("total-status-confirmed")).toHaveTextContent(/15\s000\sL\(1\)/);
    expect(screen.getByTestId("total-all")).toHaveTextContent(/54\s000\sL\(6 commandes\)/);
  });

  it("envoie les filtres station, produit, statut et priorité au serveur", async () => {
    const { state } = setup();
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    const table = await loadedGrid(6);

    await user.selectOptions(screen.getByRole("combobox", { name: "Statut" }), "draft");
    await waitFor(() => expect(dataRows(table)).toHaveLength(3));
    expect(state.listQueries.at(-1)).toContain("status=draft");
    expect(screen.getByTestId("total-all")).toHaveTextContent("3 commandes");

    await user.selectOptions(screen.getByRole("combobox", { name: "Produit" }), db.products[0].id);
    await waitFor(() => expect(dataRows(table)).toHaveLength(2));
    expect(state.listQueries.at(-1)).toContain(`product_id=${db.products[0].id}`);

    await user.selectOptions(screen.getByRole("combobox", { name: "Station" }), db.stations[3].id);
    await waitFor(() => expect(dataRows(table)).toHaveLength(1));
    expect(dataRows(table)[0]).toHaveTextContent("OLA Deido");

    await user.click(screen.getByRole("button", { name: "Effacer les filtres" }));
    await waitFor(() => expect(dataRows(table)).toHaveLength(6));
    await user.selectOptions(screen.getByRole("combobox", { name: "Priorité" }), "urgent");
    await waitFor(() => expect(dataRows(table)).toHaveLength(1));
    expect(state.listQueries.at(-1)).toContain("priority=urgent");
  });

  it("applique le filtre de statut transmis par l'écran Journée", async () => {
    const { state } = setup();
    loginAs("dispatcher");
    renderApp(`${ROUTE}&status=draft`);
    await loadedGrid(3);
    expect(screen.getByRole("combobox", { name: "Statut" })).toHaveValue("draft");
    expect(state.listQueries[0]).toContain("status=draft");
  });

  it("se modifie au clavier : volume, fenêtre, validation et annulation", async () => {
    const { state } = setup();
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    const table = await loadedGrid(6);

    // Saisie directe sur la cellule : le premier caractère remplace la valeur, Entrée valide.
    await user.click(within(table).getByRole("gridcell", { name: /^9\s000\sL$/ }));
    await user.keyboard("11000{Enter}");
    await waitFor(() => expect(state.patches).toEqual([{ id: "order-3", body: { requested_l: 11000 } }]));
    expect(await within(table).findByRole("gridcell", { name: /^11\s000\sL$/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("total-product-GASOIL")).toHaveTextContent(/26\s000\sL/));

    // Fenêtre : saisie tolérante (`630` → 06:30), heure invalide refusée, Échap annule.
    const row = rowOf(table, "OLA Bonanjo");
    const windowStart = within(row).getAllByRole("gridcell")[5];
    await user.click(windowStart);
    await user.keyboard("99{Enter}");
    expect(await within(row).findByRole("alert")).toHaveTextContent("Heure invalide (HH:mm)");
    await user.keyboard("{Escape}");
    expect(state.patches).toHaveLength(1);
    await user.click(windowStart);
    await user.keyboard("630{Enter}");
    await waitFor(() =>
      expect(state.patches.at(-1)).toEqual({ id: "order-3", body: { window_start: "06:30" } }),
    );
    expect(await within(row).findByText("06:30")).toBeInTheDocument();

    // Un volume nul est refusé avant tout envoi.
    await user.click(within(table).getByRole("gridcell", { name: /^11\s000\sL$/ }));
    await user.keyboard("0{Enter}");
    expect(await within(row).findByRole("alert")).toHaveTextContent("Le volume doit être supérieur à 0");
    await user.keyboard("{Escape}");

    // Une commande planifiée n'est plus modifiable.
    const planned = rowOf(table, "OLA Bonapriso");
    expect(within(planned).getAllByRole("gridcell")[3]).not.toHaveAttribute("data-editable");
    expect(within(row).getAllByRole("gridcell")[3]).toHaveAttribute("data-editable");
    expect(state.patches).toHaveLength(2);
  });
});

describe("Commandes du jour — saisie", () => {
  it("crée une commande en brouillon, avec validation et rappel de la cuve", async () => {
    const { state } = setup();
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    const table = await loadedGrid(6);

    await user.click(screen.getByRole("button", { name: "Nouvelle commande" }));
    const dialog = await screen.findByRole("dialog", { name: "Nouvelle commande" });
    await user.click(within(dialog).getByRole("button", { name: "Enregistrer" }));
    expect(await within(dialog).findAllByText("Champ obligatoire")).toHaveLength(3);

    await user.selectOptions(within(dialog).getByLabelText(/^Station/), db.stations[1].id);
    await user.selectOptions(within(dialog).getByLabelText(/^Produit/), db.products[2].id);
    // Bonanjo n'a pas de cuve de pétrole : l'écran prévient que le volume ne sera pas contrôlé.
    expect(within(dialog).getByTestId("tank-hint")).toHaveTextContent(/Cuve non renseignée/);
    await user.selectOptions(within(dialog).getByLabelText(/^Produit/), db.products[0].id);
    expect(within(dialog).getByTestId("tank-hint")).toHaveTextContent(
      /Cuve de la station : 35\s000\sL, stock de sécurité 3\s000\sL\./,
    );
    await user.type(within(dialog).getByLabelText(/^Volume demandé/), "7000");
    await user.selectOptions(within(dialog).getByLabelText(/^Priorité/), "urgent");
    await user.type(within(dialog).getByLabelText(/^Au plus tôt/), "14");
    await user.type(within(dialog).getByLabelText(/^Au plus tard/), "9h30");
    await user.type(within(dialog).getByLabelText(/^Commentaire/), "Accès par l'arrière");
    await user.click(within(dialog).getByRole("button", { name: "Enregistrer" }));

    // Refus 422 du serveur reporté sur le champ, la boîte reste ouverte.
    expect(await within(dialog).findAllByText(/doit précéder la fin/)).not.toHaveLength(0);
    await user.clear(within(dialog).getByLabelText(/^Au plus tôt/));
    await user.type(within(dialog).getByLabelText(/^Au plus tôt/), "8");
    await user.click(within(dialog).getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(dataRows(table)).toHaveLength(7));
    expect(state.orders.at(-1)).toMatchObject({
      day: MOCK_DAY,
      station_id: db.stations[1].id,
      product_id: db.products[0].id,
      requested_l: 7000,
      priority: "urgent",
      window_start: "08:00",
      window_end: "09:30",
      comment: "Accès par l'arrière",
      status: "draft",
    });
    expect(rowOf(table, "OLA Bonanjo", "Super")).toHaveTextContent("Brouillon");
  });

  it("ouvre l'import des commandes du jour", async () => {
    setup();
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    await loadedGrid(6);
    await user.click(screen.getByRole("button", { name: "Importer" }));
    expect(await screen.findByRole("dialog", { name: "Importer — commandes" })).toBeInTheDocument();
  });
});

describe("Commandes du jour — confirmation, annulation, report, suppression", () => {
  it("confirme en masse et donne le résultat commande par commande", async () => {
    const { state } = setup();
    state.orders[5].requested_l = 99000; // Deido, super : dépasse la cuve
    state.orders[4].status = "draft"; // Deido, pétrole : pas de cuve connue → avertissement
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    const table = await loadedGrid(6);

    await user.click(screen.getByRole("checkbox", { name: "Sélectionner toutes les lignes de la page" }));
    await user.click(screen.getByRole("button", { name: "Confirmer" }));

    const report = await screen.findByTestId("bulk-confirm-report");
    // Seuls les brouillons partent au serveur ; les autres lignes de la sélection sont signalées.
    expect(state.bulkConfirms).toEqual([["order-1", "order-3", "order-5", "order-6"]]);
    expect(report).toHaveTextContent("3 commandes confirmées, 1 refusée.");
    expect(report).toHaveTextContent("2 commandes ignorées (déjà confirmées ou traitées).");
    const lines = within(report).getAllByRole("row").slice(1);
    expect(lines).toHaveLength(4);
    const refused = lines.find((line) => line.getAttribute("data-ok") === "false") as HTMLElement;
    expect(refused).toHaveTextContent("OLA Deido · Super sans plomb");
    expect(refused).toHaveTextContent("Refusée");
    expect(refused).toHaveTextContent(/supérieur au volume recevable par la cuve \(27\s000 L/);
    expect(within(report).getByText("Confirmée, avec avertissement").closest("tr")).toHaveTextContent(
      /Cuve non renseignée/,
    );
    await user.click(within(report).getAllByRole("button", { name: "Fermer" })[0]);

    await waitFor(() => expect(within(table).getAllByText("Confirmée")).toHaveLength(4));
    expect(rowOf(table, "OLA Deido", "Super")).toHaveTextContent("Brouillon");
    // Avertissement F3.4 conservé à l'écran : icône sur la ligne et bandeau.
    expect(within(rowOf(table, "OLA Deido", "Pétrole")).getByTestId("order-warning")).toHaveAccessibleName(
      /Cuve non renseignée/,
    );
    expect(screen.getByText(/1 commande avec avertissement : cuve non renseignée/)).toBeInTheDocument();
  });

  it("signale dès le brouillon un volume que la cuve ne peut pas recevoir", async () => {
    const { state } = setup();
    state.orders[5].requested_l = 99000; // Deido, super : dépasse la cuve
    loginAs("dispatcher");
    renderApp(ROUTE);
    const table = await loadedGrid(6);
    // L'avertissement vient du serveur à la lecture, avant toute tentative de confirmation.
    const mark = within(rowOf(table, "OLA Deido", "Super")).getByTestId("order-warning");
    expect(mark).toHaveAttribute("data-code", "exceeds_tank_capacity");
    expect(mark).toHaveAccessibleName(
      /Confirmation impossible : Volume demandé .* supérieur au volume recevable/,
    );
    expect(
      screen
        .getByText(/1 commande dépasse le volume recevable par la cuve de sa station/)
        .closest('[role="alert"]'),
    ).toBeInTheDocument();
    expect(within(rowOf(table, "OLA Bonanjo")).queryByTestId("order-warning")).not.toBeInTheDocument();
    expect(state.bulkConfirms).toHaveLength(0);
  });

  it("confirme tous les brouillons affichés après confirmation", async () => {
    const { state } = setup();
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    const table = await loadedGrid(6);
    await user.click(screen.getByRole("button", { name: "Confirmer les brouillons (3)" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("3 brouillons affichés seront confirmés");
    await user.click(within(dialog).getByRole("button", { name: "Confirmer" }));
    await waitFor(() => expect(within(table).getAllByText("Confirmée")).toHaveLength(4));
    expect(state.bulkConfirms).toEqual([["order-1", "order-3", "order-6"]]);
    expect(screen.queryByRole("button", { name: /Confirmer les brouillons/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId("bulk-confirm-report")).not.toBeInTheDocument();
  });

  it("explique le refus d'une confirmation dont le volume dépasse la cuve", async () => {
    const { state } = setup();
    state.orders[5].requested_l = 99000;
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    const table = await loadedGrid(6);

    await openActions(user, rowOf(table, "OLA Deido", "Super"), "Confirmer");
    const banner = (await screen.findByText(/Confirmation refusée/)).closest('[role="alert"]') as HTMLElement;
    expect(banner).toHaveTextContent("OLA Deido · Super sans plomb");
    expect(banner).toHaveTextContent(/supérieur au volume recevable par la cuve/);
    expect(banner).toHaveTextContent(/Volume maximal recevable : 27\s000\sL\./);
    expect(rowOf(table, "OLA Deido", "Super")).toHaveTextContent("Brouillon");

    // Correction depuis le bandeau, puis nouvelle confirmation : le bandeau disparaît.
    await user.click(within(banner).getByRole("button", { name: "Corriger la commande" }));
    const dialog = await screen.findByRole("dialog", { name: "Modifier la commande" });
    const volume = within(dialog).getByLabelText(/^Volume demandé/);
    await user.clear(volume);
    await user.type(volume, "20000");
    await user.click(within(dialog).getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(rowOf(table, "OLA Deido", "Super")).toHaveTextContent(/20\s000\sL/));
    await openActions(user, rowOf(table, "OLA Deido", "Super"), "Confirmer");
    await waitFor(() => expect(rowOf(table, "OLA Deido", "Super")).toHaveTextContent("Confirmée"));
    expect(screen.queryByText(/Confirmation refusée/)).not.toBeInTheDocument();
  });

  it("refuse et explique une modification de volume hors cuve sur une commande confirmée", async () => {
    setup();
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    const table = await loadedGrid(6);
    await user.click(within(table).getByRole("gridcell", { name: /^15\s000\sL$/ }));
    await user.keyboard("80000{Enter}");
    const banner = (await screen.findByText(/Modification refusée/)).closest('[role="alert"]') as HTMLElement;
    expect(banner).toHaveTextContent(/Volume maximal recevable : 36\s000\sL\./);
    await user.keyboard("{Escape}");
    expect(rowOf(table, "OLA Akwa Boulevard", "Gasoil")).toHaveTextContent(/15\s000\sL/);
  });

  it("n'annule et ne reporte une commande qu'après confirmation", async () => {
    const { state } = setup();
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    const table = await loadedGrid(6);

    await openActions(user, rowOf(table, "OLA Bonanjo"), "Annuler la commande");
    let dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/passera au statut « Annulée »/);
    await user.click(within(dialog).getByRole("button", { name: "Ne rien changer" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(state.orders[2].status).toBe("draft");

    await openActions(user, rowOf(table, "OLA Bonanjo"), "Annuler la commande");
    dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Annuler la commande" }));
    await waitFor(() => expect(rowOf(table, "OLA Bonanjo")).toHaveTextContent("Annulée"));

    await openActions(user, rowOf(table, "OLA Akwa Boulevard", "Gasoil"), "Reporter");
    dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Reporter" }));
    await waitFor(() => expect(rowOf(table, "OLA Akwa Boulevard", "Gasoil")).toHaveTextContent("Reportée"));
    // Une commande annulée n'offre plus que la consultation.
    await user.click(within(rowOf(table, "OLA Bonanjo")).getByRole("button", { name: /^Actions/ }));
    expect(await screen.findByRole("menuitem", { name: "Détails" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Annuler la commande" })).not.toBeInTheDocument();
  });

  it("supprime les brouillons, à l'unité ou en masse, après confirmation", async () => {
    const { state } = setup();
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    const table = await loadedGrid(6);

    await openActions(user, rowOf(table, "OLA Bonanjo"), "Supprimer");
    let dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/OLA Bonanjo · Gasoil ·/);
    await user.click(within(dialog).getByRole("button", { name: "Supprimer" }));
    await waitFor(() => expect(dataRows(table)).toHaveLength(5));

    // Sélection de toute la page : seuls les brouillons sont supprimés, les autres sont ignorés.
    await user.click(screen.getByRole("checkbox", { name: "Sélectionner toutes les lignes de la page" }));
    await user.click(screen.getByRole("button", { name: "Supprimer les brouillons" }));
    dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("2 brouillons seront supprimés définitivement.");
    expect(dialog).toHaveTextContent("3 commandes déjà confirmées ou traitées sont ignorées.");
    await user.click(within(dialog).getByRole("button", { name: "Supprimer" }));
    await waitFor(() => expect(dataRows(table)).toHaveLength(3));
    expect(state.orders.filter((order) => order.day === MOCK_DAY).map((order) => order.status)).toEqual([
      "confirmed",
      "planned",
      "cancelled",
    ]);
  });
});

describe("Commandes du jour — lecture seule", () => {
  it("ne propose aucune écriture à la direction", async () => {
    const { state } = setup();
    loginAs("manager");
    const { user } = renderApp(ROUTE);
    const table = await loadedGrid(6);
    expect(screen.getByText(/Lecture seule/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Nouvelle commande" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Importer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirmer les brouillons/ })).not.toBeInTheDocument();
    expect(within(table).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(table.querySelector("[data-editable]")).toBeNull();

    await user.click(within(table).getByRole("gridcell", { name: /^9\s000\sL$/ }));
    await user.keyboard("5{Enter}");
    // Entrée ouvre la fiche en consultation : aucun champ modifiable, aucun enregistrement.
    const dialog = await screen.findByRole("dialog", { name: "Commande" });
    expect(within(dialog).getByLabelText(/^Volume demandé/)).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "Enregistrer" })).not.toBeInTheDocument();
    expect(state.patches).toHaveLength(0);
    await user.click(within(dialog).getAllByRole("button", { name: "Fermer" })[0]);
    await user.click(within(rowOf(table, "OLA Bonanjo")).getByRole("button", { name: /^Actions/ }));
    expect(await screen.findByRole("menuitem", { name: "Détails" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Confirmer" })).not.toBeInTheDocument();
  });
});
