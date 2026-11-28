import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FilterChip, FilterChipGroup } from "./FilterChip";
import { NumberInput } from "./forms";
import { SegmentedProgress } from "./SegmentedProgress";
import { StatusBadge } from "./StatusBadge";
import { Steps } from "./Steps";

describe("Steps — frise d'étapes", () => {
  const steps = [
    { id: "planned", label: "Planifiée" },
    { id: "loaded", label: "Chargée" },
    { id: "completed", label: "Terminée" },
  ] as const;

  it("étapes passées cochées, étape courante annoncée, suivantes numérotées", () => {
    render(<Steps label="Avancement" steps={steps} current="loaded" />);
    const items = within(screen.getByRole("list", { name: "Avancement" })).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-state"))).toEqual(["done", "current", "todo"]);
    expect(items[1]).toHaveAttribute("aria-current", "step");
    expect(items[0]).not.toHaveAttribute("aria-current");
    expect(items[0]).toHaveTextContent(/^Planifiée$/);
    expect(items[2]).toHaveTextContent("3Terminée");
  });

  it("aucune étape courante : tout reste à faire", () => {
    render(<Steps label="Avancement" steps={steps} current={null} />);
    expect(screen.getAllByRole("listitem").every((item) => item.getAttribute("data-state") === "todo")).toBe(
      true,
    );
  });
});

describe("SegmentedProgress — barre d'avancement segmentée", () => {
  it("un segment par élément, valeur exposée aux lecteurs d'écran", () => {
    render(<SegmentedProgress done={2} total={5} label="2 arrêts livrés sur 5" />);
    const bar = screen.getByRole("progressbar", { name: "2 arrêts livrés sur 5" });
    expect(bar).toHaveAttribute("aria-valuenow", "2");
    expect(bar).toHaveAttribute("aria-valuemax", "5");
    expect([...bar.children].map((segment) => segment.getAttribute("data-segment"))).toEqual([
      "success",
      "success",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("segments colorés un par un ; barre continue au-delà de maxSegments", () => {
    const { rerender } = render(
      <SegmentedProgress segments={["success", "warning", "pending"]} label="Arrêts" />,
    );
    const bar = screen.getByRole("progressbar", { name: "Arrêts" });
    expect(bar).toHaveAttribute("aria-valuenow", "2");
    expect(bar.children[1]).toHaveAttribute("data-segment", "warning");
    rerender(<SegmentedProgress done={30} total={60} label="Arrêts" />);
    expect(screen.getByRole("progressbar", { name: "Arrêts" }).children).toHaveLength(1);
  });
});

describe("FilterChip — puce de filtre à compteur", () => {
  it("bouton à bascule avec compteur, regroupé sous un nom", async () => {
    const onClick = vi.fn();
    render(
      <FilterChipGroup label="Filtrer par type">
        <FilterChip label="Tous" count={1250} pressed onClick={() => undefined} />
        <FilterChip label="Pannes" count={0} pressed={false} onClick={onClick} />
        <FilterChip label="Sans compteur" pressed={false} />
      </FilterChipGroup>,
    );
    const group = screen.getByRole("group", { name: "Filtrer par type" });
    expect(within(group).getByRole("button", { name: /Tous/, pressed: true })).toHaveTextContent(
      /Tous1\s250/,
    );
    const breakdowns = within(group).getByRole("button", { name: /Pannes/, pressed: false });
    await userEvent.click(breakdowns);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(within(group).getByRole("button", { name: "Sans compteur" })).toHaveTextContent(/^Sans compteur$/);
  });
});

describe("StatusBadge — famille « event »", () => {
  it("libellé et couleur par type d'événement", () => {
    render(
      <>
        <StatusBadge kind="event" value="truck_breakdown" />
        <StatusBadge kind="event" value="publish" />
      </>,
    );
    expect(screen.getByText("Panne de camion").className).toContain("text-blocking");
    expect(screen.getByText("Publication").className).toContain("text-success");
  });
});

describe("NumberInput — unité", () => {
  it("la largeur fixée par className dimensionne l'ensemble champ + unité", () => {
    render(
      <NumberInput
        aria-label="Volume"
        value={12000}
        onChange={() => undefined}
        unit="L"
        className="h-10 w-24 text-base"
      />,
    );
    const input = screen.getByRole("textbox", { name: "Volume" });
    const wrapper = input.parentElement as HTMLElement;
    // L'unité est positionnée par rapport à l'enveloppe : c'est elle qui porte la largeur.
    expect(wrapper.className).toContain("w-24");
    expect(wrapper).toHaveTextContent("L");
    expect(input.className).toContain("w-full");
    expect(input.className).not.toContain("w-24");
    expect(input.className).toContain("h-10");
    expect(input.className).toContain("text-base");
  });

  it("sans largeur imposée : rien ne change (enveloppe pleine largeur)", () => {
    render(<NumberInput aria-label="Durée" value={45} onChange={() => undefined} unit="min" />);
    const wrapper = screen.getByRole("textbox", { name: "Durée" }).parentElement as HTMLElement;
    expect(wrapper.className.trim()).toBe("relative");
  });
});
