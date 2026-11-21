import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { server } from "@/mocks/server";
import { loginAs, renderApp } from "@/test/utils";

import { createDeliveryMocks } from "./mocks";
import { delaySeconds, localTimeToUtc } from "./time";

const DAY = "2027-01-12";

function setup(role: Parameters<typeof loginAs>[0] = "dispatcher", route = `/suivi?day=${DAY}`) {
  const mocks = createDeliveryMocks(DAY);
  server.use(...mocks.handlers);
  loginAs(role);
  return { mocks, ...renderApp(route) };
}
const stopCard = (seq: number) => screen.findByTestId(`stop-${seq}`);

describe("Suivi des livraisons — heures", () => {
  it("convertit l'heure locale en UTC et mesure le retard sur l'horaire prévu (RM-20)", () => {
    expect(localTimeToUtc(DAY, "08:52")).toBe("2027-01-12T07:52:00.000Z");
    expect(delaySeconds("2027-01-12T07:40:00Z", "2027-01-12T07:52:00Z")).toBe(720);
    expect(delaySeconds("2027-01-12T07:40:00Z", null)).toBeNull();
  });
});

describe("Suivi des livraisons — écran", () => {
  it("liste les tournées avec leur avancement et ouvre la tournée en cours", async () => {
    setup();
    const list = await screen.findByRole("list", { name: "Tournées du plan publié" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    const card = within(list).getByTestId("trip-card-1");
    expect(within(card).getByText("0 / 2 arrêts")).toBeInTheDocument();
    expect(within(card).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    // Départ réel 08:22 pour 08:15 prévu.
    expect(within(card).getByTestId("delay")).toHaveTextContent("Retard 7 min");
    const detail = await screen.findByTestId("trip-detail");
    expect(within(detail).getByRole("heading", { name: /Tournée 1/ })).toBeInTheDocument();
    // Le premier arrêt à livrer est ouvert, volumes planifiés proposés ; le suivant s'ouvre à la demande.
    const first = await stopCard(1);
    expect(within(first).getAllByRole("textbox", { name: /Volume livré .*, arrêt 1/ })[0]).toHaveValue(
      "12\u00a0000",
    );
    expect(
      within(await stopCard(2)).getByRole("button", { name: "Saisir la livraison" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clôturer la tournée" })).toBeDisabled();
    expect(screen.getByTestId("close-hint")).toHaveTextContent("2 arrêts ni livrés ni sautés");
  });

  it("enregistre une livraison : heures réelles, volumes par commande, retard affiché", async () => {
    const { mocks, user } = setup();
    const first = await stopCard(1);
    await user.click(within(first).getByRole("button", { name: "Enregistrer la livraison" }));
    expect(await within(first).findByText(/Heure d'arrivée réelle obligatoire/)).toBeInTheDocument();
    expect(mocks.requests).toHaveLength(0);

    await user.type(within(first).getByRole("textbox", { name: "Arrivée réelle, arrêt 1" }), "852");
    await user.type(within(first).getByRole("textbox", { name: "Départ réel, arrêt 1" }), "930");
    const gasoil = within(first).getAllByRole("textbox", { name: /Volume livré .*, arrêt 1/ })[1];
    await user.clear(gasoil);
    await user.type(gasoil, "7500");
    await user.click(within(first).getByRole("button", { name: "Enregistrer la livraison" }));

    await waitFor(() => expect(mocks.stop(1, 1).status).toBe("delivered"));
    const body = mocks.requests[0].body as { deliveries: { order_id: string; actual_l: number }[] };
    expect(body).toMatchObject({
      actual_arrival_at: "2027-01-12T07:52:00.000Z",
      actual_departure_at: "2027-01-12T08:30:00.000Z",
    });
    expect(body.deliveries.map((line) => line.actual_l)).toEqual([12000, 7500]);
    expect(body).not.toHaveProperty("skip_reason");

    const delivered = await stopCard(1);
    await waitFor(() => expect(within(delivered).getByText("Livré")).toBeInTheDocument());
    expect(within(delivered).getByTestId("delay")).toHaveTextContent("Retard 12 min");
    expect(within(delivered).getByText("7 500 L")).toBeInTheDocument();
    expect(screen.getByTestId("trip-progress")).toHaveTextContent("1 / 2 arrêts");
    // Livré : corrigeable, mais plus « sautable » (non réversible).
    expect(within(delivered).getByRole("button", { name: "Corriger" })).toBeInTheDocument();
    expect(within(delivered).queryByRole("button", { name: "Arrêt sauté…" })).not.toBeInTheDocument();
    expect(within(delivered).getByText(/ne peut plus être marqué « sauté »/)).toBeInTheDocument();
  });

  it("arrêt sauté : motif obligatoire, puis non réversible", async () => {
    const { mocks, user } = setup();
    const first = await stopCard(1);
    await user.click(within(first).getByRole("button", { name: "Arrêt sauté…" }));
    await user.click(within(first).getByRole("button", { name: "Confirmer l'arrêt sauté" }));
    expect(
      await within(first).findByText("Le motif est obligatoire pour un arrêt sauté."),
    ).toBeInTheDocument();
    expect(mocks.requests).toHaveLength(0);

    await user.type(within(first).getByRole("textbox", { name: /Motif de l'arrêt sauté/ }), "Station fermée");
    await user.click(within(first).getByRole("button", { name: "Confirmer l'arrêt sauté" }));
    await waitFor(() => expect(mocks.stop(1, 1).status).toBe("skipped"));
    expect(mocks.requests[0].body).toEqual({ actual_arrival_at: null, skip_reason: "Station fermée" });

    const skipped = await stopCard(1);
    expect(await within(skipped).findByText("Motif : Station fermée")).toBeInTheDocument();
    expect(within(skipped).getByText(/Arrêt sauté : non réversible/)).toBeInTheDocument();
    expect(within(skipped).queryByRole("button", { name: /Corriger|Saisir/ })).not.toBeInTheDocument();
  });

  it("clôture : refusée tant qu'un arrêt est en attente, puis heure de retour et kilomètres réels", async () => {
    const { mocks, user } = setup();
    await stopCard(1);
    mocks.stop(1, 1).status = "delivered";
    mocks.stop(1, 1).actual_arrival_at = "2027-01-12T07:45:00Z";
    const second = await stopCard(2);
    await user.click(within(second).getByRole("button", { name: "Saisir la livraison" }));
    await user.type(within(second).getByRole("textbox", { name: "Arrivée réelle, arrêt 2" }), "0940");
    await user.click(within(second).getByRole("button", { name: "Enregistrer la livraison" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Clôturer la tournée" })).toBeEnabled());
    expect(screen.getByTestId("close-hint")).toHaveTextContent("Tous les arrêts sont traités");
    await user.type(screen.getByRole("textbox", { name: "Heure de retour au dépôt" }), "1245");
    await user.type(screen.getByRole("textbox", { name: /Kilomètres réels/ }), "26,4");
    await user.click(screen.getByRole("button", { name: "Clôturer la tournée" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Clôturer la tournée ?" });
    await user.click(within(confirm).getByRole("button", { name: "Clôturer la tournée" }));

    await waitFor(() => expect(mocks.plan.trips[0].status).toBe("completed"));
    expect(mocks.requests.at(-1)?.body).toEqual({
      status: "completed",
      actual_return_at: "2027-01-12T11:45:00.000Z",
      actual_distance_m: 26400,
    });
    expect(await screen.findByText(/Tournée terminée : les heures, volumes/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clôturer la tournée" })).not.toBeInTheDocument();
  });

  it("explique pourquoi la saisie est fermée hors « En cours » et renvoie vers le chargement", async () => {
    const { mocks } = setup("fleet", `/suivi?day=${DAY}&trip=00000000-0000-4000-9000-000000000002`);
    const detail = await screen.findByTestId("trip-detail");
    expect(within(detail).getByText(/Le camion est chargé mais pas encore parti/)).toBeInTheDocument();
    expect(within(detail).getByRole("link", { name: "Ouvrir le chargement" })).toHaveAttribute(
      "href",
      `/chargement?trip=${mocks.trips[1].id}&day=${DAY}`,
    );
    expect(within(detail).queryByRole("button", { name: /Enregistrer la livraison|Saisir/ })).toBeNull();
    expect(within(detail).queryByRole("form", { name: "Clôture de la tournée" })).toBeNull();
  });

  it("affiche le refus 409 de l'API avec son explication", async () => {
    const { mocks, user } = setup();
    const first = await stopCard(1);
    // Entre-temps la tournée a été clôturée ailleurs.
    mocks.plan.trips[0].status = "completed";
    await user.type(within(first).getByRole("textbox", { name: "Arrivée réelle, arrêt 1" }), "0852");
    await user.click(within(first).getByRole("button", { name: "Enregistrer la livraison" }));
    // Notification avec l'explication du code `trip_not_in_progress`, puis écran rechargé (tournée terminée).
    expect(
      await screen.findByText("Une livraison se saisit uniquement sur une tournée « En cours »."),
    ).toBeInTheDocument();
    expect(await screen.findByText(/Tournée terminée : les heures, volumes/)).toBeInTheDocument();
  });

  it("lecture seule pour la direction", async () => {
    setup("manager");
    const first = await stopCard(1);
    expect(screen.getByText(/Lecture seule/)).toBeInTheDocument();
    expect(within(first).queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Clôture de la tournée" })).not.toBeInTheDocument();
  });

  it("état vide quand aucun plan n'est publié ce jour", async () => {
    setup("dispatcher", "/suivi?day=2027-01-13");
    expect(await screen.findByText("Aucune tournée publiée ce jour")).toBeInTheDocument();
  });
});
