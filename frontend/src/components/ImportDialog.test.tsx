import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { normalizeImportBatch } from "@/lib/api/imports";
import { db } from "@/mocks/db";
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
    expect(rows[0]).toHaveTextContent("code");
    expect(rows[0]).toHaveTextContent("Valeur obligatoire manquante");
    expect(rows[1]).toHaveTextContent("Nombre attendu, reçu « abc »");
    expect(rows[2]).toHaveTextContent("Doublon dans le fichier");
    expect(screen.getByRole("button", { name: /Appliquer/ })).toBeDisabled();

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
    expect(rows[1]).toHaveTextContent("Création");
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

  it("normalizeImportBatch accepte les variantes de rapport", () => {
    const batch = normalizeImportBatch({
      batch_id: "b1",
      kind: "drivers",
      filename: "f.xlsx",
      report: {
        lines: [
          { line: 2, errors: ["Permis manquant"] },
          { line: 3, warnings: [{ column: "phone", msg: "Format inhabituel" }] },
          { line: 4, values: { full_name: "A" } },
        ],
      },
    });
    expect(batch).toMatchObject({ id: "b1", status: "previewed", row_count: 3, error_count: 1 });
    expect(batch.rows.map((row) => row.status)).toEqual(["error", "warning", "ok"]);
    expect(batch.rows[0].errors).toEqual([{ message: "Permis manquant" }]);
    expect(batch.rows[1].errors).toEqual([{ field: "phone", message: "Format inhabituel" }]);
    expect(batch.rows[2].data).toEqual({ full_name: "A" });
  });
});
