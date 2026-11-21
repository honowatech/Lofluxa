import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { db } from "@/mocks/db";
import { server } from "@/mocks/server";
import { loginAs, renderApp } from "@/test/utils";

import type { LoadingInput } from "./api";
import { computeGap, decomposeGap, localTimeToUtc, roundCenti, volumeAt15 } from "./conversion";
import { createLoadingMocks } from "./mocks";

const DAY = "2027-01-12";

function setup(role: Parameters<typeof loginAs>[0] = "fleet", route = `/chargement?day=${DAY}`) {
  // Coefficients par défaut de la spec (RM-12), quel que soit le jeu fictif du socle.
  for (const [code, coeff] of [
    ["SUPER", 0.0012],
    ["GASOIL", 0.00085],
  ] as const) {
    const product = db.products.find((item) => item.code === code);
    if (product) product.thermal_coeff = coeff;
  }
  const mocks = createLoadingMocks(DAY);
  server.use(...mocks.handlers);
  loginAs(role);
  return { mocks, ...renderApp(route) };
}
const panel = () => screen.findByTestId("trip-panel");
const row = (position: number) => screen.getByTestId(`compartment-${position}`);

describe("Chargement — calcul (RM-12, RM-13)", () => {
  it("test_RM_12_volume_a_15_degres : volume observé × [1 − coefficient × (température − 15)]", () => {
    expect(volumeAt15(12000, 30, 0.0012)).toBe(11784);
    expect(volumeAt15(10000, 15, 0.00085)).toBe(10000);
    expect(volumeAt15(8000, 10, 0.00085)).toBe(8034);
    // Arrondi au centième, demi vers le haut (comme le serveur).
    expect(roundCenti(102.485)).toBe(102.49);
    expect(volumeAt15(11800, 29.5, 0.0012)).toBe(11594.68);
  });

  it("test_RM_13_ecart_hors_tolerance : strict, en valeur absolue, rapporté au planifié", () => {
    expect(computeGap(9800, 10000, 2)).toMatchObject({ gapL: -200, gapPct: -2, outOfTolerance: false });
    expect(computeGap(9799.99, 10000, 2).outOfTolerance).toBe(true);
    expect(computeGap(10201, 10000, 2).outOfTolerance).toBe(true);
    expect(computeGap(500, 0, 2)).toMatchObject({ gapPct: null, outOfTolerance: true });
    expect(computeGap(9000, 10000, null).outOfTolerance).toBeNull();
  });

  it("test_RM_13_decomposition_de_l_ecart : écart = température (15 °C − observé) + volume (observé − planifié)", () => {
    const parts = decomposeGap(11800, 11594.68, 12000);
    expect(parts).toEqual({
      temperatureL: -205.32,
      temperaturePct: -1.71,
      observedL: -200,
      observedPct: -1.67,
    });
    expect(parts.temperatureL + parts.observedL).toBeCloseTo(computeGap(11594.68, 12000, 2).gapL, 2);
  });

  it("heure locale de Douala → UTC (RM-20)", () => {
    expect(localTimeToUtc(DAY, "07:05")).toBe("2027-01-12T06:05:00.000Z");
  });
});

describe("Chargement — écran", () => {
  it("liste les tournées du jour et ouvre la première à charger", async () => {
    setup();
    const list = await screen.findByRole("list", { name: "Tournées du jour" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("LT 482 AB")).toBeInTheDocument();
    expect(screen.getByText("2 tournées")).toBeInTheDocument();
    const detail = await panel();
    expect(within(detail).getByRole("heading", { name: /Tournée 1/ })).toBeInTheDocument();
    await screen.findByRole("form", { name: "Chargement réel" });
    expect(screen.getAllByTestId(/^compartment-/)).toHaveLength(3);
    // Mention exigée par RM-12.
    expect(screen.getByTestId("astm-note")).toHaveTextContent(
      "Densité stockée, non utilisée dans le calcul ; tables ASTM non appliquées dans le prototype",
    );
    // Fiche de chargement indisponible tant que rien n'est enregistré.
    expect(screen.getByRole("button", { name: "Fiche de chargement" })).toBeDisabled();
  });

  it("filtre par statut et par état de chargement", async () => {
    const { mocks, user } = setup();
    mocks.trips[1].status = "at_depot";
    const list = await screen.findByRole("list", { name: "Tournées du jour" });
    await user.click(screen.getByRole("button", { name: "Au dépôt" }));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(1));
    expect(within(list).getByText("LT 120 GH")).toBeInTheDocument();
    expect(screen.getByText("1 sur 2 tournées")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "État de chargement" }), "done");
    expect(await screen.findByText("Aucune tournée ne correspond aux filtres.")).toBeInTheDocument();
  });

  it("calcule le volume à 15 °C et l'écart en direct, avertit RM-13, puis enregistre", async () => {
    const { mocks, user } = setup();
    await screen.findByRole("form", { name: "Chargement réel" });

    await user.type(screen.getByRole("textbox", { name: "Arrivée au dépôt" }), "705{Enter}");
    // Entrée passe au champ suivant : la saisie s'enchaîne sans souris.
    expect(screen.getByRole("textbox", { name: "Début du chargement" })).toHaveFocus();
    await user.keyboard("720{Enter}805{Enter}BL-2027-0042{Enter}");
    expect(screen.getByRole("textbox", { name: "Volume observé, compartiment 1" })).toHaveFocus();
    await user.keyboard("12000{Enter}30{Enter}0,745{Enter}");
    // 12 000 × [1 − 0,0012 × 15] = 11 784 → écart −216 L, −1,80 % : dans la tolérance de 2 %.
    expect(within(row(1)).getByTestId("at15")).toHaveTextContent("11 784,00");
    expect(row(1)).toHaveTextContent("−216,00");
    expect(row(1)).toHaveTextContent("−1,80 %");

    await user.keyboard("9000{Enter}35{Enter}{Enter}");
    // 9 000 × [1 − 0,0012 × 20] = 8 784 → −2,40 % : hors tolérance.
    expect(within(row(2)).getByTestId("at15")).toHaveTextContent("8 784,00");
    expect(screen.getByTestId("rm13-warning")).toHaveTextContent("RM-13");
    expect(screen.getByText(/compartiment 2 : −216\s?L \(−2,40\s%\)/)).toBeInTheDocument();
    // Compartiment 3 planifié mais non saisi : compte pour 0 L.
    expect(screen.getByText(/compartiment 3 : non chargé/)).toBeInTheDocument();
    // Décomposition : ici tout l'écart vient de la température (volume observé = planifié).
    expect(within(row(2)).getByTestId("gap-parts")).toHaveTextContent("T° −216 · vol. 0");

    await user.keyboard("8000{Enter}15{Enter}");
    expect(within(row(3)).getByTestId("at15")).toHaveTextContent("8 000,00");
    expect(screen.getByTestId("loading-total")).toHaveTextContent("28 568,00");
    // Écart total −432 L = température −432 L + volume chargé 0 L.
    expect(screen.getByTestId("rm13-parts")).toHaveTextContent(
      /correction de température −432 L \(−1,49 %\) \+ volume chargé 0 L \(0,00 %\)/,
    );

    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(mocks.loadings.size).toBe(1));
    const sent = mocks.requests[0].body as LoadingInput;
    expect(sent).toMatchObject({
      arrived_at: "2027-01-12T06:05:00.000Z",
      started_at: "2027-01-12T06:20:00.000Z",
      finished_at: "2027-01-12T07:05:00.000Z",
      depot_ticket_no: "BL-2027-0042",
    });
    expect(sent.lines).toHaveLength(3);
    expect(sent.lines[0]).toMatchObject({ observed_l: 12000, observed_temp_c: 30, observed_density: 0.745 });
    expect(sent.lines[1].observed_density).toBeNull();
    // Après enregistrement : valeurs du serveur, avertissement conservé, fiche disponible.
    expect(await screen.findByRole("button", { name: "Mettre à jour le chargement" })).toBeInTheDocument();
    // Explication fournie par le serveur avec l'avertissement.
    expect(screen.getByText(/Écart dû en partie à la correction de température/)).toBeInTheDocument();
    expect(screen.getByTestId("rm13-warning")).toBeInTheDocument();
    expect(screen.getByText("Saisi par", { exact: false })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Fiche de chargement" })).toBeEnabled());
    expect(within(screen.getByTestId("trip-card-1")).getByText("Écart RM-13")).toBeInTheDocument();
  });

  it("refuse un chargement vide ou incohérent avant tout envoi", async () => {
    const { mocks, user } = setup();
    await screen.findByRole("form", { name: "Chargement réel" });
    await user.click(screen.getByRole("button", { name: "Enregistrer le chargement" }));
    expect(await screen.findByText(/Saisissez au moins un compartiment/)).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Arrivée au dépôt" }), "0900");
    await user.type(screen.getByRole("textbox", { name: "Fin du chargement" }), "0800");
    await user.type(screen.getByRole("textbox", { name: "Volume observé, compartiment 1" }), "12000");
    await user.click(screen.getByRole("button", { name: "Enregistrer le chargement" }));
    expect(await screen.findByText(/Température obligatoire/)).toBeInTheDocument();
    expect(screen.getByText(/arrivée ≤ début ≤ fin/)).toBeInTheDocument();
    expect(mocks.requests).toHaveLength(0);
  });

  it("enchaîne planned → at_depot → loaded → in_progress et explique les refus 409", async () => {
    const { mocks, user } = setup();
    await screen.findByRole("form", { name: "Chargement réel" });

    await user.click(screen.getByRole("button", { name: "Camion arrivé au dépôt" }));
    const loaded = await screen.findByRole("button", { name: "Chargement terminé" });
    // Sans chargement enregistré, l'étape « Chargée » n'est pas proposée (409 `loading_missing` côté API).
    expect(loaded).toBeDisabled();
    expect(screen.getByText(/Enregistrez le chargement avant de passer la tournée/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reprendre les volumes planifiés" }));
    for (const position of [1, 2, 3]) {
      await user.type(screen.getByRole("textbox", { name: `Température, compartiment ${position}` }), "15");
    }
    await user.click(screen.getByRole("button", { name: "Enregistrer le chargement" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Chargement terminé" })).toBeEnabled());
    expect(screen.getByText(/Écarts dans la tolérance/)).toBeInTheDocument();

    // Un autre poste a déjà fait avancer la tournée : 409 `invalid_transition` expliqué, liste rechargée.
    mocks.trips[0].status = "loaded";
    await user.click(screen.getByRole("button", { name: "Chargement terminé" }));
    expect(await screen.findByText(/la tournée a déjà changé de statut/)).toBeInTheDocument();

    const depart = await screen.findByRole("button", { name: "Départ du dépôt" });
    await user.type(screen.getByRole("textbox", { name: "Heure de départ réelle" }), "0815");
    await user.click(depart);
    await waitFor(() => expect(mocks.trips[0].status).toBe("in_progress"));
    expect(mocks.requests.at(-1)?.body).toEqual({
      status: "in_progress",
      actual_depart_at: "2027-01-12T07:15:00.000Z",
    });
    // Chargement figé une fois le camion parti ; lien vers le suivi des livraisons.
    expect(await screen.findByText(/Chargement figé/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Volume observé, compartiment 1" })).toBeDisabled();
    expect(
      within(screen.getByTestId("trip-panel")).getByRole("link", { name: "Suivi des livraisons" }),
    ).toHaveAttribute("href", expect.stringContaining(`/suivi?trip=${mocks.trips[0].id}&day=${DAY}`));
  });

  it("envoie la fiche par e-mail aux destinataires proposés et signale les stations sans adresse", async () => {
    const { mocks, user } = setup("dispatcher");
    await screen.findByRole("form", { name: "Chargement réel" });
    await user.click(screen.getByRole("button", { name: "Reprendre les volumes planifiés" }));
    for (const position of [1, 2, 3]) {
      await user.type(screen.getByRole("textbox", { name: `Température, compartiment ${position}` }), "15");
    }
    await user.click(screen.getByRole("button", { name: "Enregistrer le chargement" }));
    const email = await screen.findByRole("button", { name: "Envoyer la fiche" });
    await waitFor(() => expect(email).toBeEnabled());
    await user.click(email);

    const dialog = await screen.findByRole("dialog", { name: "Envoyer la fiche de chargement" });
    expect(within(dialog).getByText("akwa@ola.example")).toBeInTheDocument();
    expect(within(dialog).getByText(/Stations sans adresse e-mail .* DLA-002/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Autres destinataires"), "pas-une-adresse");
    await user.click(within(dialog).getByRole("button", { name: "Envoyer" }));
    expect(await within(dialog).findByText("Adresse invalide : pas-une-adresse")).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText("Autres destinataires"));
    await user.type(within(dialog).getByLabelText("Autres destinataires"), "Dispatch@OLA.example");
    await user.click(within(dialog).getByRole("button", { name: "Envoyer" }));
    await waitFor(() => expect(mocks.sentEmails).toEqual([["akwa@ola.example", "dispatch@ola.example"]]));
    expect(await within(dialog).findByText(/Envoyée à/)).toBeInTheDocument();
  });

  it("lecture seule pour la direction : ni saisie, ni changement de statut", async () => {
    setup("manager");
    await screen.findByRole("form", { name: "Chargement réel" });
    expect(screen.getByText(/Lecture seule/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Volume observé, compartiment 1" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Camion arrivé au dépôt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enregistrer le chargement" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Envoyer la fiche" })).not.toBeInTheDocument();
  });

  it("état vide quand aucun plan n'est publié ce jour", async () => {
    setup("fleet", "/chargement?day=2027-01-13");
    expect(await screen.findByText("Aucune tournée publiée ce jour")).toBeInTheDocument();
  });
});
