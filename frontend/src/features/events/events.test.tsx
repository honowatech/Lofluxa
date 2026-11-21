import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/mocks/db";
import { server } from "@/mocks/server";
import { loginAs, renderApp } from "@/test/utils";

import { normalizeEvents, normalizeReassignment, normalizeShortage } from "./api";
import {
  createEventsScenario,
  eventsHandlers,
  SAMPLE_NEW_PLAN_ID,
  SAMPLE_TRIP_IDS,
  type EventsScenario,
  type SampleRefs,
} from "./mocks";

const DAY = "2027-01-12";
const ROUTE = `/journal?day=${DAY}`;

/** Références prises dans les doublures communes : les listes de dépôts et de produits y sont servies. */
function refs(): SampleRefs {
  const depot = db.depots.find((item) => item.code === "SCDP-DLA")!;
  const product = (code: string) => db.products.find((item) => item.code === code)!.id;
  return {
    depot: { id: depot.id, code: depot.code, name: depot.name },
    products: { SUPER: product("SUPER"), GASOIL: product("GASOIL"), PETROLE: product("PETROLE") },
  };
}

let scenario: EventsScenario;
beforeEach(() => {
  scenario = createEventsScenario(DAY, refs());
  server.use(...eventsHandlers(scenario));
});

const rows = () => screen.findAllByTestId("event-row");
const chip = (name: RegExp) =>
  within(screen.getByRole("group", { name: "Filtrer par type d'événement" })).getByRole("button", { name });

describe("Journal des événements — fil de la journée", () => {
  it("affiche les événements du jour, du plus récent au plus ancien, heures de Douala", async () => {
    loginAs("dispatcher");
    renderApp(ROUTE);
    const list = await rows();
    expect(list).toHaveLength(13);
    expect(within(list[0]).getByText("09:20")).toBeInTheDocument();
    expect(within(list[0]).getByText("Chauffeur indisponible")).toBeInTheDocument();
    expect(within(list[12]).getByText("05:48")).toBeInTheDocument();
    expect(screen.getByText(/13 événements/)).toBeInTheDocument();
  });

  it("filtre par type, avec compteurs et cumul des types choisis", async () => {
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    await rows();
    expect(chip(/^Tous 13$/)).toHaveAttribute("aria-pressed", "true");
    expect(chip(/^Chargement 3$/)).toHaveAttribute("aria-pressed", "false");

    await user.click(chip(/^Pénurie produit 1$/));
    expect(await rows()).toHaveLength(1);
    expect(chip(/^Tous 13$/)).toHaveAttribute("aria-pressed", "false");

    await user.click(chip(/^Publication 2$/));
    expect(await rows()).toHaveLength(3);

    await user.click(chip(/^Tous 13$/));
    expect(await rows()).toHaveLength(13);
  });

  it("résume chaque type d'événement en clair, avec acteur et lien", async () => {
    loginAs("dispatcher");
    renderApp(ROUTE);
    await rows();
    // Panne de camion (forme supposée) : résumé construit, RM-19, lien vers la nouvelle version.
    const breakdown = screen.getByText("Camion LT 782 KD en panne, remplacé par LT 608 EM.").closest("li")!;
    expect(within(breakdown).getByText(/2 arrêts transférés ; 1 déjà livré reste/)).toBeInTheDocument();
    expect(within(breakdown).getByText("par Serge Mbarga")).toBeInTheDocument();
    expect(within(breakdown).getByRole("link", { name: "Voir la nouvelle version" })).toHaveAttribute(
      "href",
      `/plan?plan=${SAMPLE_NEW_PLAN_ID}&day=${DAY}`,
    );
    expect(screen.getByText("Emmanuel Tchoua indisponible, remplacé par Hervé Ndjock.")).toBeInTheDocument();
    // Pénurie.
    const shortage = screen
      .getByText(/Stock de Gasoil au dépôt SCDP-DLA ramené à 15\s000 L\./)
      .closest("li")!;
    expect(within(shortage).getByText(/1 tournée impactée/)).toBeInTheDocument();
    // Plan : la phrase du serveur est reprise telle quelle.
    expect(screen.getByText("Version 2 publiée (la version 1 est archivée).")).toBeInTheDocument();
    expect(screen.getByText(/Plan recalculé en conservant 2 tournée\(s\) figée\(s\)/)).toBeInTheDocument();
    // Chargement (payload réel du lot L6) : écart RM-13 signalé, lien vers l'écran Chargement.
    const loading = screen.getByText("Chargement enregistré (bon n° BL-2238).").closest("li")!;
    expect(
      within(loading).getByText(/33\s106 L à 15 °C pour 34\s000 L planifiés \(−2,63 %\)/),
    ).toBeInTheDocument();
    expect(within(loading).getByText("Écart hors tolérance (RM-13)")).toBeInTheDocument();
    expect(within(loading).getByRole("link", { name: "Voir le chargement" })).toHaveAttribute(
      "href",
      `/chargement?trip=${SAMPLE_TRIP_IDS[0]}&day=${DAY}`,
    );
    expect(screen.getByText("Chargement corrigé (bon n° BL-2241).")).toBeInTheDocument();
    // Livraisons (payload réel du lot L6).
    const delivered = screen.getByText("Arrêt 1 — ST-BEPAN livré.").closest("li")!;
    expect(within(delivered).getByText(/13\s950 L livrés sur 14\s000 L prévus\./)).toBeInTheDocument();
    const skipped = screen.getByText("Arrêt 2 — ST-MAKEP sauté.").closest("li")!;
    expect(within(skipped).getByText("Motif : Station fermée à l'arrivée")).toBeInTheDocument();
    expect(within(skipped).getByRole("link", { name: "Suivre la tournée" })).toHaveAttribute(
      "href",
      `/suivi?trip=${SAMPLE_TRIP_IDS[2]}&day=${DAY}`,
    );
  });

  it("journée sans événement, puis erreur de chargement avec nouvel essai", async () => {
    loginAs("dispatcher");
    scenario.events.length = 0;
    const { unmount } = renderApp(ROUTE);
    expect(await screen.findByText("Aucun événement ce jour")).toBeInTheDocument();
    unmount();

    server.use(
      http.get("*/api/v1/events", () =>
        HttpResponse.json(
          { code: "internal_error", message: "Service indisponible.", details: [] },
          { status: 500 },
        ),
      ),
    );
    renderApp(ROUTE);
    expect(await screen.findByText("Service indisponible.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Réessayer" })).toBeInTheDocument();
  });

  it.each(["fleet", "manager"] as const)(
    "lecture seule pour %s : aucun bouton de déclaration",
    async (role) => {
      loginAs(role);
      renderApp(ROUTE);
      expect(await rows()).toHaveLength(13);
      expect(screen.getByText(/Lecture seule/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Assistant de réaffectation" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Déclarer une pénurie" })).not.toBeInTheDocument();
    },
  );
});

describe("Journal des événements — assistant de réaffectation", () => {
  it("panne de camion : incident → tournée (RM-19) → camion → confirmation, corps exact de la requête", async () => {
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    await rows();
    await user.click(screen.getByRole("button", { name: "Assistant de réaffectation" }));
    const dialog = await screen.findByRole("dialog", { name: "Assistant de réaffectation" });
    const next = () => user.click(within(dialog).getByRole("button", { name: "Suivant" }));

    // Étape 1 : panne de camion présélectionnée.
    expect(within(dialog).getByRole("radio", { name: /Camion en panne/ })).toBeChecked();
    await next();

    // Étape 2 : tournées des plans publiés ; une tournée sans arrêt « à livrer » n'est pas sélectionnable.
    const trip1 = await within(dialog).findByRole("radio", {
      name: /Tournée n° 1 — LT 782 KD — Alain Fotso/,
    });
    expect(within(dialog).getByRole("radio", { name: /Tournée n° 3/ })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Suivant" })).toBeDisabled();
    await user.click(trip1);
    const rm19 = within(dialog).getByRole("region", { name: /RM-19/ });
    expect(within(rm19).getByText("Arrêts transférés (2)")).toBeInTheDocument();
    expect(
      within(rm19).getByText(/Arrêt déjà traité, conservé sur la tournée d'origine \(1\)/),
    ).toBeInTheDocument();
    expect(within(rm19).getByText("OLA Deido")).toBeInTheDocument();
    await next();

    // Étape 3 : options de remplacement demandées pour cette tournée ; un camion non affectable est grisé.
    const truck = await within(dialog).findByRole("radio", { name: /LT 608 EM/ });
    expect(scenario.optionQueries.at(-1)).toEqual({ trip_id: SAMPLE_TRIP_IDS[0], kind: "truck" });
    expect(within(dialog).getByRole("radio", { name: /LT 456 CD/ })).toBeDisabled();
    expect(within(dialog).getByText(/En maintenance/)).toBeInTheDocument();
    await user.click(truck);
    await next();

    // Étape 4 : récapitulatif puis confirmation.
    const recap = within(dialog).getByRole("region", { name: "Récapitulatif" });
    expect(within(recap).getByText("LT 608 EM")).toBeInTheDocument();
    expect(within(recap).getByText("Inchangé")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Confirmer la réaffectation" }));

    expect(await within(dialog).findByText(/Réaffectation enregistrée/)).toBeInTheDocument();
    expect(scenario.received).toEqual([
      {
        path: "/events/truck-breakdown",
        body: { trip_id: SAMPLE_TRIP_IDS[0], replacement_truck_id: scenario.options.trucks[0].id },
      },
    ]);
    expect(within(dialog).getByText(/nouvelle version du plan \(v2\)/)).toBeInTheDocument();
    expect(within(dialog).getByText(/2 arrêts transférés\./)).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Ouvrir la nouvelle version du plan" })).toHaveAttribute(
      "href",
      `/plan?plan=${SAMPLE_NEW_PLAN_ID}&day=${DAY}`,
    );
    // Le fil est rechargé : l'événement apparaît.
    await waitFor(() => expect(screen.getAllByTestId("event-row")).toHaveLength(14));
  });

  it("panne de camion avec changement de chauffeur : `replacement_driver_id` transmis", async () => {
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    await rows();
    await user.click(screen.getByRole("button", { name: "Assistant de réaffectation" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Suivant" }));
    await user.click(await within(dialog).findByRole("radio", { name: /Tournée n° 2/ }));
    await user.click(within(dialog).getByRole("button", { name: "Suivant" }));
    await user.click(await within(dialog).findByRole("radio", { name: /LT 123 AB/ }));
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Chauffeur" }), "Jean Mbarga");
    await user.click(within(dialog).getByRole("button", { name: "Suivant" }));
    await user.click(within(dialog).getByRole("button", { name: "Confirmer la réaffectation" }));
    await within(dialog).findByText(/Réaffectation enregistrée/);
    expect(scenario.received[0]).toEqual({
      path: "/events/truck-breakdown",
      body: {
        trip_id: SAMPLE_TRIP_IDS[1],
        replacement_truck_id: scenario.options.trucks[1].id,
        replacement_driver_id: scenario.options.drivers[1].id,
      },
    });
  });

  it("chauffeur indisponible : choix du remplaçant, corps `{trip_id, replacement_driver_id}`", async () => {
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    await rows();
    await user.click(screen.getByRole("button", { name: "Assistant de réaffectation" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: /Chauffeur indisponible/ }));
    await user.click(within(dialog).getByRole("button", { name: "Suivant" }));
    await user.click(await within(dialog).findByRole("radio", { name: /Tournée n° 2/ }));
    expect(within(dialog).getByText(/Aucun arrêt n'a encore été livré/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Suivant" }));
    const driver = await within(dialog).findByRole("radio", { name: /Hervé Ndjock/ });
    expect(scenario.optionQueries.at(-1)).toEqual({ trip_id: SAMPLE_TRIP_IDS[1], kind: "driver" });
    expect(within(dialog).getByRole("radio", { name: /Paul Atangana/ })).toBeDisabled();
    await user.click(driver);
    await user.click(within(dialog).getByRole("button", { name: "Suivant" }));
    await user.click(within(dialog).getByRole("button", { name: "Confirmer la réaffectation" }));
    await within(dialog).findByText(/Réaffectation enregistrée/);
    expect(scenario.received).toEqual([
      {
        path: "/events/driver-unavailable",
        body: { trip_id: SAMPLE_TRIP_IDS[1], replacement_driver_id: scenario.options.drivers[0].id },
      },
    ]);
  });

  it("refus 409 : message du serveur, explication et règle en cause, sans fermer l'assistant", async () => {
    server.use(
      http.post("*/api/v1/events/truck-breakdown", () =>
        HttpResponse.json(
          {
            code: "rule_violation",
            message: "Le camion de remplacement n'est pas affectable à cette tournée.",
            details: [
              {
                rule_code: "RM-04",
                severity: "blocking",
                message: "Le camion LT 608 EM est déjà engagé sur une autre tournée à cette heure.",
              },
            ],
          },
          { status: 409 },
        ),
      ),
    );
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    await rows();
    await user.click(screen.getByRole("button", { name: "Assistant de réaffectation" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Suivant" }));
    await user.click(await within(dialog).findByRole("radio", { name: /Tournée n° 1/ }));
    await user.click(within(dialog).getByRole("button", { name: "Suivant" }));
    await user.click(await within(dialog).findByRole("radio", { name: /LT 608 EM/ }));
    await user.click(within(dialog).getByRole("button", { name: "Suivant" }));
    await user.click(within(dialog).getByRole("button", { name: "Confirmer la réaffectation" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Réaffectation refusée");
    expect(alert).toHaveTextContent("Le camion de remplacement n'est pas affectable à cette tournée.");
    expect(alert).toHaveTextContent(/Le serveur a refusé la réaffectation/);
    expect(within(dialog).getByText("RM-04")).toBeInTheDocument();
    expect(within(dialog).getByText(/déjà engagé sur une autre tournée/)).toBeInTheDocument();
    // On peut revenir en arrière et corriger le choix.
    expect(within(dialog).getByRole("button", { name: "Retour" })).toBeEnabled();
  });
});

describe("Journal des événements — pénurie produit", () => {
  it("déclaration : corps exact, tournées impactées et choix du dispatcher (F6.3)", async () => {
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    await rows();
    await user.click(screen.getByRole("button", { name: "Déclarer une pénurie" }));
    const dialog = await screen.findByRole("dialog", { name: "Déclarer une pénurie produit" });

    // Validation locale : rien n'est envoyé tant que le formulaire est incomplet.
    await user.click(await within(dialog).findByRole("button", { name: "Déclarer" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Dépôt, produit et stock sont obligatoires.");
    expect(scenario.received).toHaveLength(0);

    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Dépôt" }), scenario.refs.depot.id);
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Produit" }), "Gasoil");
    await user.type(within(dialog).getByRole("textbox", { name: "Nouveau stock disponible" }), "15000");
    await user.click(within(dialog).getByRole("button", { name: "Déclarer" }));

    expect(await within(dialog).findByText(/Stock mis à jour/)).toBeInTheDocument();
    expect(scenario.received).toEqual([
      {
        path: "/events/product-shortage",
        body: {
          depot_id: scenario.refs.depot.id,
          product_id: scenario.refs.products.GASOIL,
          new_available_l: 15000,
        },
      },
    ]);
    const impacted = within(dialog).getAllByTestId("impacted-trip");
    expect(impacted).toHaveLength(1);
    expect(within(impacted[0]).getByText("Tournée n° 2 · LT 915 GH")).toBeInTheDocument();
    expect(within(impacted[0]).getByText(/Prévu 19\s000 L · Manque 4\s000 L/)).toBeInTheDocument();
    expect(within(impacted[0]).getByRole("link", { name: "Réduire" })).toHaveAttribute(
      "href",
      `/plan?plan=${scenario.plan.id}&day=${DAY}&trip=${SAMPLE_TRIP_IDS[1]}`,
    );
    expect(within(impacted[0]).getByRole("link", { name: "Reporter" })).toHaveAttribute(
      "href",
      `/commandes?day=${DAY}`,
    );
    expect(within(impacted[0]).getByRole("link", { name: "Changer de dépôt" })).toBeInTheDocument();
  });

  it("stock suffisant : aucune tournée impactée", async () => {
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    await rows();
    await user.click(screen.getByRole("button", { name: "Déclarer une pénurie" }));
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(
      await within(dialog).findByRole("combobox", { name: "Dépôt" }),
      scenario.refs.depot.id,
    );
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Produit" }), "Super sans plomb");
    await user.type(within(dialog).getByRole("textbox", { name: "Nouveau stock disponible" }), "250000");
    await user.click(within(dialog).getByRole("button", { name: "Déclarer" }));
    expect(await within(dialog).findByText(/Aucune tournée impactée/)).toBeInTheDocument();
  });
});

describe("Journal des événements — rapprochement des formes (api.ts)", () => {
  it("accepte une page ou une liste d'événements", () => {
    const raw = [
      { id: "a", day: DAY, type: "publish", payload: {}, occurred_at: "2027-01-12T05:00:00Z" },
      {
        id: "b",
        day: DAY,
        type: "replan",
        payload: null,
        occurred_at: "2027-01-12T07:00:00Z",
        actor_name: "X",
      },
    ];
    expect(normalizeEvents(raw).map((event) => event.id)).toEqual(["b", "a"]);
    expect(normalizeEvents({ items: raw, total: 2 })[0]).toMatchObject({
      id: "b",
      actor_name: "X",
      payload: {},
    });
    expect(normalizeEvents(null)).toEqual([]);
  });

  it("retrouve la nouvelle version du plan quelle que soit la forme de la réponse", () => {
    expect(normalizeReassignment({ id: "p2", version: 2, trips: [] })).toMatchObject({
      plan_id: "p2",
      plan_version: 2,
    });
    expect(
      normalizeReassignment({ plan_id: "p3", plan_version: 3, transferred_stop_ids: ["s1", "s2"] }),
    ).toEqual({
      plan_id: "p3",
      plan_version: 3,
      transferred_stop_count: 2,
    });
    expect(
      normalizeReassignment({
        event: { plan_id: "p1", payload: { new_plan_id: "p4", new_plan_version: 4 } },
      }),
    ).toMatchObject({ plan_id: "p4", plan_version: 4 });
    expect(normalizeShortage({ event: { payload: { impacted_trips: [{ trip_id: "t", seq: 4 }] } } })).toEqual(
      {
        available_l: null,
        impacted_trips: [
          {
            trip_id: "t",
            plan_id: null,
            trip_seq: 4,
            truck_plate: null,
            driver_name: null,
            planned_l: null,
            shortfall_l: null,
          },
        ],
      },
    );
  });
});
