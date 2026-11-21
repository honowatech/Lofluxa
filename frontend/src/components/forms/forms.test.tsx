import { screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { renderWithProviders } from "@/test/utils";

import {
  CoordinatesField,
  DateInput,
  EntityFormDialog,
  parseDayInput,
  parseCoordinatePair,
  LitersField,
  normalizeTime,
  NumberField,
  OpeningHoursField,
  SelectField,
  summarizeOpeningHours,
  TextField,
  TimeField,
  zLat,
  zLiters,
  zLon,
  zOpeningHours,
  zOptionalNumber,
  zOptionalText,
  zText,
  zTimeHM,
} from ".";

const schema = z.object({
  code: zText(8),
  note: zOptionalText(40),
  volume_l: zLiters(),
  unload_min: zOptionalNumber({ min: 0, max: 600, integer: true }),
  start: zTimeHM,
  size: z.enum(["small", "large"]),
  lat: zLat,
  lon: zLon,
  opening_hours: zOpeningHours,
});

const DEFAULTS = {
  code: "",
  note: "",
  volume_l: null,
  unload_min: null,
  start: "06:00",
  size: "large" as const,
  lat: null,
  lon: null,
  opening_hours: {},
};

function setup(onSubmit = vi.fn().mockResolvedValue(undefined), defaults: Partial<typeof DEFAULTS> = {}) {
  const onOpenChange = vi.fn();
  const view = renderWithProviders(
    <EntityFormDialog
      open
      onOpenChange={onOpenChange}
      title="Formulaire de test"
      schema={schema}
      defaultValues={{ ...DEFAULTS, ...defaults }}
      onSubmit={onSubmit}
    >
      <TextField name="code" label="Code" required uppercase />
      <TextField name="note" label="Note" required={false} />
      <LitersField name="volume_l" label="Volume" required />
      <NumberField name="unload_min" label="Dépotage" unit="min" required={false} />
      <TimeField name="start" label="Début" />
      <SelectField
        name="size"
        label="Gabarit"
        options={[
          { value: "small", label: "Petit" },
          { value: "large", label: "Grand" },
        ]}
      />
      <CoordinatesField latName="lat" lonName="lon" />
      <OpeningHoursField name="opening_hours" />
    </EntityFormDialog>,
  );
  return { ...view, onSubmit, onOpenChange };
}

describe("champs de formulaire (react-hook-form + zod)", () => {
  it("valeurs soumises typées : litres en nombre, vide → null, texte normalisé", async () => {
    const { user, onSubmit, onOpenChange } = setup();
    await user.type(screen.getByLabelText(/^Code/), "dla-9");
    await user.type(screen.getByLabelText(/^Volume/), "12 500,5");
    await user.tab();
    expect(screen.getByLabelText(/^Volume/)).toHaveValue("12 500,50");
    await user.clear(screen.getByLabelText(/^Début/));
    await user.type(screen.getByLabelText(/^Début/), "630");
    await user.tab();
    expect(screen.getByLabelText(/^Début/)).toHaveValue("06:30");
    await user.selectOptions(screen.getByLabelText(/^Gabarit/), "small");
    await user.type(screen.getByLabelText(/^Latitude/), "4,0511");
    await user.type(screen.getByLabelText(/^Longitude/), "9.7679");
    await user.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toEqual({
      code: "DLA-9",
      note: null,
      volume_l: 12500.5,
      unload_min: null,
      start: "06:30",
      size: "small",
      lat: 4.0511,
      lon: 9.7679,
      opening_hours: {},
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("erreurs de validation en français, reliées aux champs ; rien n'est soumis", async () => {
    const { user, onSubmit } = setup();
    await user.type(screen.getByLabelText(/^Volume/), "-5");
    await user.type(screen.getByLabelText(/^Dépotage/), "12,5");
    await user.type(screen.getByLabelText(/^Latitude/), "120");
    await user.type(screen.getByLabelText(/^Longitude/), "abc");
    await user.clear(screen.getByLabelText(/^Début/));
    await user.type(screen.getByLabelText(/^Début/), "25h");
    await user.click(screen.getByRole("button", { name: "Enregistrer" }));

    expect(await screen.findByText("Le volume doit être positif")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Code/)).toHaveAccessibleDescription("Champ obligatoire");
    expect(screen.getByLabelText(/^Code/)).toBeInvalid();
    expect(screen.getByLabelText(/^Dépotage/)).toHaveAccessibleDescription("Nombre entier attendu");
    expect(screen.getByLabelText(/^Latitude/)).toHaveAccessibleDescription("Maximum 90");
    expect(screen.getByLabelText(/^Longitude/)).toHaveAccessibleDescription("Nombre invalide");
    expect(screen.getByLabelText(/^Début/)).toHaveAccessibleDescription("Heure invalide (HH:mm)");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("coordonnées : coller « lat, lon » remplit les deux champs ; clic sur la mini-carte place le point", async () => {
    const { user } = setup();
    await user.click(screen.getByLabelText(/^Latitude/));
    await user.paste("4.0483, 9.7043");
    expect(screen.getByLabelText(/^Latitude/)).toHaveValue("4,0483");
    expect(screen.getByLabelText(/^Longitude/)).toHaveValue("9,7043");
    const map = screen.getByTestId("schematic-map");
    expect(map.querySelector('[data-point="__current"]')).not.toBeNull();

    await user.click(map);
    const lat = Number(
      String((screen.getByLabelText(/^Latitude/) as HTMLInputElement).value).replace(",", "."),
    );
    expect(lat).not.toBe(4.0483);
    expect(Math.abs(lat - 4.05)).toBeLessThan(0.5);
  });

  it("horaires d'ouverture : continu ↔ par jour, plages, copie, contrôles", async () => {
    const { user, onSubmit } = setup(undefined, {
      code: "A",
      volume_l: 1000 as never,
      lat: 4 as never,
      lon: 9 as never,
    });
    expect(screen.getByText("Ouvert en continu (horaires non renseignés)")).toBeInTheDocument();
    await user.click(screen.getByRole("switch"));
    const monday = screen.getByRole("group", { name: "Lundi" });
    const sunday = screen.getByRole("group", { name: "Dimanche" });
    expect(within(monday).getByLabelText("Lundi de")).toHaveValue("06:00");
    expect(within(sunday).getByText("Fermé")).toBeInTheDocument();

    // Lundi : 06:00–12:00 puis 14:00–18:00, recopié sur les jours ouvrés.
    await user.clear(within(monday).getByLabelText("Lundi à"));
    await user.type(within(monday).getByLabelText("Lundi à"), "12");
    await user.click(within(monday).getByRole("button", { name: "Ajouter une plage (Lundi)" }));
    const starts = within(monday).getAllByLabelText("Lundi de");
    const ends = within(monday).getAllByLabelText("Lundi à");
    await user.clear(starts[1]);
    await user.type(starts[1], "14:00");
    await user.clear(ends[1]);
    await user.type(ends[1], "18h");
    await user.tab();
    await user.click(screen.getByRole("button", { name: /Copier le lundi/ }));
    await user.click(
      within(screen.getByRole("group", { name: "Samedi" })).getByRole("button", {
        name: "Retirer la plage (Samedi)",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const split = [
      ["06:00", "12:00"],
      ["14:00", "18:00"],
    ];
    expect(onSubmit.mock.calls[0][0].opening_hours).toEqual({
      mon: split,
      tue: split,
      wed: split,
      thu: split,
      fri: split,
      sat: [],
      sun: [],
    });
  });

  it("horaires : fin avant début et chevauchement refusés", async () => {
    const { user, onSubmit } = setup(undefined, {
      code: "A",
      volume_l: 1000 as never,
      lat: 4 as never,
      lon: 9 as never,
      opening_hours: {
        mon: [
          ["06:00", "12:00"],
          ["11:00", "18:00"],
        ],
        tue: [["18:00", "06:00"]],
      } as never,
    });
    await user.click(screen.getByRole("button", { name: "Enregistrer" }));
    expect(await within(screen.getByRole("group", { name: "Lundi" })).findByRole("alert")).toHaveTextContent(
      "ne doivent pas se chevaucher",
    );
    expect(within(screen.getByRole("group", { name: "Mardi" })).getByRole("alert")).toHaveTextContent(
      "La fin doit être après le début",
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("erreurs du serveur reportées sur les champs ; la boîte reste ouverte", async () => {
    const onSubmit = vi.fn().mockRejectedValue(
      new ApiError(409, {
        code: "conflict",
        message: "Station : « DLA-9 » existe déjà.",
        details: [{ field: "body.code", message: "Valeur déjà utilisée" }],
      }),
    );
    const { user, onOpenChange } = setup(onSubmit, {
      code: "DLA-9",
      volume_l: 1000 as never,
      lat: 4 as never,
      lon: 9 as never,
    });
    await user.click(screen.getByRole("button", { name: "Enregistrer" }));
    expect(await screen.findByText("Station : « DLA-9 » existe déjà.")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Code/)).toHaveAccessibleDescription("Valeur déjà utilisée");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("fermeture avec modifications : confirmation avant d'abandonner", async () => {
    const { user, onOpenChange } = setup();
    await user.click(screen.getByRole("button", { name: "Annuler" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    onOpenChange.mockClear();

    await user.type(screen.getByLabelText(/^Code/), "X");
    await user.click(screen.getByRole("button", { name: "Annuler" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Abandonner les modifications ?" });
    await user.click(within(confirm).getByRole("button", { name: "Continuer la saisie" }));
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Annuler" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Abandonner" }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});

describe("SelectField", () => {
  it("accepte `autoFocus` (premier champ d'une petite boîte)", () => {
    const schema1 = z.object({ size: z.enum(["small", "large"]) });
    renderWithProviders(
      <EntityFormDialog
        open
        onOpenChange={() => {}}
        title="Gabarit"
        schema={schema1}
        defaultValues={{ size: "large" }}
        onSubmit={vi.fn()}
      >
        <SelectField
          name="size"
          label="Gabarit"
          autoFocus
          options={[
            { value: "small", label: "Petit" },
            { value: "large", label: "Grand" },
          ]}
        />
      </EntityFormDialog>,
    );
    expect(screen.getByRole("combobox", { name: /^Gabarit/ })).toHaveFocus();
  });
});

describe("DateInput — date en jj/mm/aaaa", () => {
  it("affiche en français, accepte la saisie, se vide si facultatif", async () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState<string | null>("2027-01-12");
      return (
        <DateInput
          aria-label="Expiration"
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }
    const { user } = renderWithProviders(<Harness />);
    const field = screen.getByLabelText("Expiration");
    expect(field).toHaveValue("12/01/2027");
    expect(field).toHaveAttribute("placeholder", "jj/mm/aaaa");
    await user.clear(field);
    expect(onChange).toHaveBeenLastCalledWith(null);
    await user.type(field, "3/9/27");
    expect(onChange).toHaveBeenLastCalledWith("2027-09-03");
    await user.tab();
    expect(field).toHaveValue("03/09/2027");
    await user.click(field);
    await user.keyboard("{ArrowDown}");
    expect(onChange).toHaveBeenLastCalledWith("2027-09-02");
    // Le sélecteur natif n'est ni dans le parcours clavier ni exposé aux lecteurs d'écran.
    const native = document.querySelector('input[type="date"]') as HTMLInputElement;
    expect(native).toHaveAttribute("tabindex", "-1");
    expect(native).toHaveAttribute("aria-hidden", "true");
    expect(native).toHaveValue("2027-09-02");
  });
});

describe("aides", () => {
  it("normalizeTime accepte les saisies rapides", () => {
    expect(normalizeTime("630")).toBe("06:30");
    expect(normalizeTime("6")).toBe("06:00");
    expect(normalizeTime("6h30")).toBe("06:30");
    expect(normalizeTime("18:5")).toBe("18:50");
    expect(normalizeTime("1430")).toBe("14:30");
    expect(normalizeTime("25:00")).toBe("25:00");
    expect(normalizeTime("")).toBe("");
  });

  it("parseCoordinatePair : point ou virgule décimale, valeurs hors bornes refusées", () => {
    expect(parseCoordinatePair("4.0483, 9.7043")).toEqual({ lat: 4.0483, lon: 9.7043 });
    expect(parseCoordinatePair("4,0483 ; 9,7043")).toEqual({ lat: 4.0483, lon: 9.7043 });
    expect(parseCoordinatePair(" 4,0483\t9,7043 ")).toEqual({ lat: 4.0483, lon: 9.7043 });
    expect(parseCoordinatePair("-4.5,-9")).toEqual({ lat: -4.5, lon: -9 });
    expect(parseCoordinatePair("120, 9")).toBeNull();
    expect(parseCoordinatePair("OLA Akwa")).toBeNull();
    expect(parseCoordinatePair("4.05")).toBeNull();
  });

  it("parseDayInput : formats de saisie acceptés, dates impossibles refusées", () => {
    expect(parseDayInput("12/01/2027")).toBe("2027-01-12");
    expect(parseDayInput("1/2/27")).toBe("2027-02-01");
    expect(parseDayInput("12-01-2027")).toBe("2027-01-12");
    expect(parseDayInput("12.01.2027")).toBe("2027-01-12");
    expect(parseDayInput("12012027")).toBe("2027-01-12");
    expect(parseDayInput("120127")).toBe("2027-01-12");
    expect(parseDayInput("2027-01-12")).toBe("2027-01-12");
    expect(parseDayInput("31/02/2027")).toBeNull();
    expect(parseDayInput("01/13/2027")).toBeNull();
    expect(parseDayInput("12/01")).toBeNull();
    expect(parseDayInput("")).toBeNull();
  });

  it("summarizeOpeningHours regroupe les jours identiques", () => {
    const day: [string, string][] = [["06:00", "18:00"]];
    expect(summarizeOpeningHours({})).toBe("En continu");
    expect(
      summarizeOpeningHours({
        mon: day,
        tue: day,
        wed: day,
        thu: day,
        fri: day,
        sat: [["06:00", "13:00"]],
        sun: [],
      }),
    ).toBe("lun.–ven. 06:00–18:00 · sam. 06:00–13:00");
    expect(summarizeOpeningHours({ mon: [], sun: [] })).toBe("Fermé");
  });

  it("zOpeningHours trie les plages ; zLiters refuse zéro", () => {
    expect(
      zOpeningHours.parse({
        mon: [
          ["14:00", "18:00"],
          ["06:00", "12:00"],
        ],
      }),
    ).toEqual({
      mon: [
        ["06:00", "12:00"],
        ["14:00", "18:00"],
      ],
    });
    expect(zLiters().safeParse(0).success).toBe(false);
    expect(zLiters().safeParse(null).success).toBe(false);
    expect(zLiters({ min: 0 }).safeParse(0).success).toBe(true);
  });
});
