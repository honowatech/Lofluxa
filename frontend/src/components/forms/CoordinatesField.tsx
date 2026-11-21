/**
 * Coordonnées GPS : latitude + longitude (deux champs du formulaire) avec mini-carte.
 * Un clic sur la carte place le point ; coller « 4.0483, 9.7043 » dans un champ remplit les deux.
 *   <CoordinatesField latName="lat" lonName="lon" pointLabel={name} context={autresStations} />
 */
import { useFormContext, useWatch, type FieldValues, type Path, type PathValue } from "react-hook-form";

import { MapView, isValidPosition, type MapPoint } from "@/components/map";
import { fr } from "@/i18n/fr";
import { parseDecimal } from "@/lib/format";

import { NumberField } from "./fields";

const t = fr.fields.coordinates;
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

const NUM = String.raw`(-?\d+(?:[.,]\d+)?)`;
const DOT = String.raw`(-?\d+(?:\.\d+)?)`;
/** `4.0483, 9.7043` (décimales au point) ou `4,0483 ; 9,7043` / `4,0483 9,7043` (décimales à la virgule). */
export function parseCoordinatePair(text: string): { lat: number; lon: number } | null {
  const match =
    new RegExp(`^\\s*${DOT}\\s*,\\s*${DOT}\\s*$`).exec(text) ??
    new RegExp(`^\\s*${NUM}\\s*[;\\s]\\s*${NUM}\\s*$`).exec(text);
  if (!match) return null;
  const position = { lat: parseDecimal(match[1]) ?? Number.NaN, lon: parseDecimal(match[2]) ?? Number.NaN };
  return isValidPosition(position) ? position : null;
}

export function CoordinatesField<T extends FieldValues>({
  latName,
  lonName,
  kind = "station",
  pointLabel,
  context = [],
  disabled,
  required = true,
}: {
  latName: Path<T>;
  lonName: Path<T>;
  kind?: "depot" | "station";
  /** Libellé du point en cours de saisie (survol). */
  pointLabel?: string;
  /** Autres points affichés en retrait pour se repérer. */
  context?: MapPoint[];
  disabled?: boolean;
  required?: boolean;
}) {
  const { control, setValue } = useFormContext<T>();
  const lat = useWatch({ control, name: latName }) as number | null;
  const lon = useWatch({ control, name: lonName }) as number | null;
  const current = { lat: lat as number, lon: lon as number };

  const set = (position: { lat: number; lon: number }) => {
    const options = { shouldDirty: true, shouldValidate: true, shouldTouch: true };
    setValue(latName, round6(position.lat) as PathValue<T, Path<T>>, options);
    setValue(lonName, round6(position.lon) as PathValue<T, Path<T>>, options);
  };

  const onPaste = (event: React.ClipboardEvent) => {
    const pair = parseCoordinatePair(event.clipboardData.getData("text/plain"));
    if (pair) {
      event.preventDefault();
      set(pair);
    }
  };

  const points: MapPoint[] = [
    ...context.map((point) => ({ ...point, inactive: true })),
    ...(isValidPosition(current)
      ? [{ id: "__current", kind, lat: current.lat, lon: current.lon, label: pointLabel || t.label }]
      : []),
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-[11rem_1fr]" role="group" aria-label={t.label}>
      <div className="flex flex-col gap-3" onPaste={onPaste}>
        <NumberField<T>
          name={latName}
          label={t.lat}
          required={required}
          disabled={disabled}
          placeholder="4,0511"
        />
        <NumberField<T>
          name={lonName}
          label={t.lon}
          required={required}
          disabled={disabled}
          placeholder="9,7679"
        />
        <p className="text-xs text-muted-foreground">{disabled ? null : t.paste}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <MapView
          points={points}
          selectedId="__current"
          onMapClick={disabled ? undefined : set}
          label={t.label}
          className="h-48"
        />
        {!disabled && <p className="text-xs text-muted-foreground">{t.mapHint}</p>}
      </div>
    </div>
  );
}
