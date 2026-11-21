import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { addDays, todayLocal } from "@/lib/format";
import type { Driver } from "@/lib/types";
import { db } from "@/mocks/db";
import { loginAs, renderApp } from "@/test/utils";

import { driverAlerts, driverDocumentIssues } from "./driverAlerts";

const grid = (name: string) => screen.findByRole("grid", { name });
const rowOf = (text: string) => screen.getByText(text).closest("tr") as HTMLElement;
const dataRows = (table: HTMLElement) => within(table).getAllByRole("row").slice(1);

describe("Référentiels — stations", () => {
  it("liste paginée côté serveur, triée par code, avec la carte des stations de la page", async () => {
    loginAs("admin");
    renderApp("/referentiels");
    const table = await grid("Stations");
    await waitFor(() => expect(dataRows(table)).toHaveLength(30));
    expect(within(dataRows(table)[0]).getByText("DLA-001")).toBeInTheDocument();
    expect(screen.getByText("1–30 sur 30")).toBeInTheDocument();
    expect(within(dataRows(table)[0]).getByText(/SUPER/)).toBeInTheDocument();
    // Carte (repli schématique sous jsdom) : un marqueur par station, les inactives en retrait.
    const map = screen.getByRole("figure", { name: "Stations" });
    expect(map.querySelectorAll('[data-kind="station"]')).toHaveLength(30);
    expect(map.querySelectorAll('[opacity="0.45"]')).toHaveLength(1);
  });

  it("recherche et filtre envoyés au serveur", async () => {
    loginAs("admin");
    const { user } = renderApp("/referentiels?tab=stations");
    const table = await grid("Stations");
    await waitFor(() => expect(dataRows(table)).toHaveLength(30));
    await user.type(screen.getByRole("searchbox"), "bona");
    await waitFor(() =>
      expect(dataRows(table).map((row) => within(row).getAllByRole("gridcell")[2].textContent)).toEqual([
        "OLA Bonanjo",
        "OLA Bonapriso",
        "OLA Bonabéri Rond-Point",
        "OLA Bonamoussadi",
        "OLA Bonabéri Sodiko",
      ]),
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Gabarit max" }), "medium");
    await waitFor(() => expect(dataRows(table)).toHaveLength(1));
    expect(within(dataRows(table)[0]).getByText("OLA Bonapriso")).toBeInTheDocument();
    expect(screen.getByText("1–1 sur 1")).toBeInTheDocument();
  });

  it("création : validation, coordonnées, cuves, puis ligne visible", async () => {
    loginAs("admin");
    const { user } = renderApp("/referentiels?tab=stations");
    await grid("Stations");
    await user.click(screen.getByRole("button", { name: "Nouvelle station" }));
    const dialog = await screen.findByRole("dialog", { name: "Nouvelle station" });

    await user.click(within(dialog).getByRole("button", { name: "Enregistrer" }));
    expect(await within(dialog).findAllByText("Champ obligatoire")).toHaveLength(4);

    await user.type(within(dialog).getByLabelText(/^Code/), "dla-099");
    await user.type(within(dialog).getAllByLabelText(/^Nom\b/)[0], "OLA Test Bassa");
    await user.type(within(dialog).getByLabelText(/^Ville/), "Douala");
    await user.type(within(dialog).getByLabelText(/^Latitude/), "4,0401");
    await user.type(within(dialog).getByLabelText(/^Longitude/), "9,7502");
    await user.selectOptions(within(dialog).getByLabelText(/^Gabarit max accepté/), "medium");

    await user.click(within(dialog).getByRole("button", { name: "Ajouter une cuve" }));
    await user.click(within(dialog).getByRole("button", { name: "Ajouter une cuve" }));
    const tank1 = within(dialog).getByRole("group", { name: "Cuves 1" });
    const tank2 = within(dialog).getByRole("group", { name: "Cuves 2" });
    await user.type(within(tank1).getByLabelText("Capacité"), "30000");
    await user.clear(within(tank1).getByLabelText("Stock de sécurité"));
    await user.type(within(tank1).getByLabelText("Stock de sécurité"), "40000");
    await user.type(within(tank2).getByLabelText("Capacité"), "20000");
    await user.click(within(dialog).getByRole("button", { name: "Enregistrer" }));
    expect(await within(tank1).findByText("Le stock de sécurité dépasse la capacité")).toBeInTheDocument();
    expect(db.stations.some((station) => station.code === "DLA-099")).toBe(false);

    await user.clear(within(tank1).getByLabelText("Stock de sécurité"));
    await user.type(within(tank1).getByLabelText("Stock de sécurité"), "3000");
    await user.click(within(dialog).getByRole("button", { name: "Enregistrer" }));

    expect(await screen.findByText("« OLA Test Bassa » créé")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const created = db.stations.find((station) => station.code === "DLA-099");
    expect(created).toMatchObject({
      name: "OLA Test Bassa",
      city: "Douala",
      region: null,
      lat: 4.0401,
      lon: 9.7502,
      max_truck_size: "medium",
      unload_time_min: null,
      opening_hours: {},
      active: true,
    });
    expect(created?.tanks.map((tank) => [tank.capacity_l, tank.safety_stock_l])).toEqual([
      [30000, 3000],
      [20000, 0],
    ]);
    expect(new Set(created?.tanks.map((tank) => tank.product_id)).size).toBe(2);
    await waitFor(() => expect(screen.getByText("1–31 sur 31")).toBeInTheDocument());
  });

  it("modification au clavier : Entrée ouvre la fiche, cuve retirée et capacité modifiée, conflit de code signalé", async () => {
    loginAs("admin");
    const { user } = renderApp("/referentiels?tab=stations");
    const table = await grid("Stations");
    await waitFor(() => expect(dataRows(table)).toHaveLength(30));
    const before = db.stations.find((station) => station.code === "DLA-001");
    expect(before?.tanks).toHaveLength(3);

    within(dataRows(table)[0]).getAllByRole("gridcell")[1].focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Modifier la station" });
    expect(within(dialog).getByLabelText(/^Code/)).toHaveValue("DLA-001");

    await user.clear(within(dialog).getByLabelText(/^Code/));
    await user.type(within(dialog).getByLabelText(/^Code/), "DLA-002");
    await user.click(within(dialog).getByRole("button", { name: "Enregistrer" }));
    expect(await within(dialog).findByText("Station : « DLA-002 » existe déjà.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^Code/)).toHaveAccessibleDescription("Valeur déjà utilisée");

    await user.clear(within(dialog).getByLabelText(/^Code/));
    await user.type(within(dialog).getByLabelText(/^Code/), "DLA-001");
    await user.click(within(dialog).getByRole("button", { name: "Retirer la cuve 3" }));
    const capacity = within(within(dialog).getByRole("group", { name: "Cuves 1" })).getByLabelText(
      "Capacité",
    );
    await user.clear(capacity);
    await user.type(capacity, "45 000");
    await user.click(within(dialog).getByRole("button", { name: "Enregistrer" }));

    expect(await screen.findByText("« OLA Akwa Boulevard » mis à jour")).toBeInTheDocument();
    const after = db.stations.find((station) => station.code === "DLA-001");
    expect(after?.tanks.map((tank) => tank.capacity_l)).toEqual([45000, 40000]);
    expect(after?.tanks[0].id).toBe(before?.tanks[0].id);
  });

  it("suppression : jamais sans confirmation", async () => {
    loginAs("admin");
    const { user } = renderApp("/referentiels?tab=stations");
    const table = await grid("Stations");
    await waitFor(() => expect(dataRows(table)).toHaveLength(30));

    await user.click(screen.getByRole("button", { name: "Actions — OLA Bonanjo" }));
    await user.click(await screen.findByRole("menuitem", { name: "Supprimer" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Supprimer ?" });
    expect(confirm).toHaveTextContent("« OLA Bonanjo » sera supprimé");
    await user.click(within(confirm).getByRole("button", { name: "Annuler" }));
    expect(db.stations.find((station) => station.code === "DLA-002")?.deleted_at).toBeUndefined();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions — OLA Bonanjo" }));
    await user.click(await screen.findByRole("menuitem", { name: "Supprimer" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Supprimer" }),
    );
    expect(await screen.findByText("« OLA Bonanjo » supprimé")).toBeInTheDocument();
    expect(db.stations.find((station) => station.code === "DLA-002")?.deleted_at).toBeTruthy();
    await waitFor(() => expect(screen.getByText("1–29 sur 29")).toBeInTheDocument());
  });

  it("import depuis l'onglet : la liste est rafraîchie après application", async () => {
    loginAs("admin");
    const { user } = renderApp("/referentiels?tab=stations");
    await grid("Stations");
    await user.click(screen.getByRole("button", { name: "Importer" }));
    await user.upload(
      screen.getByLabelText("Choisir un fichier"),
      new File(["code;name;lat;lon\nDLA-077;OLA Importée;4,02;9,72"], "stations.csv", { type: "text/csv" }),
    );
    await user.click(screen.getByRole("button", { name: "Prévisualiser" }));
    await user.click(await screen.findByRole("button", { name: "Appliquer 1 ligne" }));
    expect(await screen.findByText("OLA Importée")).toBeInTheDocument();
  });
});

describe("Référentiels — camions", () => {
  it("compartiments : ajout, produits compatibles, somme et capacité totale", async () => {
    loginAs("admin");
    const { user } = renderApp("/referentiels?tab=trucks");
    const table = await grid("Camions");
    await waitFor(() => expect(dataRows(table)).toHaveLength(12));
    await user.dblClick(screen.getByText("LT 641 QR"));
    const dialog = await screen.findByRole("dialog", { name: "Modifier le camion" });
    expect(within(dialog).getByTestId("compartments-sum")).toHaveTextContent(
      /9\s000\sL — capacité totale : 9\s000\sL/,
    );

    await user.click(within(dialog).getByRole("button", { name: "Ajouter un compartiment" }));
    await user.type(within(dialog).getByLabelText("Capacité 3"), "3000");
    const products = within(dialog).getByRole("group", { name: "Produits compatibles 3" });
    expect(within(products).getByRole("button", { name: "Tous produits" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(products).getByRole("button", { name: "GASOIL" }));
    expect(within(products).getByRole("button", { name: "Tous produits" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    expect(
      within(dialog).getByText("La somme des compartiments diffère de la capacité totale."),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Utiliser la somme" }));
    expect(within(dialog).getByLabelText(/^Capacité totale/)).toHaveValue("12 000");
    await user.click(within(dialog).getByRole("button", { name: "Retirer le compartiment 1" }));
    await user.click(within(dialog).getByRole("button", { name: "Utiliser la somme" }));
    await user.click(within(dialog).getByRole("button", { name: "Enregistrer" }));

    expect(await screen.findByText("« LT 641 QR » mis à jour")).toBeInTheDocument();
    const truck = db.trucks.find((t) => t.plate === "LT 641 QR");
    const gasoil = db.products.find((p) => p.code === "GASOIL")?.id;
    expect(truck?.total_capacity_l).toBe(7000);
    expect(truck?.compartments.map((c) => [c.position, c.capacity_l, c.allowed_product_ids])).toEqual([
      [1, 4000, null],
      [2, 3000, [gasoil]],
    ]);
  });

  it("statut modifiable dans le tableau ; action en masse sur la sélection", async () => {
    loginAs("admin");
    const { user } = renderApp("/referentiels?tab=trucks");
    const table = await grid("Camions");
    await waitFor(() => expect(dataRows(table)).toHaveLength(12));

    const statusCell = within(rowOf("LT 120 GH"))
      .getAllByRole("gridcell")
      .find((cell) => cell.hasAttribute("data-editable")) as HTMLElement;
    statusCell.focus();
    await user.keyboard("{Enter}");
    await user.selectOptions(within(statusCell).getByRole("combobox"), "broken");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(db.trucks.find((t) => t.plate === "LT 120 GH")?.status).toBe("broken"));
    await waitFor(() => expect(within(rowOf("LT 120 GH")).getByText("En panne")).toBeInTheDocument());

    await user.click(within(rowOf("LT 733 EF")).getByRole("checkbox"));
    await user.click(within(rowOf("LT 357 NP")).getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Changer le statut : Disponible" }));
    await waitFor(() =>
      expect(
        db.trucks.filter((t) => ["LT 733 EF", "LT 357 NP"].includes(t.plate)).map((t) => t.status),
      ).toEqual(["available", "available"]),
    );
    expect(db.trucks.find((t) => t.plate === "LT 733 EF")?.compartments).toHaveLength(4);
  });
});

describe("Référentiels — chauffeurs", () => {
  it("alertes visuelles : permis / habilitation expirés (rouge) ou proches (orange)", async () => {
    loginAs("admin");
    renderApp("/referentiels?tab=drivers");
    const table = await grid("Chauffeurs");
    await waitFor(() => expect(dataRows(table)).toHaveLength(14));

    expect(
      await screen.findByText("2 chauffeurs ont un permis ou une habilitation expiré"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/2 chauffeurs ont un document qui expire dans moins de 30 jours/),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Aboubakar Hamadou, Martin Essomba");

    // Tri par défaut : échéance du permis la plus proche en tête.
    expect(within(dataRows(table)[0]).getByText("Aboubakar Hamadou")).toBeInTheDocument();
    expect(table.querySelectorAll('[data-expiry="expired"]')).toHaveLength(2);
    expect(table.querySelectorAll('[data-expiry="soon"]')).toHaveLength(2);
    expect(within(rowOf("Daniel Mouelle")).getByText("Sans habilitation")).toBeInTheDocument();
    expect(
      within(rowOf("Aboubakar Hamadou")).getByText(
        `Expiré le ${addDays(todayLocal(), -12).split("-").reverse().join("/")}`,
      ),
    ).toBeInTheDocument();
  });

  it("calcul des alertes : un chauffeur compte une fois, sans habilitation ≠ expirée", () => {
    const today = "2027-01-12";
    const base = { hazmat_cert: true, license_expiry: "2028-01-01", hazmat_expiry: "2028-01-01" } as Driver;
    const list = [
      { ...base, id: "1", full_name: "A", license_expiry: "2027-01-01", hazmat_expiry: "2027-01-20" },
      { ...base, id: "2", full_name: "B", hazmat_expiry: "2027-02-01" },
      { ...base, id: "3", full_name: "C", hazmat_cert: false, hazmat_expiry: "2020-01-01" },
      { ...base, id: "4", full_name: "D", license_expiry: null },
    ] as Driver[];
    const issues = driverDocumentIssues(list, today);
    expect(issues.expired.map((d) => d.full_name)).toEqual(["A"]);
    expect(issues.soon.map((d) => d.full_name)).toEqual(["B"]);
    expect(driverAlerts(issues).map((alert) => alert.severity)).toEqual(["blocking", "warning"]);
    expect(driverAlerts({ expired: [], soon: [] })).toEqual([]);
  });

  it("fiche chauffeur : sans habilitation, la date d'expiration est désactivée et effacée", async () => {
    loginAs("admin");
    const { user } = renderApp("/referentiels?tab=drivers");
    await grid("Chauffeurs");
    await user.dblClick(await screen.findByText("Jean-Paul Mbarga"));
    const dialog = await screen.findByRole("dialog", { name: "Modifier le chauffeur" });
    expect(within(dialog).getByLabelText(/^Expiration de l'habilitation/)).toBeEnabled();
    await user.click(within(dialog).getByRole("switch", { name: "Habilitation matières dangereuses" }));
    expect(within(dialog).getByLabelText(/^Expiration de l'habilitation/)).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Enregistrer" }));
    await waitFor(() =>
      expect(db.drivers.find((d) => d.full_name === "Jean-Paul Mbarga")).toMatchObject({
        hazmat_cert: false,
        hazmat_expiry: null,
      }),
    );
    await waitFor(() =>
      expect(within(rowOf("Jean-Paul Mbarga")).getByText("Sans habilitation")).toBeInTheDocument(),
    );
  });
});

describe("Référentiels — produits, dépôts, transporteurs", () => {
  it("produit : création dans une petite boîte, libellé modifiable dans le tableau", async () => {
    loginAs("admin");
    const { user } = renderApp("/referentiels?tab=products");
    const table = await grid("Produits");
    await waitFor(() => expect(dataRows(table)).toHaveLength(3));
    await user.click(screen.getByRole("button", { name: "Nouveau produit" }));
    const dialog = await screen.findByRole("dialog", { name: "Nouveau produit" });
    await user.type(within(dialog).getByLabelText(/^Code/), "jet");
    await user.type(within(dialog).getByLabelText(/^Libellé/), "Jet A1");
    await user.type(within(dialog).getByLabelText(/^Densité/), "0,8");
    await user.type(within(dialog).getByLabelText(/^Coeff/), "0,0009");
    await user.click(within(dialog).getByRole("button", { name: "Enregistrer" }));
    await waitFor(() =>
      expect(db.products.find((p) => p.code === "JET")).toMatchObject({
        label: "Jet A1",
        ref_density_15: 0.8,
        thermal_coeff: 0.0009,
        color: "#1d6fb8",
      }),
    );
    await waitFor(() => expect(dataRows(table)).toHaveLength(4));

    const labelCell = within(rowOf("Gasoil"))
      .getAllByRole("gridcell")
      .find((cell) => cell.textContent === "Gasoil") as HTMLElement;
    labelCell.focus();
    await user.keyboard("{F2}");
    await user.type(within(labelCell).getByRole("textbox"), " 50 ppm{Enter}");
    await waitFor(() => expect(db.products.find((p) => p.code === "GASOIL")?.label).toBe("Gasoil 50 ppm"));
  });

  it("suppression refusée par le serveur : message affiché, rien n'est supprimé", async () => {
    loginAs("admin");
    const { user } = renderApp("/referentiels?tab=carriers");
    const table = await grid("Transporteurs");
    await waitFor(() => expect(dataRows(table)).toHaveLength(3));
    await user.click(screen.getByRole("button", { name: "Actions — Sanaga Logistique" }));
    await user.click(await screen.findByRole("menuitem", { name: "Supprimer" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Supprimer" }),
    );
    expect(await screen.findByText(/rattaché à des camions ou à des chauffeurs/)).toBeInTheDocument();
    expect(dataRows(table)).toHaveLength(3);
  });

  it("dépôts : carte, valeurs par défaut explicites, horaires résumés", async () => {
    loginAs("admin");
    renderApp("/referentiels?tab=depots");
    const table = await grid("Dépôts");
    await waitFor(() => expect(dataRows(table)).toHaveLength(3));
    const scdp = rowOf("SCDP Douala Bessengué");
    expect(within(scdp).getAllByText("Défaut")).toHaveLength(2);
    expect(within(scdp).getByText("lun.–ven. 06:00–18:00 · sam. 06:00–13:00")).toBeInTheDocument();
    expect(within(rowOf("Dépôt tiers Limbé")).getByText("En continu")).toBeInTheDocument();
    expect(
      screen.getByRole("figure", { name: "Dépôts" }).querySelectorAll('[data-kind="depot"]'),
    ).toHaveLength(3);
  });
});

describe("Référentiels — lecture seule", () => {
  it("direction : consultation sans aucune action d'écriture", async () => {
    loginAs("manager");
    const { user } = renderApp("/referentiels?tab=trucks");
    const table = await grid("Camions");
    await waitFor(() => expect(dataRows(table)).toHaveLength(12));
    expect(screen.getByText(/Lecture seule/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Nouveau camion" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Importer" })).not.toBeInTheDocument();
    expect(within(table).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(table.querySelector("[data-editable]")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Actions — LT 482 AB" }));
    expect(screen.queryByRole("menuitem", { name: "Supprimer" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("menuitem", { name: "Détails" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(/^Immatriculation/)).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "Enregistrer" })).not.toBeInTheDocument();
    await user.click(within(dialog).getAllByRole("button", { name: "Fermer" })[0]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
