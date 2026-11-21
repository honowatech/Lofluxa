import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { db, SETTINGS_DEFAULTS } from "@/mocks/db";
import { API } from "@/mocks/handlers/helpers";
import { server } from "@/mocks/server";
import { loginAs, renderApp } from "@/test/utils";

import { changedFields, diffRecords, formatAuditValue } from "./diff";
import { metaFor, SETTINGS_PRESENTATION, validateSetting } from "./settingsCatalog";
import { generatePassword } from "./UsersTab";

const dataRows = (table: HTMLElement) => within(table).getAllByRole("row").slice(1);
const rowOf = (text: string) => screen.getByText(text).closest("tr") as HTMLElement;

describe("Administration — utilisateurs", () => {
  it("liste : rôle, état, dernière connexion (heure de Douala), compte courant repéré", async () => {
    const me = loginAs("admin");
    renderApp("/administration");
    const table = await screen.findByRole("grid", { name: "Utilisateurs" });
    await waitFor(() => expect(dataRows(table)).toHaveLength(6));
    expect(
      within(within(table).getByText(me.full_name).closest("tr") as HTMLElement).getByText("vous"),
    ).toBeInTheDocument();
    expect(within(rowOf("Mme Medjo")).getByText("Direction")).toBeInTheDocument();
    expect(within(rowOf("Thierry Owona")).getByText("Inactif")).toBeInTheDocument();
    expect(within(rowOf("Thierry Owona")).getByText("Jamais")).toBeInTheDocument();
    expect(within(rowOf("Brice Ekambi")).getByText(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/)).toBeInTheDocument();
  });

  it("création : validation, mot de passe généré, e-mail déjà pris signalé sur le champ", async () => {
    loginAs("admin");
    const { user } = renderApp("/administration?tab=users");
    await screen.findByRole("grid", { name: "Utilisateurs" });
    await user.click(screen.getByRole("button", { name: "Nouvel utilisateur" }));
    const dialog = await screen.findByRole("dialog", { name: "Nouvel utilisateur" });

    await user.type(within(dialog).getByLabelText(/^Nom complet/), "Clarisse Ndongo");
    await user.type(within(dialog).getByLabelText(/^Adresse e-mail/), "Dispatch@OLA.example");
    await user.selectOptions(within(dialog).getByLabelText(/^Rôle/), "fleet");
    expect(within(dialog).getByText("Chargement réel, statuts chargé / livré.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/^Mot de passe initial/), "court");
    await user.click(within(dialog).getByRole("button", { name: "Créer" }));
    expect(await within(dialog).findByText("8 caractères minimum")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Générer" }));
    const password = (within(dialog).getByLabelText(/^Mot de passe initial/) as HTMLInputElement).value;
    expect(password).toHaveLength(16);
    await user.click(within(dialog).getByRole("button", { name: "Créer" }));
    expect(
      await within(dialog).findByText("Un compte existe déjà avec cette adresse e-mail."),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^Adresse e-mail/)).toHaveAccessibleDescription(
      "Adresse e-mail déjà utilisée.",
    );

    await user.clear(within(dialog).getByLabelText(/^Adresse e-mail/));
    await user.type(within(dialog).getByLabelText(/^Adresse e-mail/), "clarisse@ola.example");
    await user.click(within(dialog).getByRole("button", { name: "Créer" }));
    expect(await screen.findByText("Compte de Clarisse Ndongo créé")).toBeInTheDocument();
    expect(db.users.find((u) => u.email === "clarisse@ola.example")).toMatchObject({
      role: "fleet",
      active: true,
      password,
      full_name: "Clarisse Ndongo",
    });
    await waitFor(() => expect(screen.getByText("Clarisse Ndongo")).toBeInTheDocument());
  });

  it("rôle modifié ; désactivation confirmée ; réactivation directe", async () => {
    loginAs("admin");
    const { user } = renderApp("/administration?tab=users");
    await screen.findByRole("grid", { name: "Utilisateurs" });
    await user.dblClick(await screen.findByText("Hervé Mbah"));
    const dialog = await screen.findByRole("dialog", { name: "Modifier l'utilisateur" });
    await user.selectOptions(within(dialog).getByLabelText(/^Rôle/), "dispatcher");
    await user.click(within(dialog).getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(db.users.find((u) => u.full_name === "Hervé Mbah")?.role).toBe("dispatcher"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions — Hervé Mbah" }));
    await user.click(await screen.findByRole("menuitem", { name: "Désactiver" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Désactiver ce compte ?" });
    expect(confirm).toHaveTextContent("Hervé Mbah ne pourra plus se connecter");
    expect(db.users.find((u) => u.full_name === "Hervé Mbah")?.active).toBe(true);
    await user.click(within(confirm).getByRole("button", { name: "Désactiver" }));
    expect(await screen.findByText("Compte de Hervé Mbah désactivé")).toBeInTheDocument();
    expect(db.users.find((u) => u.full_name === "Hervé Mbah")?.active).toBe(false);

    await waitFor(() => expect(within(rowOf("Hervé Mbah")).getByText("Inactif")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Actions — Hervé Mbah" }));
    await user.click(await screen.findByRole("menuitem", { name: "Activer" }));
    await waitFor(() => expect(db.users.find((u) => u.full_name === "Hervé Mbah")?.active).toBe(true));
  });

  it("réinitialisation du mot de passe ; son propre compte ne peut être ni désactivé ni rétrogradé", async () => {
    const me = loginAs("admin");
    const { user } = renderApp("/administration?tab=users");
    await screen.findByRole("grid", { name: "Utilisateurs" });
    await user.click(await screen.findByRole("button", { name: "Actions — Rosine Ngo Bassa" }));
    await user.click(await screen.findByRole("menuitem", { name: "Réinitialiser le mot de passe" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Réinitialiser le mot de passe de Rosine Ngo Bassa",
    });
    await user.type(within(dialog).getByLabelText(/^Nouveau mot de passe/), "nouveau-secret-2027");
    await user.click(within(dialog).getByRole("button", { name: "Réinitialiser le mot de passe" }));
    expect(await screen.findByText("Mot de passe de Rosine Ngo Bassa réinitialisé")).toBeInTheDocument();
    expect(db.users.find((u) => u.full_name === "Rosine Ngo Bassa")?.password).toBe("nouveau-secret-2027");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: `Actions — ${me.full_name}` }));
    expect(await screen.findByRole("menuitem", { name: "Désactiver" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    // Son propre mot de passe se change par `PUT /me/password`, pas par la réinitialisation d'administrateur.
    expect(screen.getByRole("menuitem", { name: "Réinitialiser le mot de passe" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(screen.getByRole("menuitem", { name: "Modifier" }));
    const own = await screen.findByRole("dialog", { name: "Modifier l'utilisateur" });
    expect(within(own).getByLabelText(/^Rôle/)).toBeDisabled();
    expect(within(own).getByRole("switch", { name: "Actif" })).toBeDisabled();
  });
});

describe("Administration — paramètres", () => {
  it("toutes les clés de settings_store.DEFAULTS, avec description, valeur et défaut", async () => {
    loginAs("admin");
    renderApp("/administration?tab=settings");
    await screen.findByLabelText(/Vitesse moyenne par défaut des camions/);
    const keys = [...document.querySelectorAll("[data-setting]")].map((row) =>
      row.getAttribute("data-setting"),
    );
    expect(keys.sort()).toEqual(Object.keys(SETTINGS_DEFAULTS).sort());
    expect(Object.keys(SETTINGS_PRESENTATION).sort()).toEqual(Object.keys(SETTINGS_DEFAULTS).sort());
    expect(keys).toHaveLength(23);

    const tolerance = document.querySelector('[data-setting="window_tolerance_min"]') as HTMLElement;
    expect(within(tolerance).getByRole("textbox")).toHaveValue("20");
    expect(within(tolerance).getByText("30 min")).toBeInTheDocument();
    expect(within(tolerance).getByText("window_tolerance_min")).toBeInTheDocument();
    expect(
      within(tolerance).getByRole("button", { name: /Rétablir la valeur par défaut/ }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Fuseau horaire d'affichage/)).toHaveValue("Africa/Douala");
    expect(screen.getByRole("button", { name: "Enregistrer" })).toBeDisabled();
  });

  it("validation à la saisie : l'enregistrement est bloqué tant qu'une valeur est invalide", async () => {
    loginAs("admin");
    const { user } = renderApp("/administration?tab=settings");
    const hours = await screen.findByLabelText(/Durée maximale de service/);
    await user.clear(hours);
    await user.type(hours, "30");
    expect(hours).toHaveAccessibleDescription("Maximum 24");
    expect(screen.getByRole("button", { name: /Enregistrer 1 modification/ })).toBeDisabled();

    const loadings = screen.getByLabelText(/Nombre max de chargements/);
    await user.clear(loadings);
    await user.type(loadings, "2,5");
    expect(loadings).toHaveAccessibleDescription("Nombre entier attendu");
    const start = screen.getByLabelText(/Heure de début de journée/);
    await user.clear(start);
    await user.type(start, "25:00");
    expect(start).toHaveAccessibleDescription("Heure invalide (HH:mm)");
    const zone = screen.getByLabelText(/Fuseau horaire/);
    await user.clear(zone);
    await user.type(zone, "Afrique/Douala");
    expect(zone).toHaveAccessibleDescription(/Fuseau horaire inconnu/);
    const company = screen.getByLabelText(/Nom affiché en en-tête/);
    await user.clear(company);
    expect(company).toHaveAccessibleDescription("Valeur obligatoire");
    expect(screen.getByRole("button", { name: /Enregistrer 5 modifications/ })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Annuler les modifications" }));
    expect(screen.getByLabelText(/Durée maximale de service/)).toHaveValue("11");
    expect(screen.getByRole("button", { name: "Enregistrer" })).toBeDisabled();
    expect(db.settings.max_service_hours.value).toBe(11);
  });

  it("enregistrement : récapitulatif avant → après à confirmer, seules les clés modifiées partent, trace dans l'audit", async () => {
    loginAs("admin");
    let sent: unknown = null;
    server.events.on("request:start", async ({ request }) => {
      if (request.method === "PUT" && request.url.endsWith("/settings")) sent = await request.clone().json();
    });
    const { user } = renderApp("/administration?tab=settings");
    const hours = await screen.findByLabelText(/Durée maximale de service/);
    await user.clear(hours);
    await user.type(hours, "10,5");
    const tolerance = document.querySelector('[data-setting="window_tolerance_min"]') as HTMLElement;
    await user.click(within(tolerance).getByRole("button", { name: /Rétablir la valeur par défaut/ }));
    expect(within(tolerance).getByRole("textbox")).toHaveValue("30");
    expect(within(tolerance).getByText("Modifié")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Enregistrer 2 modifications" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Enregistrer les paramètres ?" });
    expect(confirm).toHaveTextContent(/max_service_hours : 11 h → 10,5 h/);
    expect(confirm).toHaveTextContent(/window_tolerance_min : 20 min → 30 min/);
    expect(db.settings.max_service_hours.value).toBe(11);
    await user.click(within(confirm).getByRole("button", { name: "Enregistrer" }));

    expect(await screen.findByText("2 paramètres enregistrés")).toBeInTheDocument();
    server.events.removeAllListeners();
    expect(sent).toEqual({ values: { max_service_hours: 10.5, window_tolerance_min: 30 } });
    expect(db.settings.max_service_hours.value).toBe(10.5);
    expect(db.audit[0]).toMatchObject({
      table_name: "settings",
      row_id: "window_tolerance_min",
      before: { value: 20 },
      after: { value: 30 },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Enregistrer" })).toBeDisabled());
    expect(screen.getByLabelText(/Durée maximale de service/)).toHaveValue("10,5");
  });

  it("refus du serveur : message sous le champ concerné, saisie conservée", async () => {
    loginAs("admin");
    server.use(
      http.put(`${API}/settings`, () =>
        HttpResponse.json(
          {
            code: "validation_error",
            message: "Requête invalide.",
            details: [{ field: "body.solver_seed", message: "Graine refusée par le serveur" }],
          },
          { status: 422 },
        ),
      ),
    );
    const { user } = renderApp("/administration?tab=settings");
    const seed = await screen.findByLabelText(/Graine du solveur/);
    await user.clear(seed);
    await user.type(seed, "7");
    await user.click(screen.getByRole("button", { name: "Enregistrer 1 modification" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Enregistrer" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/Graine du solveur/)).toHaveAccessibleDescription(
        "Graine refusée par le serveur",
      ),
    );
    expect(screen.getByLabelText(/Graine du solveur/)).toHaveValue("7");
  });

  it("contrôle à la saisie d'après le type et les bornes annoncés par le serveur ; clé inconnue acceptée", () => {
    const meta = (type: string, extra: object = {}) => metaFor({ key: "k", type, ...extra } as never);
    expect(validateSetting(meta("str", { nullable: true }), null)).toBeNull();
    expect(validateSetting(meta("str"), "")).toBe("Valeur obligatoire");
    expect(validateSetting(meta("float", { min: 1, max: 3 }), 0.5)).toBe("Minimum 1");
    expect(validateSetting(meta("float", { min: 1, max: 3 }), 3.5)).toBe("Maximum 3");
    expect(validateSetting(meta("float"), Number.NaN)).toBe("Nombre invalide");
    expect(validateSetting(meta("int"), 2.5)).toBe("Nombre entier attendu");
    expect(validateSetting(meta("time"), "6h")).toBe("Heure invalide (HH:mm)");
    expect(validateSetting(meta("timezone"), "Europe/Paris")).toBeNull();
    expect(validateSetting(meta("json"), "libre")).toBeNull();
    // Une clé ajoutée côté serveur s'affiche d'elle-même dans le groupe « Autres », avec ses bornes.
    expect(metaFor({ key: "cle_future", type: "int", min: 0, max: 9, nullable: false })).toEqual({
      group: "other",
      unit: undefined,
      type: "int",
      min: 0,
      max: 9,
      nullable: false,
    });
    expect(metaFor({ key: "max_service_hours", type: "float" })).toMatchObject({
      group: "durations",
      unit: "h",
    });
  });
});

describe("Administration — journal d'audit", () => {
  it("liste antéchronologique ; sélection d'une écriture = diff avant → après", async () => {
    loginAs("admin");
    const { user } = renderApp("/administration?tab=audit");
    const table = await screen.findByRole("grid", { name: "Journal d'audit" });
    await waitFor(() => expect(dataRows(table)).toHaveLength(48));
    expect(
      screen.getByText("Sélectionnez une écriture pour voir le détail avant → après."),
    ).toBeInTheDocument();
    const first = dataRows(table)[0];
    expect(first).toHaveTextContent("settings");
    expect(first).toHaveTextContent("Administrateur Honowa");
    expect(first).toHaveTextContent("1 champ : value");

    await user.click(within(dataRows(table)[2]).getByText("trips"));
    const diff = await screen.findByTestId("audit-diff");
    const rows = within(diff).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.getAttribute("data-kind"))).toEqual(["changed", "changed"]);
    expect(rows[1]).toHaveTextContent(/locked\s*Non\s*Oui/);

    // Création : tout est « absent » avant ; suppression : tout est absent après.
    await user.click(within(dataRows(table)[3]).getByText("Création"));
    expect(within(await screen.findByTestId("audit-diff")).getAllByText("absent")).toHaveLength(4);
    within(dataRows(table)[7]).getAllByRole("gridcell")[0].focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(within(screen.getByTestId("audit-diff")).getByText("Suppression")).toBeInTheDocument(),
    );
    expect(within(screen.getByTestId("audit-diff")).getAllByText("absent")).toHaveLength(2);
  });

  it("filtres table / ligne / acteur / période envoyés au serveur", async () => {
    loginAs("admin");
    const queries: URLSearchParams[] = [];
    server.events.on("request:start", ({ request }) => {
      if (request.url.includes("/audit")) queries.push(new URL(request.url).searchParams);
    });
    const { user } = renderApp("/administration?tab=audit");
    const table = await screen.findByRole("grid", { name: "Journal d'audit" });
    await waitFor(() => expect(dataRows(table)).toHaveLength(48));

    await user.selectOptions(screen.getByLabelText("Table"), "stocks");
    await waitFor(() => expect(screen.getByText("1–15 sur 15")).toBeInTheDocument());
    expect(dataRows(table).every((row) => within(row).queryByText("stocks"))).toBe(true);

    await waitFor(() =>
      expect(within(screen.getByLabelText("Acteur")).getAllByRole("option").length).toBeGreaterThan(2),
    );
    await user.selectOptions(screen.getByLabelText("Acteur"), "Hervé Mbah");
    await waitFor(() => expect(screen.getByText("1–2 sur 2")).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText("Acteur"), "");
    await user.selectOptions(screen.getByLabelText("Table"), "");
    await user.type(screen.getByLabelText("Identifiant de ligne"), "window_tolerance_min");
    await waitFor(() => expect(screen.getByText("1–1 sur 1")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Effacer les filtres" }));
    await waitFor(() => expect(screen.getByText("1–48 sur 48")).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText("Action"), "delete");
    await waitFor(() => expect(screen.getByText("1–1 sur 1")).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Action"), "");
    await waitFor(() => expect(screen.getByText("1–48 sur 48")).toBeInTheDocument());

    await user.type(screen.getByLabelText("Du"), "2027-01-12");
    await user.type(screen.getByLabelText("Au"), "2027-01-13");
    await waitFor(() =>
      expect(screen.getByText("Aucune écriture ne correspond aux filtres.")).toBeInTheDocument(),
    );
    server.events.removeAllListeners();
    const last = queries[queries.length - 1];
    // Jours locaux transmis tels quels (bornes incluses) : la conversion en UTC est faite par le serveur.
    expect(last.get("date_from")).toBe("2027-01-12");
    expect(last.get("date_to")).toBe("2027-01-13");
    expect(queries.some((q) => q.get("table") === "stocks" && q.get("actor_id"))).toBe(true);
    expect(queries.some((q) => q.get("row_id") === "window_tolerance_min")).toBe(true);
    expect(queries.some((q) => q.get("action") === "delete")).toBe(true);

    await user.clear(screen.getByLabelText("Au"));
    await user.type(screen.getByLabelText("Au"), "2027-01-01");
    expect(await screen.findByText("La date de fin précède la date de début")).toBeInTheDocument();
  });

  it("diff : champs modifiés d'abord, ajoutés / retirés distingués", () => {
    const rows = diffRecords(
      { a: 1, b: "x", c: { k: 1 }, gone: true },
      { a: 1, b: "y", c: { k: 1 }, added: null },
    );
    expect(rows.map((row) => [row.field, row.kind])).toEqual([
      ["added", "added"],
      ["b", "changed"],
      ["gone", "removed"],
      ["a", "unchanged"],
      ["c", "unchanged"],
    ]);
    expect(changedFields(rows)).toHaveLength(3);
    expect(diffRecords(null, { a: 1 })[0].kind).toBe("added");
    expect(diffRecords(null, null)).toEqual([]);
    expect(formatAuditValue(undefined)).toBe("absent");
    expect(formatAuditValue(null)).toBe("null");
    expect(formatAuditValue({ k: [1, 2] })).toBe('{"k":[1,2]}');
    expect(formatAuditValue(false)).toBe("Non");
  });
});

describe("mot de passe généré", () => {
  it("16 caractères sans caractères ambigus, différent à chaque fois", () => {
    const a = generatePassword();
    expect(a).toMatch(/^[a-km-zA-HJ-NP-Z2-9_-]{16}$/);
    expect(generatePassword()).not.toBe(a);
    expect(generatePassword(24)).toHaveLength(24);
  });
});
