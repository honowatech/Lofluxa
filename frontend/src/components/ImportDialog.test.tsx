import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { importReportRows } from "@/lib/api/imports";
import type { ImportBatch } from "@/lib/types";
import { db } from "@/mocks/db";
import { API, readUpload } from "@/mocks/handlers/helpers";
import { server } from "@/mocks/server";
import { loginAs, renderWithProviders } from "@/test/utils";

import { ImportDialog } from "./ImportDialog";

const csv = (name: string, lines: string[]) => new File([lines.join("\n")], name, { type: "text/csv" });

function setup(kind: "stations" | "trucks" = "stations") {
  loginAs("admin");
  const onApplied = vi.fn();
  const onOpenChange = vi.fn();
  const view = renderWithProviders(
    <ImportDialog kind={kind} open onOpenChange={onOpenChange} onApplied={onApplied} />,
  );
  return { ...view, onApplied, onOpenChange };
}

describe("ImportDialog", () => {
  it("prévisualisation avec erreurs ligne par ligne : application impossible, rien n'est écrit", async () => {
    const { user, onApplied } = setup();
    expect(screen.getByRole("dialog", { name: "Importer — stations" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prévisualiser" })).toBeDisabled();

    await user.upload(
      screen.getByLabelText("Choisir un fichier"),
      csv("stations.csv", [
        "code;name;lat;lon",
        "DLA-090;OLA Test;4,05;9,70",
        ";Sans code;4,1;9,7",
        "DLA-091;OLA Latitude;abc;9,7",
        "DLA-090;Doublon;4,05;9,70",
      ]),
    );
    expect(screen.getByText("stations.csv")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Prévisualiser" }));

    expect(await screen.findByTestId("import-summary")).toHaveTextContent("4 lignes lues, 3 en erreur");
    // Par défaut seules les lignes en erreur sont listées, avec leur numéro de ligne dans le fichier.
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[0].textContent)).toEqual(["3", "4", "5"]);
    // Colonne en cause, message et valeur fautive.
    expect(rows[0]).toHaveTextContent("Code");
    expect(rows[0]).toHaveTextContent("Valeur obligatoire manquante.");
    expect(rows[1]).toHaveTextContent(/Latitude\s*Nombre attendu\.\s*\(abc\)/);
    expect(rows[2]).toHaveTextContent("Doublon dans le fichier.");
    expect(screen.getByTestId("import-effects")).toHaveTextContent("1 création, 0 mise à jour, 0 inchangée");
    // Le bouton dit pourquoi il est inactif, au lieu d'annoncer des lignes qui ne seront pas appliquées.
    expect(screen.getByRole("button", { name: "Import bloqué : 3 lignes en erreur" })).toBeDisabled();

    await user.click(screen.getByLabelText("Erreurs seulement"));
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(4);
    expect(screen.getAllByRole("row")[1]).toHaveTextContent("Création");
    expect(db.stations.some((station) => station.code === "DLA-090")).toBe(false);
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("fichier valide : prévisualiser (création / mise à jour) puis appliquer", async () => {
    const { user, onApplied, onOpenChange } = setup();
    await user.upload(
      screen.getByLabelText("Choisir un fichier"),
      csv("stations.csv", [
        "code;name;lat;lon;city",
        "DLA-001;OLA Akwa Rénové;4,0502;9,6958;Douala",
        "DLA-095;OLA Nouvelle;4,06;9,71;Douala",
      ]),
    );
    await user.click(screen.getByRole("button", { name: "Prévisualiser" }));
    expect(await screen.findByText("Toutes les lignes sont valides.")).toBeInTheDocument();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Mise à jour");
    // Une mise à jour annonce chaque champ modifié, avant → après.
    expect(rows[0]).toHaveTextContent(/Nom : OLA Akwa Boulevard → OLA Akwa Rénové/);
    expect(rows[1]).toHaveTextContent("Création");
    expect(screen.getByTestId("import-effects")).toHaveTextContent("1 création, 1 mise à jour, 0 inchangée");
    expect(db.stations.find((station) => station.code === "DLA-001")?.name).toBe("OLA Akwa Boulevard");

    await user.click(screen.getByRole("button", { name: "Appliquer 2 lignes" }));
    await waitFor(() =>
      expect(onApplied).toHaveBeenCalledWith(expect.objectContaining({ status: "applied" })),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(await screen.findByText("Import appliqué : 2 lignes enregistrées.")).toBeInTheDocument();
    expect(db.stations.find((station) => station.code === "DLA-001")?.name).toBe("OLA Akwa Rénové");
    expect(db.stations.find((station) => station.code === "DLA-095")).toMatchObject({
      lat: 4.06,
      lon: 9.71,
      city: "Douala",
    });
  });

  it("refuse un format non pris en charge ; télécharge le fichier modèle du bon type", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { user } = setup("trucks");
    const input = screen.getByLabelText("Choisir un fichier") as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["%PDF"], "camions.pdf", { type: "application/pdf" })] },
    });
    expect(await screen.findByText(/Format non pris en charge/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prévisualiser" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Télécharger le fichier modèle" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    click.mockRestore();
  });

  it("fichier identique aux données : rien à appliquer, le dire clairement", async () => {
    const { user } = setup();
    await user.upload(
      screen.getByLabelText("Choisir un fichier"),
      csv("stations.csv", ["code;name;lat;lon", "DLA-001;OLA Akwa Boulevard;4,0502;9,6958"]),
    );
    await user.click(screen.getByRole("button", { name: "Prévisualiser" }));
    expect(await screen.findByText(/rien à appliquer/)).toBeInTheDocument();
    expect(screen.getAllByRole("row")[1]).toHaveTextContent("Inchangée");
    expect(screen.getByRole("button", { name: "Rien à appliquer" })).toBeDisabled();
  });

  it("refus à l'application (lot déjà appliqué ailleurs) : message du serveur, la boîte reste ouverte", async () => {
    const { user, onApplied, onOpenChange } = setup();
    await user.upload(
      screen.getByLabelText("Choisir un fichier"),
      csv("stations.csv", ["code;name;lat;lon", "DLA-096;OLA Deux Fois;4,06;9,71"]),
    );
    await user.click(screen.getByRole("button", { name: "Prévisualiser" }));
    const apply = await screen.findByRole("button", { name: "Appliquer 1 ligne" });
    db.imports[db.imports.length - 1].status = "applied";
    await user.click(apply);
    expect(
      await screen.findByText("Ce lot a déjà été appliqué : il ne peut pas l'être une seconde fois."),
    ).toBeInTheDocument();
    expect(onApplied).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("`fields` part en paramètres de requête de la prévisualisation (l'API n'y lit pas le formulaire)", async () => {
    loginAs("admin");
    let seen: { query: string; formHasDay: boolean } | null = null;
    server.use(
      http.post(`${API}/imports/orders/preview`, async ({ request }) => {
        const upload = await readUpload(request);
        seen = { query: new URL(request.url).search, formHasDay: "day" in upload.fields };
        const id = "b-orders";
        return HttpResponse.json(
          {
            id,
            batch_id: id,
            kind: "orders",
            filename: upload.files.file.name,
            status: "previewed",
            row_count: 1,
            error_count: 0,
            can_apply: true,
            created_at: "2027-01-12T06:00:00Z",
            created_by: null,
            report: {
              summary: { created: 1, updated: 0, unchanged: 0, errors: 0, warnings: 0 },
              issues: [],
              items: [
                {
                  row: 2,
                  key: "DLA-001/SUPER",
                  label: "OLA Akwa — SUPER 12 000 L",
                  action: "create",
                  changes: [],
                },
              ],
              options: { day: "2027-01-12" },
            },
          },
          { status: 201 },
        );
      }),
    );
    const { user } = renderWithProviders(
      <ImportDialog kind="orders" fields={{ day: "2027-01-12" }} open onOpenChange={() => {}} />,
    );
    await user.upload(
      screen.getByLabelText("Choisir un fichier"),
      csv("commandes.csv", ["station;produit;volume", "DLA-001;SUPER;12000"]),
    );
    await user.click(screen.getByRole("button", { name: "Prévisualiser" }));
    expect(await screen.findByRole("button", { name: "Appliquer 1 ligne" })).toBeEnabled();
    expect(seen).toEqual({ query: "?day=2027-01-12", formHasDay: false });
  });

  it("importReportRows regroupe effets et anomalies par ligne ; anomalies du fichier entier en tête", () => {
    const batch = {
      report: {
        summary: { created: 1, updated: 0, unchanged: 0, errors: 2, warnings: 1 },
        items: [{ row: 2, key: "A", label: "A — Akwa", action: "create", changes: [] }],
        issues: [
          { row: 4, column: "Latitude", value: "abc", message: "Nombre attendu.", severity: "error" },
          { row: 2, column: "Ville", value: null, message: "Ville non renseignée.", severity: "warning" },
          {
            row: null,
            column: "Code",
            value: null,
            message: "Colonne obligatoire absente.",
            severity: "error",
          },
        ],
      },
    } as unknown as ImportBatch;
    const rows = importReportRows(batch);
    expect(rows.map((row) => [row.row, row.status, row.item?.key ?? null, row.issues.length])).toEqual([
      [null, "error", null, 1],
      [2, "warning", "A", 1],
      [4, "error", null, 1],
    ]);
  });
});
