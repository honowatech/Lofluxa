import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/mocks/db";
import { server } from "@/mocks/server";
import { loginAs, renderApp } from "@/test/utils";

import {
  createEventsScenario,
  eventsHandlers,
  SAMPLE_DRIVER_IDS,
  SAMPLE_NEW_PLAN_ID,
  SAMPLE_SHORTAGE_EVENT_ID,
  SAMPLE_TRIP_IDS,
  SAMPLE_TRUCK_IDS,
  type EventsScenario,
  type SampleRefs,
} from "./mocks";

const DAY = "2027-01-12";
const ROUTE = `/journal?day=${DAY}`;

/** Références prises dans les doublures communes : les listes de dépôts et de produits y sont servies. */
function refs(): SampleRefs {
  const depot = (code: string) => {
    const found = db.depots.find((item) => item.code === code)!;
    return { id: found.id, code: found.code, name: found.name };
  };
  const product = (code: string) => db.products.find((item) => item.code === code)!.id;
  return {
    depot: depot("SCDP-DLA"),
    altDepot: depot("DEP-BON"),
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
    expect(list).toHaveLength(8);
    expect(within(list[0]).getByText("08:47")).toBeInTheDocument();
    expect(within(list[0]).getByText("Pénurie produit")).toBeInTheDocument();
    expect(within(list[7]).getByText("05:48")).toBeInTheDocument();
    expect(screen.getByText(/8 événements/)).toBeInTheDocument();
  });

  it("filtre par type, avec compteurs et cumul des types choisis", async () => {
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    await rows();
    expect(chip(/^Tous 8$/)).toHaveAttribute("aria-pressed", "true");
    expect(chip(/^Chargement 2$/)).toHaveAttribute("aria-pressed", "false");

    await user.click(chip(/^Pénurie produit 1$/));
    expect(await rows()).toHaveLength(1);
    expect(chip(/^Tous 8$/)).toHaveAttribute("aria-pressed", "false");

    await user.click(chip(/^Livraison 3$/));
    expect(await rows()).toHaveLength(4);

    await user.click(chip(/^Tous 8$/));
    expect(await rows()).toHaveLength(8);
  });

  it("reprend le résumé du serveur pour chaque type, avec acteur, tournée, version et lien", async () => {
    loginAs("dispatcher");
    renderApp(ROUTE);
    await rows();
    const loading = screen
      .getByText(/Chargement enregistré \(bon BL-2238\).*hors tolérance \(RM-13\)/)
      .closest("li")!;
    expect(within(loading).getByText("Tournée n° 1 · LT 782 KD")).toBeInTheDocument();
    expect(within(loading).getByText("Plan v1")).toBeInTheDocument();
    expect(within(loading).getByText("par Brigitte Ngo Bassa")).toBeInTheDocument();
    expect(within(loading).getByRole("link", { name: "Voir le chargement" })).toHaveAttribute(
      "href",
      `/chargement?trip=${SAMPLE_TRIP_IDS[0]}&day=${DAY}`,
    );
    const skipped = screen
      .getByText("Arrêt 2 (ST-MAKEP) non livré : Station fermée à l'arrivée.")
      .closest("li")!;
    expect(within(skipped).getByRole("link", { name: "Suivre la tournée" })).toHaveAttribute(
      "href",
      `/suivi?trip=${SAMPLE_TRIP_IDS[2]}&day=${DAY}`,
    );
    const publish = screen.getByText("Version 1 publiée.").closest("li")!;
    expect(within(publish).getByRole("link", { name: "Voir le plan" })).toHaveAttribute(
      "href",
      `/plan?plan=${scenario.plan.id}&day=${DAY}`,
    );
    // Pénurie déclarée : état de l'alerte et action de traitement pour le dispatcher.
    const shortage = screen
      .getByText(/Stock de GASOIL au dépôt SCDP-DLA : .*1 tournée\(s\) impactée\(s\)/)
      .closest("li")!;
    expect(within(shortage).getByText("À traiter")).toBeInTheDocument();
    expect(within(shortage).getByRole("button", { name: "Traiter la pénurie" })).toBeInTheDocument();
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
    "lecture seule pour %s : ni assistant, ni déclaration, ni traitement",
    async (role) => {
      loginAs(role);
      const { user } = renderApp(ROUTE);
      expect(await rows()).toHaveLength(8);
      expect(screen.getByText(/Lecture seule/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Assistant de réaffectation" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Déclarer une pénurie" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Traiter la pénurie" })).not.toBeInTheDocument();
      // L'impact d'une pénurie reste consultable, sans décision possible.
      await user.click(screen.getByRole("button", { name: "Voir l'impact" }));
      const dialog = await screen.findByRole("dialog");
      expect(await within(dialog).findByTestId("impacted-trip")).toBeInTheDocument();
      expect(within(dialog).queryByRole("combobox")).not.toBeInTheDocument();
      expect(
        within(dialog).getByText("Le traitement d'une pénurie est réservé au dispatcher."),
      ).toBeInTheDocument();
    },
  );

  it("déclaration d'une pénurie réservée à Supply et à l'administrateur : absente pour le dispatcher", async () => {
    loginAs("dispatcher");
    const { unmount } = renderApp(ROUTE);
    await rows();
    expect(screen.getByRole("button", { name: "Assistant de réaffectation" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Déclarer une pénurie" })).not.toBeInTheDocument();
    unmount();

    loginAs("admin");
    renderApp(ROUTE);
    await rows();
    expect(screen.getByRole("button", { name: "Déclarer une pénurie" })).toBeInTheDocument();
  });
});

async function openAssistant(user: ReturnType<typeof renderApp>["user"]) {
  await rows();
  await user.click(screen.getByRole("button", { name: "Assistant de réaffectation" }));
  const dialog = await screen.findByRole("dialog", { name: "Assistant de réaffectation" });
  const next = async () => {
    const button = within(dialog).getByRole("button", { name: "Suivant" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
  };
  return { dialog, next };
}

describe("Journal des événements — assistant de réaffectation", () => {
  it("panne de camion : incident → tournée (RM-19) → camion → confirmation, corps exact de la requête", async () => {
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    const { dialog, next } = await openAssistant(user);

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
    const rm19 = await within(dialog).findByRole("region", { name: /RM-19/ });
    expect(within(rm19).getByText("Arrêts transférés (2)")).toBeInTheDocument();
    expect(
      within(rm19).getByText(/Arrêt déjà traité, conservé sur la tournée d'origine \(1\)/),
    ).toBeInTheDocument();
    expect(within(rm19).getByText("OLA Deido")).toBeInTheDocument();
    await next();

    // Étape 3 : camions avec motif d'inéligibilité (code RM + message du serveur).
    const truck = await within(dialog).findByRole("radio", { name: /LT 608 EM/ });
    const maintenance = within(dialog).getByRole("radio", { name: /LT 456 CD/ });
    expect(maintenance).toBeDisabled();
    expect(maintenance.closest("label")).toHaveTextContent("RM-04 — Camion en maintenance.");
    expect(within(dialog).getByRole("button", { name: "Suivant" })).toBeDisabled();
    await user.click(truck);
    // Les chauffeurs sont réévalués pour ce camion ; le chauffeur proposé par le serveur est retenu par défaut.
    expect(
      await within(dialog).findByRole("radio", { name: /Chauffeur proposé : Alain Fotso/ }),
    ).toBeChecked();
    expect(scenario.optionQueries.at(-1)).toEqual({
      trip_id: SAMPLE_TRIP_IDS[0],
      replacement_truck_id: SAMPLE_TRUCK_IDS.free,
    });
    const resting = within(dialog).getByRole("radio", { name: /Paul Atangana/ });
    expect(resting).toBeDisabled();
    expect(resting.closest("label")).toHaveTextContent("RM-03 — Chauffeur en repos.");
    await next();

    // Étape 4 : récapitulatif puis confirmation.
    const recap = within(dialog).getByRole("region", { name: "Récapitulatif" });
    expect(within(recap).getByText("LT 608 EM")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Confirmer la réaffectation" }));

    expect(await within(dialog).findByText("Réaffectation enregistrée")).toBeInTheDocument();
    expect(scenario.received).toEqual([
      {
        path: "/events/truck-breakdown",
        body: { trip_id: SAMPLE_TRIP_IDS[0], replacement_truck_id: SAMPLE_TRUCK_IDS.free },
      },
    ]);
    expect(within(dialog).getByText(/Panne du camion LT 782 KD \(tournée 1\)/)).toBeInTheDocument();
    expect(
      within(dialog).getByText(/2 arrêts transférés, 1 conservé sur la tournée d'origine \(RM-19\)\./),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Version 2 du plan publiée.")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Ouvrir le plan (v2)" })).toHaveAttribute(
      "href",
      `/plan?plan=${SAMPLE_NEW_PLAN_ID}&day=${DAY}`,
    );
    // Le fil est rechargé : l'événement apparaît.
    await waitFor(() => expect(screen.getAllByTestId("event-row")).toHaveLength(9));
  });

  it("chauffeur obligatoire quand `driver_required` ; chauffeur et motif transmis", async () => {
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    const { dialog, next } = await openAssistant(user);
    await next();
    await user.click(await within(dialog).findByRole("radio", { name: /Tournée n° 2/ }));
    await next();
    await user.click(await within(dialog).findByRole("radio", { name: /LT 271 NP/ }));
    expect(
      await within(dialog).findByText(
        "Ce camion n'a pas de chauffeur pour la journée : choisissez un chauffeur.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("radio", { name: /Chauffeur proposé/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Suivant" })).toBeDisabled();
    await user.click(within(dialog).getByRole("radio", { name: /^Jean Mbarga/ }));
    await next();
    await user.type(within(dialog).getByRole("textbox", { name: /Motif/ }), "Crevaison à Ndokoti");
    await user.click(within(dialog).getByRole("button", { name: "Confirmer la réaffectation" }));
    await within(dialog).findByText("Réaffectation enregistrée");
    expect(scenario.received[0]).toEqual({
      path: "/events/truck-breakdown",
      body: {
        trip_id: SAMPLE_TRIP_IDS[1],
        replacement_truck_id: SAMPLE_TRUCK_IDS.driverRequired,
        replacement_driver_id: SAMPLE_DRIVER_IDS.jean,
        reason: "Crevaison à Ndokoti",
      },
    });
  });

  it("chauffeur indisponible : choix du remplaçant, corps `{trip_id, replacement_driver_id}`", async () => {
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    const { dialog, next } = await openAssistant(user);
    await user.click(within(dialog).getByRole("radio", { name: /Chauffeur indisponible/ }));
    await next();
    await user.click(await within(dialog).findByRole("radio", { name: /Tournée n° 2/ }));
    expect(await within(dialog).findByText(/Aucun arrêt n'a encore été livré/)).toBeInTheDocument();
    await next();
    const driver = await within(dialog).findByRole("radio", { name: /Hervé Ndjock/ });
    // Le chauffeur actuel de la tournée n'est pas proposé comme remplaçant.
    expect(within(dialog).queryByRole("radio", { name: /Emmanuel Tchoua/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /Paul Atangana/ })).toBeDisabled();
    await user.click(driver);
    await next();
    await user.click(within(dialog).getByRole("button", { name: "Confirmer la réaffectation" }));
    await within(dialog).findByText("Réaffectation enregistrée");
    expect(scenario.received).toEqual([
      {
        path: "/events/driver-unavailable",
        body: { trip_id: SAMPLE_TRIP_IDS[1], replacement_driver_id: SAMPLE_DRIVER_IDS.herve },
      },
    ]);
  });

  it("nouvelle version laissée en brouillon : violations bloquantes affichées, lien vers le plan", async () => {
    scenario.blockingViolations = [
      {
        rule_code: "RM-10",
        severity: "blocking",
        message: "Tournée 4 : la station ST-YASSA est fermée à 20:40.",
        trip_seq: 4,
      },
    ];
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    const { dialog, next } = await openAssistant(user);
    await next();
    await user.click(await within(dialog).findByRole("radio", { name: /Tournée n° 2/ }));
    await next();
    await user.click(await within(dialog).findByRole("radio", { name: /LT 123 AB/ }));
    await within(dialog).findByRole("radio", { name: /Chauffeur proposé : Jean Mbarga/ });
    await next();
    await user.click(within(dialog).getByRole("button", { name: "Confirmer la réaffectation" }));
    await within(dialog).findByText("Réaffectation enregistrée");
    expect(
      within(dialog).getByText(/Version 2 du plan laissée en brouillon : 1 violation bloquante à corriger/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("RM-10")).toBeInTheDocument();
    expect(within(dialog).getByText(/ST-YASSA est fermée/)).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Ouvrir le plan (v2)" })).toBeInTheDocument();
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
                rule_code: "RM-14",
                severity: "blocking",
                message:
                  "Camion LT 608 EM : 3 chargements prévus au dépôt SCDP-DLA dans la journée, maximum 2.",
              },
            ],
          },
          { status: 409 },
        ),
      ),
    );
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    const { dialog, next } = await openAssistant(user);
    await next();
    await user.click(await within(dialog).findByRole("radio", { name: /Tournée n° 1/ }));
    await next();
    await user.click(await within(dialog).findByRole("radio", { name: /LT 608 EM/ }));
    await within(dialog).findByRole("radio", { name: /Chauffeur proposé/ });
    await next();
    await user.click(within(dialog).getByRole("button", { name: "Confirmer la réaffectation" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Réaffectation refusée");
    expect(alert).toHaveTextContent("Le camion de remplacement n'est pas affectable à cette tournée.");
    expect(alert).toHaveTextContent(/Le serveur a refusé la réaffectation/);
    expect(within(dialog).getByText("RM-14")).toBeInTheDocument();
    expect(within(dialog).getByText(/3 chargements prévus/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Retour" })).toBeEnabled();
  });

  it("tournée bloquée par le serveur (`blocked_reason`) : l'étape ne se franchit pas", async () => {
    // Le plan lu à l'ouverture montre encore un arrêt à livrer, mais le serveur sait que tout est fait.
    const stale = structuredClone(scenario.plan);
    scenario.plan.trips[0].stops.forEach((stop) => (stop.status = "delivered"));
    server.use(http.get("*/api/v1/plans/:id", () => HttpResponse.json(stale)));
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    const { dialog, next } = await openAssistant(user);
    await next();
    await user.click(await within(dialog).findByRole("radio", { name: /Tournée n° 1/ }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "La tournée 1 n'a plus aucun arrêt en attente de livraison.",
    );
    expect(within(dialog).getByRole("button", { name: "Suivant" })).toBeDisabled();
  });
});

describe("Journal des événements — pénurie produit", () => {
  it("déclaration (admin) : corps exact avec le jour J, stocks et tournées impactées, puis accès au traitement", async () => {
    loginAs("admin");
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
    const stock = within(dialog).getByRole("textbox", { name: "Nouveau stock disponible" });

    // Refus du serveur expliqué (422 `stock_below_loaded`).
    await user.type(stock, "15000");
    await user.click(within(dialog).getByRole("button", { name: "Déclarer" }));
    expect(
      await within(dialog).findByText(/est inférieur au volume déjà chargé aujourd'hui \(22 000 L\)/),
    ).toBeInTheDocument();

    await user.clear(stock);
    await user.type(stock, "30000");
    await user.click(within(dialog).getByRole("button", { name: "Déclarer" }));
    const overview = await within(dialog).findByTestId("shortage-overview");
    expect(scenario.received.at(-1)).toEqual({
      path: "/events/product-shortage",
      body: {
        depot_id: scenario.refs.depot.id,
        product_id: scenario.refs.products.GASOIL,
        new_available_l: 30000,
        day: DAY,
      },
    });
    expect(overview).toHaveTextContent("GASOIL au dépôt SCDP-DLA");
    expect(overview).toHaveTextContent("À traiter");
    expect(overview).toHaveTextContent(/Déjà chargé22\s000 L/);
    expect(overview).toHaveTextContent(/Reste8\s000 L/);
    expect(overview).toHaveTextContent(/Manque11\s000 L/);

    // L'administrateur peut enchaîner sur le traitement.
    await user.click(within(dialog).getByRole("button", { name: "Traiter la pénurie" }));
    const impact = await screen.findByRole("dialog", { name: "Pénurie produit — tournées impactées" });
    expect(await within(impact).findByTestId("impacted-trip")).toHaveTextContent("Tournée n° 2 · LT 915 GH");
  });

  it("stock suffisant : aucune tournée impactée", async () => {
    loginAs("admin");
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
    expect(within(dialog).getByTestId("shortage-overview")).toHaveTextContent("Sans impact");
    expect(within(dialog).queryByRole("button", { name: "Traiter la pénurie" })).not.toBeInTheDocument();
  });

  it("résolution par le dispatcher : options du serveur, changement de dépôt, corps exact, résultat", async () => {
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    await rows();
    await user.click(screen.getByRole("button", { name: "Traiter la pénurie" }));
    const dialog = await screen.findByRole("dialog", { name: "Pénurie produit — tournées impactées" });
    const trip = await within(dialog).findByTestId("impacted-trip");
    expect(trip).toHaveTextContent("Tournée n° 2 · LT 915 GH");
    expect(trip).toHaveTextContent(/Prévu 19\s000 L · Couvert 15\s000 L · Manque 4\s000 L/);
    expect(trip).toHaveTextContent(/2 commandes du produit : OLA Logbaba 11\s000 L · OLA Yassa 8\s000 L/);

    // Rien de choisi : pas d'envoi.
    await user.click(within(dialog).getByRole("button", { name: "Appliquer les décisions" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Choisissez une décision pour au moins une tournée.",
    );

    const decision = within(dialog).getByRole("combobox", { name: "Décision pour la tournée n° 2" });
    expect(
      within(decision)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "Ne pas traiter maintenant",
      "Réduire au volume couvert",
      "Reporter les commandes du produit",
      "Changer de dépôt",
    ]);
    // Changer de dépôt : le dépôt est obligatoire.
    await user.selectOptions(decision, "change_depot");
    await user.click(within(dialog).getByRole("button", { name: "Appliquer les décisions" }));
    expect(within(dialog).getByText("Choisissez le nouveau dépôt.")).toBeInTheDocument();
    expect(scenario.received).toHaveLength(0);
    const depot = within(dialog).getByRole("combobox", { name: "Nouveau dépôt pour la tournée n° 2" });
    expect(within(depot).getAllByRole("option")[1].textContent).toMatch(
      /^DEP-BON — .* · reste 60\s000\sL · suffisant$/,
    );
    await user.selectOptions(depot, scenario.refs.altDepot.id);
    await user.click(within(dialog).getByRole("button", { name: "Appliquer les décisions" }));

    expect(await within(dialog).findByText("Décisions appliquées")).toBeInTheDocument();
    expect(scenario.received).toEqual([
      {
        path: `/events/${SAMPLE_SHORTAGE_EVENT_ID}/resolve`,
        body: {
          resolutions: [
            { trip_id: SAMPLE_TRIP_IDS[1], action: "change_depot", depot_id: scenario.refs.altDepot.id },
          ],
        },
      },
    ]);
    expect(within(dialog).getByTestId("shortage-overview")).toHaveTextContent("Résolue");
    expect(within(dialog).getByText("Version 2 du plan publiée.")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Ouvrir le plan (v2)" })).toHaveAttribute(
      "href",
      `/plan?plan=${SAMPLE_NEW_PLAN_ID}&day=${DAY}`,
    );
    expect(within(dialog).getByText(/La pénurie est résolue/)).toBeInTheDocument();
    // Le fil reflète le nouvel état de l'alerte.
    await waitFor(() =>
      expect(screen.getByText("Résolue", { selector: "li[data-type] *" })).toBeInTheDocument(),
    );
  });

  it("résolution « réduire » : seuls `trip_id` et `action` sont envoyés (volumes par défaut du serveur)", async () => {
    loginAs("dispatcher");
    const { user } = renderApp(ROUTE);
    await rows();
    await user.click(screen.getByRole("button", { name: "Traiter la pénurie" }));
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(
      await within(dialog).findByRole("combobox", { name: "Décision pour la tournée n° 2" }),
      "reduce",
    );
    expect(within(dialog).getByText(/Réduction proportionnelle/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Appliquer les décisions" }));
    await within(dialog).findByText("Décisions appliquées");
    expect(scenario.received[0].body).toEqual({
      resolutions: [{ trip_id: SAMPLE_TRIP_IDS[1], action: "reduce" }],
    });
  });
});
