import { focusManager } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { server } from "@/mocks/server";
import { loginAs, renderApp } from "@/test/utils";

import { usePlanStore } from "./store";
import { asNewVersion, DAY, makePlan, unserved, violation } from "./testing/fixtures";
import { planApi, SERVER_DISTANCE_M, type PlanApiState } from "./testing/handlers";
import type { Plan } from "./types";

const URL = `/plan?day=${DAY}`;

/** Relecture des données affichées sans attendre le rythme normal (60 s) : comme au retour sur l'onglet. */
function refetchNow() {
  focusManager.setFocused(false);
  focusManager.setFocused(true);
}

function setup(plans: Plan[] = [makePlan()], extra: Partial<PlanApiState> = {}): PlanApiState {
  const state: PlanApiState = { plans, calls: [], ...extra };
  server.use(...planApi(state));
  return state;
}

const detail = () => screen.getByRole("region", { name: "Détail de la tournée" });
const tripList = () => screen.getByRole("region", { name: "Liste des tournées" });
const loaded = () => screen.findByRole("region", { name: "Liste des tournées" });
const stopNames = (zone: HTMLElement) =>
  Array.from(zone.querySelectorAll("[data-stop-row]")).map((row) => row.getAttribute("aria-label"));
const stopRow = (zone: HTMLElement, name: RegExp) =>
  Array.from(zone.querySelectorAll<HTMLElement>("[data-stop-row]")).find((row) =>
    name.test(row.getAttribute("aria-label") ?? ""),
  ) as HTMLElement;
const writes = (state: PlanApiState) => state.calls.filter((call) => call.method === "POST");

async function openTrip(user: ReturnType<typeof renderApp>["user"], seq: number) {
  await user.click(await screen.findByRole("button", { name: `Afficher la tournée ${seq}` }));
}

beforeEach(() => {
  usePlanStore.getState().reset();
  usePlanStore.setState({ view: "map" });
  window.sessionStorage.clear();
});

describe("Plan de tournées — lecture", () => {
  it("affiche les tournées, le détail avec heures de Douala, le chargement et la carte", async () => {
    loginAs("dispatcher");
    setup();
    const { user } = renderApp(URL);
    const list = within(await screen.findByRole("region", { name: "Liste des tournées" }));
    expect(list.getByText("LT-401-AA")).toBeInTheDocument();
    expect(list.getByText("Alain Nkoulou")).toBeInTheDocument();
    expect(list.getAllByText("08:15 → 10:30")).toHaveLength(2); // 07:15Z → 08:15 à Douala (RM-20)
    expect(screen.getByText("Distances approchées")).toBeInTheDocument();
    expect(screen.getByText("5 / 5")).toBeInTheDocument();

    await openTrip(user, 1);
    expect(stopNames(detail())).toEqual([
      "Arrêt 1 : OLA Akwa",
      "Arrêt 2 : OLA Bonanjo",
      "Arrêt 3 : OLA Deido",
    ]);
    expect(within(detail()).getByText("08:30 – 08:50")).toBeInTheDocument();
    expect(within(detail()).getByText("Urgent")).toBeInTheDocument();
    expect(
      within(detail()).getByLabelText(/Compartiment 1 : Super, 5.880.L sur 6.000.L/),
    ).toBeInTheDocument();

    const map = screen.getByRole("figure", { name: "Carte du plan de tournées" });
    expect(map.querySelectorAll("[data-stop]")).toHaveLength(4);
    expect(map.querySelectorAll("[data-route]")).toHaveLength(2);
    expect(screen.getByTestId("violations-panel")).toHaveTextContent("Aucune violation.");
  });

  it("commandes non servies : urgentes en tête, raison lisible ; violations reliées à la tournée et à l'arrêt", async () => {
    loginAs("dispatcher");
    setup([
      makePlan({
        unserved: [
          unserved("n", "DLA10", "OLA Logbessou", false),
          unserved("u", "DLA09", "OLA Makepe", true),
        ],
        violations: [
          violation("1", "RM-15", "blocking", "Commande urgente non servie : station DLA09."),
          violation("2", "RM-10", "warning", "Arrivée 20 min après la fermeture.", {
            trip_id: "trip-1",
            stop_id: "stop-c",
          }),
        ],
        blocking_count: 1,
        warning_count: 1,
        publishable: false,
      }),
    ]);
    const { user } = renderApp(URL);
    const banner = await screen.findByTestId("unserved-banner");
    expect(banner).toHaveTextContent("2 commandes non servies");
    expect(banner).toHaveTextContent("dont 1 urgente à traiter (RM-15)");
    const items = within(banner).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Urgente");
    expect(items[0]).toHaveTextContent("OLA Makepe");
    expect(items[0]).toHaveTextContent("Stock dépôt insuffisant");

    // Publication désactivée et expliquée.
    expect(screen.getByRole("button", { name: "Publier" })).toBeDisabled();
    expect(
      screen.getByText("Publication impossible : 1 violation bloquante à corriger."),
    ).toBeInTheDocument();

    // Clic sur une violation → tournée et arrêt sélectionnés.
    const panel = screen.getByTestId("violations-panel");
    expect(within(panel).getAllByRole("listitem")[0]).toHaveTextContent("RM-15");
    await user.click(within(panel).getByRole("button", { name: /RM-10/ }));
    expect(stopRow(detail(), /OLA Deido/)).toHaveAttribute("aria-current", "true");
    expect(tripList().querySelector("[data-selected]")).toHaveTextContent("LT-401-AA");
  });

  it("sélection synchronisée : un arrêt cliqué sur la carte sélectionne sa tournée dans la liste et le détail", async () => {
    loginAs("dispatcher");
    setup();
    const { user } = renderApp(URL);
    await loaded();
    const map = screen.getByRole("figure", { name: "Carte du plan de tournées" });
    await user.click(map.querySelector('[data-stop="stop-d"]') as Element);
    expect(within(detail()).getByRole("heading", { name: "Tournée 2" })).toBeInTheDocument();
    expect(tripList().querySelector("[data-selected]")).toHaveTextContent("LT-402-AB");
    expect(stopRow(detail(), /OLA Ndokoti/)).toHaveAttribute("aria-current", "true");
    // Les autres tournées passent en retrait sur la carte ; « Toutes les tournées » rétablit la vue d'ensemble.
    expect(map.querySelector('[data-route="trip-1"]')).toHaveAttribute("opacity", "0.35");
    await user.click(screen.getByRole("button", { name: "Toutes les tournées" }));
    expect(map.querySelector('[data-route="trip-1"]')).toHaveAttribute("opacity", "1");
    // Clic sur le tracé d'une tournée → tournée sélectionnée ; survol → mise en évidence dans la liste.
    await user.hover(map.querySelector('[data-route-hit="trip-1"]') as Element);
    expect(tripList().querySelector("[data-hovered]")).toHaveTextContent("LT-401-AA");
    await user.click(map.querySelector('[data-route-hit="trip-1"]') as Element);
    expect(within(detail()).getByRole("heading", { name: "Tournée 1" })).toBeInTheDocument();
    expect(tripList().querySelector("[data-selected]")).toHaveTextContent("LT-401-AA");
  });

  it("aucun plan pour le jour : renvoi vers l'écran Journée", async () => {
    loginAs("dispatcher");
    setup([]);
    renderApp(URL);
    expect(await screen.findByText("Aucun plan pour cette journée")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Aller à la journée" })).toHaveAttribute(
      "href",
      `/journee?day=${DAY}`,
    );
  });

  it("plusieurs versions le même jour : la version en vigueur s'ouvre, le brouillon se choisit dans le sélecteur", async () => {
    loginAs("dispatcher");
    const published = makePlan({ status: "published", publishable: false });
    const draft = { ...asNewVersion(published), created_at: `${DAY}T06:00:00Z` };
    setup([published, draft]);
    const { user, router } = renderApp(URL);
    const selector = await screen.findByRole("combobox", { name: "Plan et version affichés" });
    // Par défaut : le plan du jour en vigueur ; le brouillon en préparation est signalé.
    expect(selector).toHaveValue("plan-1");
    expect(
      within(selector).getByRole("option", { name: /Plan du jour · Version 1 · Publié, en vigueur/ }),
    ).toBeInTheDocument();
    expect(
      within(selector).getByRole("option", { name: /Plan du jour · Version 2 · Brouillon/ }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/une version 2 est déjà en préparation/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Verrouiller la tournée/ })).not.toBeInTheDocument();
    await user.selectOptions(selector, "plan-2");
    await waitFor(() => expect(router.state.location.search).toContain("plan=plan-2"));
    expect(await screen.findByText(/La version 1 publiée reste la référence du terrain/)).toBeInTheDocument();
  });

  it("sélecteur : la nature de chaque plan est dite (plan du jour, journée de référence, rejeu)", async () => {
    loginAs("dispatcher");
    const reference = makePlan({
      id: "plan-ref",
      root_plan_id: "plan-ref",
      kind: "manual_reference",
      label: "Journée A du 12/01",
      created_at: `${DAY}T03:00:00Z`,
    });
    const replay = makePlan({
      id: "plan-replay",
      root_plan_id: "plan-replay",
      kind: "replay",
      created_at: `${DAY}T03:30:00Z`,
    });
    setup([reference, replay, makePlan({ status: "published", publishable: false })]);
    renderApp(URL);
    const selector = await screen.findByRole("combobox", { name: "Plan et version affichés" });
    // Le plan du jour s'ouvre, pas la journée de référence ni son rejeu (pourtant « Version 1 · Brouillon »).
    expect(selector).toHaveValue("plan-1");
    expect(
      within(selector)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "Journée de référence · Version 1 · Brouillon · 04:00",
      "Rejeu · Version 1 · Brouillon · 04:30",
      "Plan du jour · Version 1 · Publié, en vigueur · 05:42",
    ]);
    expect(
      within(selector).getByRole("group", {
        name: "Journée de référence — « Journée A du 12/01 », 2 tournées",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("En vigueur")).toBeInTheDocument();
  });

  it("deux plans publiés le même jour : le plus important s'ouvre, chacun garde ses tournées", async () => {
    loginAs("dispatcher");
    const main = makePlan({ status: "published", publishable: false });
    const second = makePlan({
      id: "plan-b",
      root_plan_id: "plan-b",
      status: "published",
      publishable: false,
      created_at: `${DAY}T08:00:00Z`,
    });
    // Plan des reliquats : une seule tournée, publié après le plan principal.
    second.trips = [
      {
        ...second.trips[1],
        id: "trip-b1",
        seq: 1,
        stops: second.trips[1].stops.map((s) => ({ ...s, id: "stop-b1" })),
      },
    ];
    second.metrics = { ...second.metrics, trips_count: 1 } as typeof second.metrics;
    setup([main, second]);
    const { user } = renderApp(URL);
    const selector = await screen.findByRole("combobox", { name: "Plan et version affichés" });
    expect(selector).toHaveValue("plan-1");
    expect(
      within(selector)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "Plan du jour 1 (2 tournées) · Version 1 · Publié, en vigueur · 05:42",
      "Plan du jour 2 (1 tournée) · Version 1 · Publié, en vigueur · 09:00",
    ]);
    expect(screen.getByTestId("plans-in-force")).toHaveTextContent("2 plans du jour publiés ce jour");
    expect(tripList().querySelectorAll("[data-trip-card]")).toHaveLength(2);

    await user.selectOptions(selector, "plan-b");
    await waitFor(() => expect(screen.getByTestId("screen-plan")).toHaveAttribute("data-plan-id", "plan-b"));
    // Seules les tournées du plan choisi : liste, carte et sélection repartent de zéro.
    expect(tripList().querySelectorAll("[data-trip-card]")).toHaveLength(1);
    const map = screen.getByRole("figure", { name: "Carte du plan de tournées" });
    expect(map.querySelectorAll("[data-route]")).toHaveLength(1);
    expect(map.querySelector('[data-route="trip-1"]')).toBeNull();
    expect(tripList().querySelector("[data-selected]")).toBeNull();
  });

  it("libellé et plan en vigueur fournis par le serveur (display_label, is_current) : utilisés tels quels", async () => {
    loginAs("dispatcher");
    const main = {
      ...makePlan({ status: "published", publishable: false }),
      display_label: "Plan du jour — version 3 publiée",
      is_current: false,
    };
    const other = {
      ...makePlan({
        id: "plan-b",
        root_plan_id: "plan-b",
        status: "published",
        publishable: false,
        created_at: `${DAY}T08:00:00Z`,
      }),
      display_label: "Plan complémentaire — version 1 publiée",
      is_current: true,
    };
    other.metrics = { ...other.metrics, trips_count: 1 } as typeof other.metrics;
    setup([main, other]);
    renderApp(URL);
    const selector = await screen.findByRole("combobox", { name: "Plan et version affichés" });
    // `is_current` l'emporte sur la déduction « publié + le plus de tournées ».
    await waitFor(() => expect(selector).toHaveValue("plan-b"));
    expect(
      within(selector)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "Plan du jour — version 3 publiée · 05:42",
      "Plan complémentaire — version 1 publiée · 09:00",
    ]);
  });

  it("rôle sans droit d'écriture : lecture seule", async () => {
    loginAs("manager");
    setup();
    const { user } = renderApp(URL);
    await openTrip(user, 1);
    expect(screen.getByText(/votre rôle ne permet pas de modifier le plan/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publier" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Recalculer en conservant" })).not.toBeInTheDocument();
    expect(within(detail()).queryByRole("button", { name: /Déplacer l'arrêt/ })).not.toBeInTheDocument();
    expect(within(detail()).queryByRole("combobox")).not.toBeInTheDocument();
    // Alt+↓ ne fait rien.
    stopRow(detail(), /OLA Akwa/).focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(stopNames(detail())[0]).toBe("Arrêt 1 : OLA Akwa");
  });

  it("journée de référence et version archivée : lecture seule, non publiables", async () => {
    loginAs("dispatcher");
    setup([makePlan({ kind: "manual_reference" })]);
    const first = renderApp(URL);
    expect(await screen.findByText(/Journée de référence importée/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publier" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Verrouiller la tournée/ })).not.toBeInTheDocument();
    first.unmount();

    setup([makePlan({ status: "archived", publishable: false })]);
    renderApp(URL);
    expect(await screen.findByText(/Version archivée, en lecture seule/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publier" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Feuilles de route" })).toBeInTheDocument();
  });
});

describe("Plan de tournées — édition au clavier", () => {
  it("Alt+↓ réordonne : état optimiste, appel reorder, puis plan recalculé par le serveur ; le focus suit l'arrêt", async () => {
    loginAs("dispatcher");
    const state = setup([makePlan()], { delayMs: 60 });
    const { user } = renderApp(URL);
    await openTrip(user, 1);
    stopRow(detail(), /OLA Akwa/).focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");

    // Optimiste : l'ordre change avant la réponse.
    expect(stopNames(detail())).toEqual([
      "Arrêt 1 : OLA Bonanjo",
      "Arrêt 2 : OLA Akwa",
      "Arrêt 3 : OLA Deido",
    ]);
    expect(screen.getByTestId("plan-sync")).toHaveAttribute("data-state", "saving");

    await waitFor(() => expect(screen.getByTestId("plan-sync")).toHaveAttribute("data-state", "saved"));
    expect(writes(state)).toEqual([
      {
        method: "POST",
        path: "/plans/plan-1/trips/trip-1/reorder",
        body: { stop_ids: ["stop-b", "stop-a", "stop-c"] },
      },
    ]);
    // Valeurs recalculées par le serveur affichées (distance de la tournée).
    expect(within(tripList()).getByText(/99,9.km/)).toBeInTheDocument();
    expect(stopRow(detail(), /OLA Akwa/)).toHaveFocus();
    expect(screen.getByTestId("plan-announcement")).toHaveTextContent("Arrêts de la tournée 1 réordonnés.");
  });

  it("Alt+↓ sur le dernier arrêt : il passe en tête de la tournée suivante (move-stop), la sélection le suit", async () => {
    loginAs("dispatcher");
    const state = setup();
    const { user } = renderApp(URL);
    await openTrip(user, 1);
    stopRow(detail(), /OLA Deido/).focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(() =>
      expect(writes(state)[0]).toEqual({
        method: "POST",
        path: "/plans/plan-1/trips/trip-1/move-stop",
        body: { stop_id: "stop-c", to_trip_id: "trip-2", to_seq: 1 },
      }),
    );
    await waitFor(() =>
      expect(stopNames(detail())).toEqual(["Arrêt 1 : OLA Deido", "Arrêt 2 : OLA Ndokoti"]),
    );
    expect(within(detail()).getByRole("heading", { name: "Tournée 2" })).toBeInTheDocument();
    // Annonce = résumé renvoyé par le serveur (`last_edit.summary`), tel quel.
    expect(screen.getByTestId("plan-announcement")).toHaveTextContent(
      "Arrêt DLA04 déplacé de la tournée 1 vers la tournée 2 (position 1).",
    );
  });

  it("menu « Déplacer vers… » : même action que le glisser-déposer, sans souris", async () => {
    loginAs("dispatcher");
    const state = setup();
    const { user } = renderApp(URL);
    await openTrip(user, 1);
    const trigger = within(detail()).getByRole("button", {
      name: "Déplacer l'arrêt OLA Bonanjo vers une autre tournée",
    });
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("menuitem", { name: "Tournée 2 — LT-402-AB (en fin)" }));
    await waitFor(() =>
      expect(writes(state)[0]?.body).toEqual({ stop_id: "stop-b", to_trip_id: "trip-2", to_seq: 2 }),
    );
    await waitFor(() =>
      expect(stopNames(detail())).toEqual(["Arrêt 1 : OLA Ndokoti", "Arrêt 2 : OLA Bonanjo"]),
    );
  });

  it("vue tableau : mêmes déplacements au clavier, d'une tournée à l'autre", async () => {
    loginAs("dispatcher");
    const state = setup();
    const { user } = renderApp(URL);
    await user.click(await screen.findByRole("radio", { name: "Tableau" }));
    const table = screen.getByRole("table", { name: "Plan de tournées — vue tableau" });
    expect(stopNames(table)).toHaveLength(4);
    // ↓ passe d'un arrêt au suivant, puis Alt+↑ remonte l'arrêt de la tournée 2 en fin de tournée 1.
    stopRow(table, /OLA Deido/).focus();
    await user.keyboard("{ArrowDown}");
    expect(stopRow(table, /OLA Ndokoti/)).toHaveFocus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await waitFor(() =>
      expect(writes(state)[0]?.body).toEqual({ stop_id: "stop-d", to_trip_id: "trip-1", to_seq: 4 }),
    );
    // La tournée 2, vidée, disparaît (L5-10).
    await waitFor(() => expect(table.querySelectorAll("[data-trip-section]")).toHaveLength(1));
    expect(screen.getByTestId("plan-announcement")).toHaveTextContent("La tournée 2, vide, a été supprimée.");
  });
});

describe("Plan de tournées — affectation, verrouillage", () => {
  it("change le chauffeur et le camion (assign), en signalant les ressources non affectables", async () => {
    loginAs("dispatcher");
    const state = setup();
    const { user } = renderApp(URL);
    await openTrip(user, 1);
    const driver = await within(detail()).findByRole("combobox", { name: "Chauffeur" });
    await within(driver).findByRole("option", { name: "Yves Mbarga" });
    await user.selectOptions(driver, "driver-5");
    await waitFor(() =>
      expect(writes(state)[0]).toEqual({
        method: "POST",
        path: "/plans/plan-1/trips/trip-1/assign",
        body: { driver_id: "driver-5" },
      }),
    );
    await waitFor(() => expect(within(tripList()).getByText("Yves Mbarga")).toBeInTheDocument());

    const truck = within(detail()).getByRole("combobox", { name: "Camion" });
    expect(within(truck).getByRole("option", { name: /CE-409-ZZ.*en maintenance/ })).toBeInTheDocument();
    await user.selectOptions(truck, "truck-2");
    await waitFor(() => expect(writes(state)[1]?.body).toEqual({ truck_id: "truck-2" }));
  });

  it("verrouille puis déverrouille une tournée", async () => {
    loginAs("dispatcher");
    const state = setup();
    const { user } = renderApp(URL);
    await loaded();
    await user.click(within(tripList()).getByRole("button", { name: "Verrouiller la tournée 2" }));
    const unlock = await within(tripList()).findByRole("button", { name: "Déverrouiller la tournée 2" });
    expect(unlock).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(screen.getByTestId("plan-sync")).toHaveAttribute("data-state", "saved"));
    await user.click(unlock);
    await waitFor(() =>
      expect(writes(state).map((call) => call.path)).toEqual([
        "/plans/plan-1/trips/trip-2/lock",
        "/plans/plan-1/trips/trip-2/unlock",
      ]),
    );
  });
});

describe("Plan de tournées — erreurs de l'API", () => {
  it("refus de l'API : la modification optimiste est annulée et le message du serveur affiché", async () => {
    loginAs("dispatcher");
    const state = setup([makePlan()], {
      failNext: {
        status: 409,
        code: "conflict",
        message: "Cet arrêt est déjà livré ou sauté : il ne peut plus être déplacé.",
      },
    });
    const { user } = renderApp(URL);
    await openTrip(user, 1);
    stopRow(detail(), /OLA Akwa/).focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(await screen.findByText("Modification refusée")).toBeInTheDocument();
    expect(screen.getByText(/Cet arrêt est déjà livré ou sauté/)).toBeInTheDocument();
    expect(stopNames(detail())).toEqual([
      "Arrêt 1 : OLA Akwa",
      "Arrêt 2 : OLA Bonanjo",
      "Arrêt 3 : OLA Deido",
    ]);
    expect(writes(state)).toHaveLength(1);
    expect(usePlanStore.getState().pendingOp).toBeNull();
  });

  it("modifier un plan publié : bascule sur la nouvelle version brouillon (autre id, adresse comprise) et l'annonce", async () => {
    loginAs("dispatcher");
    const state = setup([makePlan({ status: "published", publishable: false })]);
    const { user, router } = renderApp(URL);
    expect(
      await screen.findByText(/Toute modification crée une nouvelle version brouillon/),
    ).toBeInTheDocument();
    await openTrip(user, 1);
    stopRow(detail(), /OLA Akwa/).focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");

    expect((await screen.findAllByText("Nouvelle version brouillon (version 2)")).length).toBeGreaterThan(0);
    expect(screen.getByText(/Le plan publié \(version 1\) n'a pas été modifié/)).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toContain("plan=plan-1-draft"));
    // L'appel porte les identifiants de la version publiée ; l'écran affiche ceux du brouillon.
    expect(writes(state)[0].path).toBe("/plans/plan-1/trips/trip-1/reorder");
    expect(screen.getByTestId("screen-plan")).toHaveAttribute("data-plan-id", "plan-1-draft");
    expect(stopNames(detail())).toEqual([
      "Arrêt 1 : OLA Bonanjo",
      "Arrêt 2 : OLA Akwa",
      "Arrêt 3 : OLA Deido",
    ]);
    expect(stopRow(detail(), /OLA Akwa/).dataset.stopRow).toBe("stop-a-v2");
    expect(within(tripList()).getByRole("button", { name: "Afficher la tournée 1" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // La modification suivante vise bien le brouillon.
    await user.click(within(tripList()).getByRole("button", { name: "Verrouiller la tournée 1" }));
    await waitFor(() => expect(writes(state)[1]?.path).toBe("/plans/plan-1-draft/trips/trip-1-v2/lock"));
  });

  it("409 draft_version_exists : propose d'ouvrir le brouillon en cours", async () => {
    loginAs("dispatcher");
    const published = makePlan({ status: "published", publishable: false });
    const draft = asNewVersion(published);
    // Le brouillon n'est pas encore connu de la liste du jour : seul le 409 le révèle.
    const state = setup([published], {
      failNext: {
        status: 409,
        code: "draft_version_exists",
        message: "Une version 2 est déjà en préparation pour ce plan.",
        details: [{ draft_plan_id: draft.id, version: 2 }],
      },
    });
    const { user, router } = renderApp(URL);
    await loaded();
    await user.click(within(tripList()).getByRole("button", { name: "Verrouiller la tournée 1" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Une version brouillon existe déjà" });
    // Annulation propre : le cadenas optimiste est retiré.
    expect(usePlanStore.getState().plan?.trips[0].locked).toBe(false);
    state.plans = [published, draft];
    await user.click(within(dialog).getByRole("button", { name: "Ouvrir le brouillon" }));
    await waitFor(() => expect(router.state.location.search).toContain("plan=plan-2"));
    await waitFor(() => expect(screen.getByTestId("screen-plan")).toHaveAttribute("data-plan-id", "plan-2"));
  });

  it("409 plan_is_reference : message de lecture seule, rien n'est modifié", async () => {
    loginAs("dispatcher");
    setup([makePlan()], {
      failNext: {
        status: 409,
        code: "plan_is_reference",
        message: "Ce plan est une journée de référence importée.",
      },
    });
    const { user } = renderApp(URL);
    await loaded();
    await user.click(within(tripList()).getByRole("button", { name: "Verrouiller la tournée 1" }));
    expect(await screen.findByText("Plan en lecture seule")).toBeInTheDocument();
    expect(within(tripList()).getByRole("button", { name: "Verrouiller la tournée 1" })).toBeInTheDocument();
  });
});

describe("Plan de tournées — publication", () => {
  it("publie après confirmation, puis donne accès aux feuilles de route (toutes, ou par tournée)", async () => {
    loginAs("dispatcher");
    const state = setup();
    const { user } = renderApp(URL);
    await user.click(await screen.findByRole("button", { name: "Publier" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Publier ce plan ?" });
    expect(writes(state)).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Publier" }));
    expect((await screen.findAllByText("Plan publié (version 1)")).length).toBeGreaterThan(0);
    expect(writes(state)[0].path).toBe("/plans/plan-1/publish");
    expect(screen.queryByRole("button", { name: "Publier" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Feuilles de route" }));
    await waitFor(() =>
      expect(state.calls.some((c) => c.path === "/plans/plan-1/route-sheets.pdf")).toBe(true),
    );
    await openTrip(user, 2);
    await user.click(within(detail()).getByRole("button", { name: "Feuille de route" }));
    await waitFor(() =>
      expect(state.calls.some((c) => c.path === "/trips/trip-2/route-sheet.pdf")).toBe(true),
    );
  });

  it("plan publié : liens du détail d'une tournée vers Chargement et Suivi (jour et tournée transmis)", async () => {
    loginAs("dispatcher");
    setup([makePlan({ status: "published", publishable: false })]);
    const { user } = renderApp(URL);
    await openTrip(user, 2);
    expect(
      within(detail()).getByRole("link", { name: "Ouvrir le chargement de la tournée 2" }),
    ).toHaveAttribute("href", `/chargement?day=${DAY}&trip=trip-2`);
    expect(
      within(detail()).getByRole("link", { name: "Ouvrir le suivi des livraisons de la tournée 2" }),
    ).toHaveAttribute("href", `/suivi?day=${DAY}&trip=trip-2`);
  });

  it("409 rule_violation : liste les règles en cause (rule_code) et mène à l'élément concerné", async () => {
    loginAs("dispatcher");
    setup([makePlan()], {
      failNext: {
        status: 409,
        code: "rule_violation",
        message: "Publication impossible : 2 violation(s) bloquante(s) à corriger.",
        details: [
          { rule_code: "RM-08", message: "Stock de GASOIL dépassé au dépôt SCDP-DLA.", severity: "blocking" },
          {
            rule_code: "RM-11",
            message: "Durée de service de la tournée 2 supérieure à 11 h.",
            severity: "blocking",
            trip_id: "trip-2",
          },
        ],
      },
    });
    const { user } = renderApp(URL);
    await user.click(await screen.findByRole("button", { name: "Publier" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Publier" }));
    const dialog = await screen.findByRole("dialog", { name: "Publication refusée" });
    expect(dialog).toHaveTextContent("Règles en cause : RM-08, RM-11");
    expect(dialog).toHaveTextContent("Stock de GASOIL dépassé au dépôt SCDP-DLA.");
    await user.click(within(dialog).getByRole("button", { name: /RM-11/ }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Publication refusée" })).not.toBeInTheDocument(),
    );
    expect(within(detail()).getByRole("heading", { name: "Tournée 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publier" })).toBeInTheDocument(); // toujours brouillon
  });

  it("reporter une commande urgente non servie lève le blocage de publication (RM-15)", async () => {
    loginAs("dispatcher");
    const state = setup([
      makePlan({
        unserved: [unserved("u", "DLA09", "OLA Makepe", true)],
        violations: [violation("1", "RM-15", "blocking", "Commande urgente non servie : station DLA09.")],
        blocking_count: 1,
        publishable: false,
      }),
    ]);
    const { user } = renderApp(URL);
    expect(await screen.findByRole("button", { name: "Publier" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Reporter la commande de OLA Makepe" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Reporter cette commande ?" });
    await user.click(within(dialog).getByRole("button", { name: "Reporter" }));
    await waitFor(() => expect(writes(state)[0]?.path).toBe("/orders/order-u/postpone"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Publier" })).toBeEnabled());
    expect(screen.getByTestId("unserved-banner")).toHaveTextContent("Reportée");
    expect(screen.queryByRole("button", { name: /Reporter la commande/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("violations-panel")).toHaveTextContent("Aucune violation.");
  });
});

describe("Plan de tournées — recalcul et versions", () => {
  it("« Recalculer en conservant » : confirmation, progression de la tâche, puis plan recalculé", async () => {
    loginAs("dispatcher");
    const base = makePlan();
    base.trips[0].locked = true;
    const state = setup([base], {
      taskSteps: [
        { state: "running", progress: 40, message: "Optimisation en cours…" },
        { state: "succeeded", progress: 100, plan_id: "plan-1" },
      ],
    });
    const { user } = renderApp(URL);
    await user.click(await screen.findByRole("button", { name: "Recalculer en conservant" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Recalculer en conservant ?" });
    expect(dialog).toHaveTextContent(
      "1 tournée verrouillée sera conservée telle quelle (RM-17) ; les 1 autres seront recalculées.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Recalculer" }));

    const progress = await screen.findByRole("progressbar", { name: "Recalcul en cours" });
    await waitFor(() => expect(progress).toHaveAttribute("aria-valuenow", "40"));
    expect(screen.getByTestId("recompute-progress")).toHaveTextContent("Optimisation en cours…");
    // Pendant le calcul : pas d'édition, pas de publication.
    expect(screen.getByRole("button", { name: "Publier" })).toBeDisabled();
    expect(
      within(tripList()).queryByRole("button", { name: /verrouiller la tournée/i }),
    ).not.toBeInTheDocument();

    expect(await screen.findByText("Plan recalculé", {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByTestId("recompute-progress")).not.toBeInTheDocument();
    expect(writes(state)[0].path).toBe("/plans/plan-1/recompute");
  });

  it("recalcul en échec : message lisible de la tâche", async () => {
    loginAs("dispatcher");
    setup([makePlan()], {
      taskSteps: [{ state: "failed", progress: 10, error: "Aucun camion disponible pour ce jour." }],
    });
    const { user } = renderApp(URL);
    await user.click(await screen.findByRole("button", { name: "Recalculer en conservant" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Recalculer" }),
    );
    expect(await screen.findByText("Recalcul en échec")).toBeInTheDocument();
    expect(screen.getByText("Aucun camion disponible pour ce jour.")).toBeInTheDocument();
  });

  it("historique : qui, quoi, quand ; restauration avec confirmation → nouveau brouillon affiché", async () => {
    loginAs("dispatcher");
    const archived = makePlan({ status: "archived", publishable: false });
    const published = { ...asNewVersion(archived), status: "published" as const };
    const state = setup([archived, published]);
    state.versions = undefined;
    const { user, router } = renderApp(`${URL}&plan=plan-2`);
    await user.click(await screen.findByRole("button", { name: "Historique" }));
    const dialog = await screen.findByRole("dialog", { name: "Historique des versions" });
    const v1 = await within(dialog).findByTestId("version-1");
    expect(v1).toHaveTextContent("Archivé");
    expect(v1).toHaveTextContent("par Awa Dispatcher");
    expect(within(dialog).getByTestId("version-2")).toHaveTextContent("Référence");
    expect(within(dialog).getByTestId("version-2")).toHaveTextContent("Affichée");

    await user.click(within(v1).getByRole("button", { name: "Restaurer la version 1" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Restaurer la version 1 ?" });
    expect(writes(state)).toHaveLength(0);
    await user.click(within(confirm).getByRole("button", { name: "Restaurer" }));
    expect(
      await screen.findByText("Version 1 restaurée dans un nouveau brouillon (version 3)"),
    ).toBeInTheDocument();
    expect(writes(state)[0].path).toBe("/plans/plan-2/versions/1/restore");
    await waitFor(() => expect(router.state.location.search).toContain("plan=plan-restored"));
    await waitFor(() =>
      expect(screen.getByTestId("screen-plan")).toHaveAttribute("data-plan-id", "plan-restored"),
    );
  });

  it("historique : journal des modifications d'une version", async () => {
    loginAs("manager");
    const plan = makePlan();
    setup([plan], {
      versions: [
        {
          plan_id: plan.id,
          version: 1,
          status: "draft",
          parent_plan_id: null,
          is_current: true,
          reason: null,
          created_at: plan.created_at,
          created_by: null,
          created_by_name: "Awa Dispatcher",
          published_at: null,
          published_by_name: null,
          metrics: plan.metrics ?? null,
          changes: [
            {
              id: "c1",
              type: "manual_edit",
              action: "move_stop",
              summary: "Arrêt DLA02 déplacé de la tournée 1 (position 2) vers la tournée 2 (position 1).",
              occurred_at: `${DAY}T06:05:00Z`,
              actor_id: "user-1",
              actor_name: "Awa Dispatcher",
              trip_id: "trip-2",
              payload: {},
            },
          ],
        },
      ],
    });
    const { user } = renderApp(URL);
    await user.click(await screen.findByRole("button", { name: "Historique" }));
    const dialog = await screen.findByRole("dialog", { name: "Historique des versions" });
    expect(await within(dialog).findByText(/Arrêt DLA02 déplacé de la tournée 1/)).toBeInTheDocument();
    expect(within(dialog).getByText(/07:05/)).toBeInTheDocument();
    // Lecture seule : pas de restauration.
    expect(within(dialog).queryByRole("button", { name: /Restaurer/ })).not.toBeInTheDocument();
  });
});

describe("Plan de tournées — version archivée par un événement", () => {
  it("version affichée remplacée (panne, pénurie) : annonce, lecture seule, bascule proposée vers la version en vigueur", async () => {
    loginAs("dispatcher");
    const published = makePlan({ status: "published", publishable: false });
    const state = setup([published]);
    const { user, router } = renderApp(`${URL}&plan=plan-1`);
    await loaded();
    expect(within(tripList()).getByRole("button", { name: "Verrouiller la tournée 1" })).toBeInTheDocument();

    // Le back-end publie une version 2 à la suite d'un événement : la version 1 est archivée.
    const current = { ...asNewVersion(published), status: "published" as const, publishable: false };
    state.plans = [{ ...published, status: "archived" }, current];
    refetchNow();

    expect(
      (
        await screen.findAllByText(
          "La version 1 affichée vient d'être archivée : la version 2 est maintenant en vigueur.",
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(
      await screen.findByText(/Cette version a été remplacée : la version 2 est en vigueur/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verrouiller la tournée 1" })).not.toBeInTheDocument();
    // Lien vers le Journal depuis l'annonce (en plus de celui de la navigation).
    expect(
      within(screen.getByTestId("screen-plan")).getByRole("link", { name: "Journal des événements" }),
    ).toHaveAttribute("href", `/journal?day=${DAY}`);
    expect(screen.getByRole("combobox", { name: "Plan et version affichés" })).toHaveValue("plan-1");

    await user.click(screen.getByRole("button", { name: "Afficher la version en vigueur" }));
    await waitFor(() => expect(router.state.location.search).toContain("plan=plan-2"));
    await waitFor(() => expect(screen.getByTestId("screen-plan")).toHaveAttribute("data-plan-id", "plan-2"));
    expect(screen.queryByText(/Cette version a été remplacée/)).not.toBeInTheDocument();
  });

  it("version archivée ouverte par un lien : la version en vigueur est proposée", async () => {
    loginAs("manager");
    const archived = makePlan({ status: "archived", publishable: false });
    setup([archived, { ...asNewVersion(archived), status: "published", publishable: false }]);
    renderApp(`${URL}&plan=plan-1`);
    expect(
      await screen.findByText(/Cette version a été remplacée : la version 2 est en vigueur/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Afficher la version en vigueur" })).toBeInTheDocument();
  });
});

describe("Plan de tournées — version brouillon née d'un événement", () => {
  const event = (planId: string) => ({
    id: "event-1",
    day: DAY,
    type: "truck_breakdown" as const,
    type_label: "Panne de camion",
    action: null,
    summary: "Camion LT-401-AA en panne à 09:30 : 2 arrêts transférés sur le camion LT-402-AB (tournée 3).",
    occurred_at: `${DAY}T08:30:00Z`,
    actor_id: "user-1",
    actor_name: "Awa Dispatcher",
    plan_id: planId,
    plan_version: 2,
    trip_id: null,
    trip_seq: null,
    truck_plate: null,
    payload: {},
  });

  it("le dit en tête d'écran, avec les violations à corriger et le résumé de l'événement", async () => {
    loginAs("dispatcher");
    const published = makePlan({ status: "published", publishable: false });
    const draft = {
      ...asNewVersion(published),
      blocking_count: 1,
      publishable: false,
      violations: [violation("1", "RM-03", "blocking", "Le chauffeur de la tournée 2 n'est pas affectable.")],
    };
    setup([published, draft], { events: [event(draft.id)] });
    renderApp(`${URL}&plan=${draft.id}`);
    const notice = await screen.findByTestId("event-draft-notice");
    expect(notice).toHaveTextContent(
      "Version 2 créée par un événement : 1 violation bloquante à corriger avant publication.",
    );
    expect(notice).toHaveTextContent("La version 1 publiée reste la référence du terrain d'ici là.");
    expect(notice).toHaveTextContent("Panne de camion · 09:30");
    expect(notice).toHaveTextContent("2 arrêts transférés sur le camion LT-402-AB");
    expect(
      within(screen.getByTestId("screen-plan")).getByRole("link", { name: "Journal des événements" }),
    ).toHaveAttribute("href", `/journal?day=${DAY}`);
    expect(screen.getByRole("button", { name: "Voir la version publiée" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publier" })).toBeDisabled();
  });

  it("un brouillon né d'une modification manuelle garde le bandeau habituel", async () => {
    loginAs("dispatcher");
    const published = makePlan({ status: "published", publishable: false });
    const draft = asNewVersion(published);
    setup([published, draft], { events: [] });
    renderApp(`${URL}&plan=${draft.id}`);
    expect(
      await screen.findByText(/Version 2 — brouillon\. La version 1 publiée reste la référence/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("event-draft-notice")).not.toBeInTheDocument();
  });
});

describe("Plan de tournées — adresse", () => {
  it("un plan d'un autre jour dans l'adresse est ignoré : le jour J l'emporte", async () => {
    loginAs("dispatcher");
    setup([makePlan(), makePlan({ id: "plan-autre", root_plan_id: "plan-autre", day: "2027-01-20" })]);
    const { router } = renderApp(`${URL}&plan=plan-autre`);
    await waitFor(() => expect(screen.getByTestId("screen-plan")).toHaveAttribute("data-plan-id", "plan-1"));
    expect(router.state.location.search).not.toContain("plan=");
    expect(SERVER_DISTANCE_M).toBeGreaterThan(0);
  });
});
