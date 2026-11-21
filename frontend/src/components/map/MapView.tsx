/**
 * Carte partagée : marqueurs de dépôts et de stations, tracés de tournées colorés, arrêts numérotés,
 * détail au survol, cadrage automatique sur le contenu.
 *
 *   <MapView
 *     points={stations.map((s) => ({ id: s.id, kind: "station", lat: s.lat, lon: s.lon, label: s.name, detail: [s.code] }))}
 *     routes={trips.map((t, i) => ({ id: t.id, color: routeColor(i), path: [...], stops: [...] }))}
 *     selectedId={selectedId} onSelect={(id) => setSelectedId(id)}
 *     className="h-80"
 *   />
 *
 * Fond de carte : tuiles raster de `VITE_TILES_URL`. Sans URL, ou si les tuiles ne répondent pas, la carte
 * reste utilisable (fond uni, positions à l'échelle) et le signale. Sans WebGL : vue schématique en SVG.
 */
import { MapPinOff } from "lucide-react";
import { lazy, Suspense, useMemo, useState } from "react";

import { fr } from "@/i18n/fr";
import { TILES_URL } from "@/lib/config";
import { cn } from "@/lib/utils";

import { Spinner } from "../states";
import { fitSignatureOf, webglAvailable } from "./geometry";
import { SchematicMap } from "./SchematicMap";
import type { LatLon, MapPoint, MapRoute } from "./types";

const MapLibreMap = lazy(() => import("./MapLibreMap"));

export interface MapViewProps {
  points?: MapPoint[];
  routes?: MapRoute[];
  /** Marqueur mis en évidence (point ou arrêt). */
  selectedId?: string | null;
  onSelect?: (id: string, kind: "depot" | "station" | "stop") => void;
  /** Clic sur le fond (saisie de coordonnées). */
  onMapClick?: (position: LatLon) => void;
  /** Force la vue schématique (aperçus, impression). */
  renderer?: "auto" | "schematic";
  /** Légende dépôt / station sous la carte. */
  legend?: boolean;
  /** Nom accessible. */
  label?: string;
  /** La hauteur vient de la classe (ex. `h-80`) ou du parent (`h-full`). */
  className?: string;
}

/** Palette des tournées : teintes distinctes, lisibles sur fond clair, hors rouge / orange (réservés aux violations). */
export const ROUTE_COLORS = [
  "#1d6fb8",
  "#0f8a7a",
  "#7a4fc4",
  "#b0347e",
  "#4a7a1c",
  "#2c4a9e",
  "#8a6a12",
  "#0e7490",
  "#6b4a2e",
  "#525f6b",
];
export const routeColor = (index: number): string => ROUTE_COLORS[index % ROUTE_COLORS.length];

export function MapView({
  points = [],
  routes = [],
  selectedId,
  onSelect,
  onMapClick,
  renderer = "auto",
  legend,
  label = fr.map.label,
  className,
}: MapViewProps) {
  const [tilesFailed, setTilesFailed] = useState(false);
  const useGl = useMemo(() => renderer === "auto" && webglAvailable(), [renderer]);
  const fitSignature = useMemo(() => fitSignatureOf(points, routes), [points, routes]);
  const isEmpty = fitSignature === "";
  const rendererProps = { points, routes, selectedId, onSelect, onMapClick, fitSignature };

  const notice = !useGl
    ? fr.map.schematic
    : !TILES_URL
      ? fr.map.noTiles
      : tilesFailed
        ? fr.map.tilesError
        : null;

  return (
    <figure
      className={cn("flex min-h-40 flex-col overflow-hidden rounded-md border bg-card", className)}
      aria-label={label}
    >
      <div className="relative min-h-0 flex-1" data-renderer={useGl ? "maplibre" : "schematic"}>
        {useGl ? (
          <Suspense
            fallback={
              <div className="absolute inset-0 grid place-items-center">
                <Spinner className="size-5" />
              </div>
            }
          >
            <MapLibreMap {...rendererProps} onTilesError={() => setTilesFailed(true)} />
          </Suspense>
        ) : (
          <SchematicMap {...rendererProps} />
        )}

        {notice && (
          <p className="pointer-events-none absolute left-2 top-2 z-10 rounded-sm border bg-card/90 px-1.5 py-0.5 text-2xs text-muted-foreground">
            {notice}
          </p>
        )}
        {isEmpty && !onMapClick && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center">
            <p className="flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
              <MapPinOff className="size-3.5" aria-hidden />
              {fr.map.empty}
            </p>
          </div>
        )}
      </div>
      {legend && (
        <figcaption className="flex items-center gap-4 border-t px-2.5 py-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-[2px] bg-sidebar" />
            {fr.map.legendDepot}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-primary" />
            {fr.map.legendStation}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-primary opacity-40" />
            {fr.map.legendInactive}
          </span>
        </figcaption>
      )}
    </figure>
  );
}
