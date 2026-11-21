import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { addDays, todayLocal } from "@/lib/format";
import type { Violation } from "@/lib/types";
import { API } from "@/mocks/handlers/helpers";
import { server } from "@/mocks/server";
import { loginAs, renderWithProviders } from "@/test/utils";

import { ConfirmDialog, ConfirmProvider, useConfirm } from "./ConfirmDialog";
import { PdfButton } from "./PdfButton";
import { SortableList } from "./SortableList";
import { EmptyState, ErrorState, LoadingState } from "./states";
import { ExpiryBadge, expiryState, StatusBadge } from "./StatusBadge";
import { sortViolations, ViolationsPanel } from "./ViolationsPanel";

const VIOLATIONS: Violation[] = [
  { rule_code: "RM-10", severity: "warning", message: "Arrivée 20 min après la fermeture de la fenêtre" },
  {
    rule_code: "RM-05",
    severity: "blocking",
    message: "Compartiment 2 : 9 400 L pour 9 000 L",
    trip_id: "t1",
  },
  { rule_code: "RM-11", severity: "blocking", message: "Durée de service 11 h 40 > 11 h" },
  { rule_code: "RM-03", severity: "blocking", message: "Permis expiré" },
];

describe("ViolationsPanel", () => {
  it("bloquantes d'abord, code RM-xx, compteurs par gravité", () => {
    render(<ViolationsPanel violations={VIOLATIONS} />);
    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-severity"))).toEqual([
      "blocking",
      "blocking",
      "blocking",
      "warning",
    ]);
    expect(items.map((item) => within(item).getByText(/^RM-\d+$/).textContent)).toEqual([
      "RM-03",
      "RM-05",
      "RM-11",
      "RM-10",
    ]);
    expect(screen.getByText("3 bloquantes")).toBeInTheDocument();
    expect(screen.getByText("1 avertissement")).toBeInTheDocument();
    expect(items[0]).toHaveClass("border-l-blocking");
    expect(items[3]).toHaveClass("border-l-warning");
    expect(sortViolations(VIOLATIONS)[0].rule_code).toBe("RM-03");
  });

  it("aucune violation : message explicite, ou panneau masqué sur demande", () => {
    const { rerender } = render(<ViolationsPanel violations={[]} />);
    expect(screen.getByText("Aucune violation.")).toBeInTheDocument();
    rerender(<ViolationsPanel violations={null} hideWhenEmpty />);
    expect(screen.queryByTestId("violations-panel")).not.toBeInTheDocument();
  });

  it("ligne activable : renvoie la violation choisie", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ViolationsPanel violations={VIOLATIONS} onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: /RM-05/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ rule_code: "RM-05", trip_id: "t1" }));
  });
});

describe("ConfirmDialog", () => {
  it("action destructive : focus sur Annuler, rien sans confirmation explicite", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
        title="Supprimer ?"
        description="« OLA Akwa » sera supprimé."
        destructive
      />,
    );
    const dialog = screen.getByRole("alertdialog", { name: "Supprimer ?" });
    expect(dialog).toHaveTextContent("« OLA Akwa » sera supprimé.");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Annuler" })).toHaveFocus());
    await user.keyboard("{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("confirmation asynchrone : attente affichée puis fermeture", async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
        title="Publier ?"
        confirmLabel="Publier"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Publier" }));
    expect(screen.getByRole("button", { name: "Publier" })).toBeDisabled();
    expect(onOpenChange).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("useConfirm : promesse résolue à vrai ou faux", async () => {
    const user = userEvent.setup();
    const results: boolean[] = [];
    function Probe() {
      const confirm = useConfirm();
      return (
        <button
          onClick={async () =>
            results.push(await confirm({ title: "Supprimer 3 éléments ?", destructive: true }))
          }
        >
          demander
        </button>
      );
    }
    render(
      <ConfirmProvider>
        <Probe />
      </ConfirmProvider>,
    );
    await user.click(screen.getByRole("button", { name: "demander" }));
    await user.click(await screen.findByRole("button", { name: "Supprimer" }));
    await waitFor(() => expect(results).toEqual([true]));
    await user.click(screen.getByRole("button", { name: "demander" }));
    await user.click(await screen.findByRole("button", { name: "Annuler" }));
    await waitFor(() => expect(results).toEqual([true, false]));
  });
});

describe("pastilles de statut", () => {
  it("libellé français et ton par statut", () => {
    render(
      <>
        <StatusBadge kind="truck" value="broken" />
        <StatusBadge kind="order" value="confirmed" />
        <StatusBadge kind="trip" value="in_progress" />
        <StatusBadge kind="active" value={false} />
        <StatusBadge kind="driver" value={null} />
      </>,
    );
    expect(screen.getByText("En panne")).toHaveClass("text-blocking");
    expect(screen.getByText("Confirmée")).toHaveClass("text-info");
    expect(screen.getByText("En cours")).toHaveClass("text-warning");
    expect(screen.getByText("Inactif")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("ExpiryBadge : expiré (rouge), proche (orange), valide, non renseigné", () => {
    const today = "2027-01-12";
    expect(expiryState("2027-01-11", today)).toBe("expired");
    expect(expiryState("2027-01-12", today)).toBe("soon");
    expect(expiryState("2027-02-11", today)).toBe("soon");
    expect(expiryState("2027-02-12", today)).toBe("valid");
    expect(expiryState(null, today)).toBe("missing");

    render(
      <>
        <ExpiryBadge date="2027-01-02" today={today} />
        <ExpiryBadge date="2027-01-21" today={today} />
        <ExpiryBadge date="2027-01-12" today={today} />
        <ExpiryBadge date="2028-03-01" today={today} />
        <ExpiryBadge date={null} today={today} />
      </>,
    );
    expect(screen.getByText("Expiré le 02/01/2027")).toHaveAttribute("data-expiry", "expired");
    expect(screen.getByText("Expire dans 9 j (21/01/2027)")).toHaveAttribute("data-expiry", "soon");
    expect(screen.getByText("Expire aujourd'hui")).toBeInTheDocument();
    expect(screen.getByText("01/03/2028")).toBeInTheDocument();
    expect(screen.getByText("Date non renseignée")).toBeInTheDocument();
    expect(expiryState(addDays(todayLocal(), -1))).toBe("expired");
  });
});

describe("états", () => {
  it("vide, chargement, erreur avec codes de règle et nouvel essai", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { ApiError } = await import("@/lib/api/errors");
    render(
      <>
        <EmptyState
          title="Aucune commande"
          description="Importez un fichier."
          action={<button>Importer</button>}
        />
        <LoadingState label="Calcul en cours…" />
        <ErrorState
          error={
            new ApiError(409, {
              code: "rule_violation",
              message: "Publication refusée.",
              details: [{ rule_code: "RM-08" }],
            })
          }
          onRetry={onRetry}
        />
      </>,
    );
    expect(screen.getByText("Aucune commande")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Calcul en cours…");
    expect(screen.getByRole("alert")).toHaveTextContent("Publication refusée.");
    expect(screen.getByRole("alert")).toHaveTextContent("RM-08");
    await user.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe("PdfButton", () => {
  it("télécharge le PDF avec le jeton et propose l'enregistrement", async () => {
    loginAs("manager");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    let auth: string | null = null;
    let query = "";
    server.use(
      http.get(`${API}/comparison.pdf`, ({ request }) => {
        auth = request.headers.get("authorization");
        query = new URL(request.url).search;
        return new HttpResponse("%PDF-1.7", {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": 'attachment; filename="comparaison_A_B.pdf"',
          },
        });
      }),
    );
    const { user } = renderWithProviders(
      <PdfButton path="/comparison.pdf" query={{ plan_a: "a", plan_b: "b" }} label="Rapport A/B" />,
    );
    await user.click(screen.getByRole("button", { name: "Rapport A/B" }));
    expect(await screen.findByText("comparaison_A_B.pdf téléchargé")).toBeInTheDocument();
    expect(auth).toMatch(/^Bearer mock\.access\./);
    expect(query).toBe("?plan_a=a&plan_b=b");
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it("signale l'échec sans rien enregistrer", async () => {
    loginAs("manager");
    server.use(
      http.get(`${API}/trips/t1/route-sheet.pdf`, () =>
        HttpResponse.json(
          { code: "not_found", message: "Tournée introuvable.", details: [] },
          { status: 404 },
        ),
      ),
    );
    const { user } = renderWithProviders(<PdfButton path="/trips/t1/route-sheet.pdf" />);
    await user.click(screen.getByRole("button", { name: "Télécharger le PDF" }));
    expect(await screen.findByText("Tournée introuvable.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Télécharger le PDF" })).toBeEnabled();
  });
});

describe("SortableList", () => {
  it("poignées accessibles au clavier ; une saisie annulée ne réordonne rien", async () => {
    const user = userEvent.setup();
    const onReorder = vi.fn();
    function Harness() {
      const [items, setItems] = useState([
        { id: "a", name: "Akwa" },
        { id: "b", name: "Bali" },
        { id: "c", name: "Deido" },
      ]);
      return (
        <SortableList
          items={items}
          getId={(item) => item.id}
          handleLabel={(item) => `Déplacer ${item.name}`}
          onReorder={(next, move) => {
            onReorder(
              next.map((item) => item.name),
              move,
            );
            setItems(next);
          }}
          renderItem={(item, handle) => (
            <div>
              {handle}
              <span>{item.name}</span>
            </div>
          )}
        />
      );
    }
    render(<Harness />);
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Akwa",
      "Bali",
      "Deido",
    ]);
    expect(screen.getByRole("button", { name: "Déplacer Bali" })).toBeInTheDocument();
    // jsdom ne calcule pas de géométrie : on vérifie le câblage (poignées accessibles, pas de réordonnancement fantôme).
    screen.getByRole("button", { name: "Déplacer Akwa" }).focus();
    await user.keyboard(" ");
    await user.keyboard("{Escape}");
    expect(onReorder).not.toHaveBeenCalled();
  });
});
