import type { ColumnDef } from "@tanstack/react-table";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import {
  DataTable,
  RowActions,
  useDataTableState,
  type BulkAction,
  type DataTableProps,
  type DataTableState,
} from "./DataTable";

interface Row {
  id: string;
  code: string;
  name: string;
  volume: number;
  status: string;
}

const ROWS: Row[] = [
  { id: "1", code: "C-03", name: "Akwa", volume: 12000, status: "open" },
  { id: "2", code: "C-01", name: "Bonanjo", volume: 8000, status: "closed" },
  { id: "3", code: "C-02", name: "Deido", volume: 15000, status: "open" },
  { id: "4", code: "C-05", name: "Bali", volume: 5000, status: "open" },
  { id: "5", code: "C-04", name: "Makepe", volume: 9000, status: "closed" },
];

function columns(onCommit = vi.fn(), onDetails = vi.fn()): ColumnDef<Row, unknown>[] {
  return [
    { accessorKey: "code", header: "Code" },
    {
      accessorKey: "name",
      header: "Nom",
      meta: { edit: { type: "text", onCommit, validate: (v) => (v ? undefined : "Nom obligatoire") } },
    },
    {
      accessorKey: "volume",
      header: "Volume",
      meta: {
        align: "right",
        edit: {
          type: "number",
          onCommit,
          validate: (v) => (typeof v === "number" && v > 0 ? undefined : "Volume positif attendu"),
        },
      },
    },
    {
      accessorKey: "status",
      header: "Statut",
      meta: {
        edit: {
          type: "select",
          options: [
            { value: "open", label: "Ouvert" },
            { value: "closed", label: "Fermé" },
          ],
          onCommit,
        },
      },
    },
    {
      id: "actions",
      header: "Actions",
      enableSorting: false,
      cell: ({ row }) => (
        <RowActions items={[{ label: "Détails", onSelect: () => onDetails(row.original) }]} />
      ),
    },
  ];
}

function Harness(
  props: Partial<DataTableProps<Row>> & {
    initial?: Partial<DataTableState>;
    onState?: (s: DataTableState) => void;
  },
) {
  const [state, setState] = useDataTableState(props.initial);
  const [cols] = useState(() => props.columns ?? columns());
  return (
    <TooltipProvider>
      <DataTable<Row>
        caption="Stations de test"
        data={ROWS}
        getRowId={(row) => row.id}
        {...props}
        columns={cols}
        state={state}
        onStateChange={(next) => {
          props.onState?.(next);
          setState(next);
        }}
      />
    </TooltipProvider>
  );
}

const bodyRows = () => screen.getAllByRole("row").slice(1);
const cell = (row: number, col: number) =>
  document.querySelector<HTMLElement>(`[data-cell="${row}:${col}"]`) as HTMLElement;
const names = () => bodyRows().map((row) => within(row).getAllByRole("gridcell")[1].textContent);

describe("DataTable — mode local", () => {
  it("affiche les lignes, trie au clic sur l'en-tête (croissant, décroissant, aucun)", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByRole("grid", { name: "Stations de test" })).toBeInTheDocument();
    expect(names()).toEqual(["Akwa", "Bonanjo", "Deido", "Bali", "Makepe"]);

    const header = screen.getByRole("columnheader", { name: /Code/ });
    await user.click(within(header).getByRole("button"));
    expect(header).toHaveAttribute("aria-sort", "ascending");
    expect(names()).toEqual(["Bonanjo", "Deido", "Akwa", "Makepe", "Bali"]);
    await user.click(within(header).getByRole("button"));
    expect(header).toHaveAttribute("aria-sort", "descending");
    expect(names()[0]).toBe("Bali");
    await user.click(within(header).getByRole("button"));
    expect(header).toHaveAttribute("aria-sort", "none");
    expect(screen.getByRole("columnheader", { name: "Actions" })).not.toHaveAttribute("aria-sort");
  });

  it("recherche, filtre et état vide filtré", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        searchable
        filters={[
          {
            id: "status",
            label: "Statut",
            options: [
              { value: "open", label: "Ouvert" },
              { value: "closed", label: "Fermé" },
            ],
          },
        ]}
      />,
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Statut" }), "closed");
    expect(names()).toEqual(["Bonanjo", "Makepe"]);
    await user.type(screen.getByRole("searchbox"), "make");
    await waitFor(() => expect(names()).toEqual(["Makepe"]));
    await user.type(screen.getByRole("searchbox"), "zzz");
    await waitFor(() =>
      expect(screen.getByText("Aucune ligne ne correspond aux filtres.")).toBeInTheDocument(),
    );
    await user.click(screen.getAllByRole("button", { name: "Effacer les filtres" })[0]);
    await waitFor(() => expect(names()).toHaveLength(5));
  });

  it("pagination : bornes, changement de page et de taille", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ pageSize: 2 }} />);
    expect(names()).toEqual(["Akwa", "Bonanjo"]);
    expect(screen.getByText("1–2 sur 5")).toBeInTheDocument();
    expect(screen.getByText("Page 1 / 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Page précédente" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Page suivante" }));
    expect(names()).toEqual(["Deido", "Bali"]);
    await user.click(screen.getByRole("button", { name: "Dernière page" }));
    expect(names()).toEqual(["Makepe"]);
    expect(screen.getByText("5–5 sur 5")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Page suivante" })).toBeDisabled();
    await user.selectOptions(screen.getByRole("combobox", { name: /Lignes par page/ }), "25");
    expect(names()).toHaveLength(5);
  });
});

describe("DataTable — clavier", () => {
  it("navigation par flèches, Début / Fin, Ctrl+Fin, changement de page", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ pageSize: 3 }} />);
    expect(cell(0, 0)).toHaveAttribute("tabindex", "0");
    expect(cell(1, 0)).toHaveAttribute("tabindex", "-1");
    cell(0, 0).focus();
    await user.keyboard("{ArrowDown}{ArrowRight}");
    expect(cell(1, 1)).toHaveFocus();
    expect(cell(1, 1)).toHaveAttribute("tabindex", "0");
    await user.keyboard("{End}");
    expect(cell(1, 4)).toHaveFocus();
    await user.keyboard("{Home}{ArrowUp}{ArrowUp}{ArrowLeft}");
    expect(cell(0, 0)).toHaveFocus();
    await user.keyboard("{Control>}{End}{/Control}");
    expect(cell(2, 4)).toHaveFocus();
    await user.keyboard("{PageDown}");
    await waitFor(() => expect(names()).toEqual(["Bali", "Makepe"]));
    await waitFor(() => expect(document.activeElement).toHaveAttribute("data-cell"));
    await user.keyboard("{PageUp}");
    await waitFor(() => expect(names()).toHaveLength(3));
  });

  it("édition : Entrée ouvre, Entrée valide (nombre analysé), Échap annule, validation bloquante", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness columns={columns(onCommit)} />);
    cell(0, 2).focus();
    await user.keyboard("{Enter}");
    const input = within(cell(0, 2)).getByRole("textbox");
    expect(input).toHaveValue("12000");
    await user.clear(input);
    await user.type(input, "13 500,5{Enter}");
    expect(onCommit).toHaveBeenCalledWith(ROWS[0], 13500.5);
    await waitFor(() => expect(within(cell(0, 2)).queryByRole("textbox")).not.toBeInTheDocument());
    await waitFor(() => expect(cell(0, 2)).toHaveFocus());

    // Valeur refusée : message affiché, rien n'est enregistré, la cellule reste en édition.
    onCommit.mockClear();
    await user.keyboard("{F2}");
    const again = within(cell(0, 2)).getByRole("textbox");
    await user.clear(again);
    await user.type(again, "-4{Enter}");
    expect(within(cell(0, 2)).getByRole("alert")).toHaveTextContent("Volume positif attendu");
    expect(onCommit).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(within(cell(0, 2)).queryByRole("textbox")).not.toBeInTheDocument();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("saisie directe remplace la valeur ; Tab valide et passe à la cellule suivante ; liste déroulante", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness columns={columns(onCommit)} />);
    cell(1, 1).focus();
    await user.keyboard("N");
    const input = within(cell(1, 1)).getByRole("textbox");
    expect(input).toHaveValue("N");
    await user.type(input, "ew Bell{Tab}");
    expect(onCommit).toHaveBeenCalledWith(ROWS[1], "New Bell");
    await waitFor(() => expect(cell(1, 2)).toHaveFocus());

    await user.keyboard("{ArrowRight}{Enter}");
    const select = within(cell(1, 3)).getByRole("combobox");
    await user.selectOptions(select, "open");
    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenLastCalledWith(ROWS[1], "open");
  });

  it("une erreur d'enregistrement laisse la cellule en édition", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn().mockRejectedValue(new Error("refus du serveur"));
    render(<Harness columns={columns(onCommit)} />);
    cell(0, 1).focus();
    await user.keyboard("{Enter}");
    await user.type(within(cell(0, 1)).getByRole("textbox"), "x{Enter}");
    await waitFor(() => expect(onCommit).toHaveBeenCalled());
    expect(within(cell(0, 1)).getByRole("textbox")).toBeInTheDocument();
  });

  it("Entrée sur une cellule non éditable ouvre la ligne ; sur la cellule d'actions, ouvre le menu", async () => {
    const user = userEvent.setup();
    const onRowActivate = vi.fn();
    const onDetails = vi.fn();
    render(<Harness columns={columns(vi.fn(), onDetails)} onRowActivate={onRowActivate} />);
    cell(2, 0).focus();
    await user.keyboard("{Enter}");
    expect(onRowActivate).toHaveBeenCalledWith(ROWS[2]);
    await user.keyboard("{End}{Enter}");
    await user.click(await screen.findByRole("menuitem", { name: "Détails" }));
    expect(onDetails).toHaveBeenCalledWith(ROWS[2]);
    expect(onRowActivate).toHaveBeenCalledTimes(1);
  });

  it("double-clic : édite la cellule éditable, sinon ouvre la ligne", async () => {
    const user = userEvent.setup();
    const onRowActivate = vi.fn();
    render(<Harness onRowActivate={onRowActivate} />);
    await user.dblClick(cell(3, 0));
    expect(onRowActivate).toHaveBeenCalledWith(ROWS[3]);
    await user.dblClick(cell(3, 1));
    expect(within(cell(3, 1)).getByRole("textbox")).toHaveValue("Bali");
    expect(onRowActivate).toHaveBeenCalledTimes(1);
  });
});

describe("DataTable — sélection et actions en masse", () => {
  it("Espace sélectionne, Ctrl+A sélectionne la page, Échap vide ; l'action reçoit les lignes", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn().mockResolvedValue(undefined);
    const bulk: BulkAction<Row>[] = [
      { label: "Confirmer", onClick },
      { label: "Supprimer", destructive: true, onClick: vi.fn() },
    ];
    render(<Harness selectable bulkActions={bulk} />);
    expect(screen.queryByRole("button", { name: "Confirmer" })).not.toBeInTheDocument();

    cell(0, 1).focus();
    await user.keyboard(" {ArrowDown}{ArrowDown} ");
    expect(screen.getByText("2 lignes sélectionnées")).toBeInTheDocument();
    expect(bodyRows()[0]).toHaveAttribute("aria-selected", "true");
    expect(bodyRows()[1]).toHaveAttribute("aria-selected", "false");

    await user.click(screen.getByRole("button", { name: "Confirmer" }));
    expect(onClick).toHaveBeenCalledWith([ROWS[0], ROWS[2]]);
    await waitFor(() => expect(screen.queryByText(/sélectionnée/)).not.toBeInTheDocument());

    cell(0, 1).focus();
    await user.keyboard("{Control>}a{/Control}");
    expect(screen.getByText("5 lignes sélectionnées")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByText(/sélectionnée/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Sélectionner toutes les lignes de la page" }));
    expect(screen.getByText("5 lignes sélectionnées")).toBeInTheDocument();
    await user.click(screen.getAllByRole("checkbox", { name: "Sélectionner la ligne" })[0]);
    expect(screen.getByText("4 lignes sélectionnées")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tout désélectionner" }));
    expect(screen.queryByText(/sélectionnée/)).not.toBeInTheDocument();
  });

  it("la sélection est conservée si l'action échoue", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        selectable
        bulkActions={[{ label: "Confirmer", onClick: vi.fn().mockRejectedValue(new Error("non")) }]}
      />,
    );
    cell(0, 1).focus();
    await user.keyboard(" ");
    await user.click(screen.getByRole("button", { name: "Confirmer" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirmer" })).toBeEnabled());
    expect(screen.getByText("1 ligne sélectionnée")).toBeInTheDocument();
  });
});

describe("DataTable — mode serveur", () => {
  it("le tri, la recherche et la pagination sont délégués (état remonté, lignes non retriées)", async () => {
    const user = userEvent.setup();
    const onState = vi.fn();
    render(<Harness total={132} searchable serverSort onState={onState} />);
    expect(screen.getByText("1–50 sur 132")).toBeInTheDocument();
    expect(screen.getByText("Page 1 / 3")).toBeInTheDocument();

    await user.click(within(screen.getByRole("columnheader", { name: /Code/ })).getByRole("button"));
    expect(onState).toHaveBeenLastCalledWith(
      expect.objectContaining({ sorting: [{ id: "code", desc: false }], pageIndex: 0 }),
    );
    expect(names()[0]).toBe("Akwa");

    await user.click(screen.getByRole("button", { name: "Page suivante" }));
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ pageIndex: 1 }));
    expect(screen.getByText("51–100 sur 132")).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox"), "akwa");
    await waitFor(() =>
      expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ search: "akwa", pageIndex: 0 })),
    );
  });

  it("sans `serverSort`, les en-têtes ne sont pas triables (l'API n'offre pas de tri)", () => {
    render(<Harness total={132} />);
    const header = screen.getByRole("columnheader", { name: /Code/ });
    expect(within(header).queryByRole("button")).not.toBeInTheDocument();
    expect(header).not.toHaveAttribute("aria-sort");
  });

  it("`onRowsChange` reçoit les lignes retenues par la recherche et les filtres, toutes pages confondues", async () => {
    const user = userEvent.setup();
    const onRowsChange = vi.fn();
    render(
      <Harness
        initial={{ pageSize: 2 }}
        onRowsChange={onRowsChange}
        filters={[{ id: "status", label: "Statut", options: [{ value: "open", label: "Ouvert" }] }]}
      />,
    );
    await waitFor(() => expect(onRowsChange).toHaveBeenLastCalledWith(ROWS));
    await user.selectOptions(screen.getByRole("combobox", { name: "Statut" }), "open");
    await waitFor(() => expect(onRowsChange).toHaveBeenLastCalledWith([ROWS[0], ROWS[2], ROWS[3]]));
  });

  it("états : chargement, erreur avec nouvel essai, vide", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = render(<Harness data={[]} total={0} loading />);
    expect(screen.getByRole("grid")).toHaveAttribute("aria-rowcount", "0");
    expect(document.querySelectorAll("tbody tr[aria-hidden]")).toHaveLength(8);

    rerender(<Harness data={[]} total={0} error={new Error("Serveur injoignable")} onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Serveur injoignable");
    await user.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(onRetry).toHaveBeenCalled();

    rerender(<Harness data={[]} total={0} empty="Aucune station. Créez-en une." />);
    expect(screen.getByText("Aucune station. Créez-en une.")).toBeInTheDocument();
  });
});
