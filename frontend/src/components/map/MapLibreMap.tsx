/** Rendu MapLibre GL (chargé à la demande). Sans `VITE_TILES_URL` : fond uni, marqueurs et tracés seuls. */
import maplibregl, { type GeoJSONSource, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Maximize2, Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import { fr } from "@/i18n/fr";
import { DEFAULT_MAP_CENTER, TILES_ATTRIBUTION, TILES_URL } from "@/lib/config";

import { isValidPosition, placeTooltip } from "./geometry";
import type { MapRendererProps } from "./types";

const ROUTES_SOURCE = "tn-routes";
const ROUTES_HIT_LAYER = "tn-routes-hit";

function buildStyle(): StyleSpecification {
  const style: StyleSpecification = {
    version: 8,
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": "#eef0ec" } }],
  };
  if (TILES_URL) {
    style.sources.basemap = {
      type: "raster",
      tiles: [TILES_URL],
      tileSize: 256,
      attribution: TILES_ATTRIBUTION,
    };
    style.layers.push({ id: "basemap", type: "raster", source: "basemap" });
  }
  return style;
}

function popupContent(kind: string, title: string, detail: string[]): HTMLElement {
  // Construction par le DOM (jamais d'innerHTML) : les libellés viennent de la base.
  const root = document.createElement("div");
  const add = (text: string, style: string) => {
    const line = document.createElement("div");
    line.textContent = text;
    line.style.cssText = style;
    root.appendChild(line);
  };
  add(kind, "font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#5b6770");
  add(title, "font-weight:600");
  detail.forEach((line) => add(line, "color:#5b6770"));
  return root;
}

export default function MapLibreMap({
  points,
  routes,
  selectedId,
  onSelect,
  onMapClick,
  onRouteClick,
  onRouteHover,
  fitSignature,
  fitBounds,
  onTilesError,
}: MapRendererProps & { onTilesError: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  // Bulle de détail : élément superposé à la carte, recalé dans le cadre (la bulle native de MapLibre est
  // rognée quand le marqueur est près d'un bord ou hors champ après un recadrage sur une tournée).
  const tooltipRef = useRef<HTMLDivElement>(null);
  const showTooltip = useCallback((position: { lat: number; lon: number }, content: HTMLElement) => {
    const map = mapRef.current;
    const tooltip = tooltipRef.current;
    if (!map || !tooltip) return;
    tooltip.replaceChildren(content);
    tooltip.hidden = false;
    const anchor = map.project([position.lon, position.lat]);
    const frame = map.getContainer();
    const { left, top } = placeTooltip(
      anchor,
      { width: tooltip.offsetWidth, height: tooltip.offsetHeight },
      { width: frame.clientWidth, height: frame.clientHeight },
    );
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }, []);
  const hideTooltip = useCallback(() => {
    if (tooltipRef.current) tooltipRef.current.hidden = true;
  }, []);
  const loadedRef = useRef(false);
  const callbacks = useRef({ onSelect, onMapClick, onRouteClick, onRouteHover, onTilesError });
  callbacks.current = { onSelect, onMapClick, onRouteClick, onRouteHover, onTilesError };
  const dataRef = useRef({ points, routes, fitBounds });
  dataRef.current = { points, routes, fitBounds };
  const hoveredRoute = useRef<string | null>(null);

  const fit = useCallback((animate: boolean) => {
    const map = mapRef.current;
    if (!map) return;
    const b = dataRef.current.fitBounds;
    map.fitBounds(
      [
        [b.minLon, b.minLat],
        [b.maxLon, b.maxLat],
      ],
      { padding: 40, maxZoom: 15, animate, duration: 350 },
    );
  }, []);

  const drawRoutes = useCallback(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const data: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: dataRef.current.routes
        .filter((route) => route.path.filter(isValidPosition).length >= 2)
        .map((route) => ({
          type: "Feature",
          properties: { id: route.id, color: route.color, opacity: route.dimmed ? 0.35 : 1 },
          geometry: {
            type: "LineString",
            coordinates: route.path.filter(isValidPosition).map((p) => [p.lon, p.lat]),
          },
        })),
    };
    const source = map.getSource(ROUTES_SOURCE) as GeoJSONSource | undefined;
    if (source) {
      source.setData(data);
      return;
    }
    map.addSource(ROUTES_SOURCE, { type: "geojson", data });
    const layout = { "line-join": "round", "line-cap": "round" } as const;
    map.addLayer({
      id: "tn-routes-casing",
      type: "line",
      source: ROUTES_SOURCE,
      layout,
      paint: { "line-color": "#ffffff", "line-width": 6, "line-opacity": ["get", "opacity"] },
    });
    map.addLayer({
      id: "tn-routes-line",
      type: "line",
      source: ROUTES_SOURCE,
      layout,
      paint: { "line-color": ["get", "color"], "line-width": 3, "line-opacity": ["get", "opacity"] },
    });
    // Bande invisible plus large que le trait : zone de clic et de survol du tracé.
    map.addLayer({
      id: ROUTES_HIT_LAYER,
      type: "line",
      source: ROUTES_SOURCE,
      layout,
      paint: { "line-color": "#000000", "line-width": 16, "line-opacity": 0 },
    });
    const routeAt = (event: maplibregl.MapLayerMouseEvent) =>
      (event.features?.[0]?.properties?.id as string | undefined) ?? null;
    map.on("click", ROUTES_HIT_LAYER, (event) => {
      const id = routeAt(event);
      if (id) callbacks.current.onRouteClick?.(id);
    });
    map.on("mousemove", ROUTES_HIT_LAYER, (event) => {
      const id = routeAt(event);
      if (id === hoveredRoute.current) return;
      hoveredRoute.current = id;
      if (callbacks.current.onRouteClick) map.getCanvas().style.cursor = "pointer";
      callbacks.current.onRouteHover?.(id);
    });
    map.on("mouseleave", ROUTES_HIT_LAYER, () => {
      hoveredRoute.current = null;
      map.getCanvas().style.cursor = callbacks.current.onMapClick ? "crosshair" : "";
      callbacks.current.onRouteHover?.(null);
    });
  }, []);

  // Création de la carte (une fois).
  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildStyle(),
      center: [DEFAULT_MAP_CENTER.lon, DEFAULT_MAP_CENTER.lat],
      zoom: 10,
      attributionControl: TILES_URL ? { compact: true } : false,
      dragRotate: false,
      pitchWithRotate: false,
    });
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.on("movestart", hideTooltip);

    map.on("load", () => {
      loadedRef.current = true;
      drawRoutes();
      fit(false);
    });
    map.on("click", (event) => {
      const onRoute =
        !!callbacks.current.onRouteClick &&
        !!map.getLayer(ROUTES_HIT_LAYER) &&
        map.queryRenderedFeatures(event.point, { layers: [ROUTES_HIT_LAYER] }).length > 0;
      if (!onRoute) callbacks.current.onMapClick?.({ lat: event.lngLat.lat, lon: event.lngLat.lng });
    });
    map.on("error", (event) => {
      // Tuiles injoignables (hôte refusé, hors ligne) : la carte reste lisible, on le signale une fois.
      if ((event as { sourceId?: string }).sourceId === "basemap") callbacks.current.onTilesError();
    });

    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => map.resize()) : null;
    observer?.observe(containerRef.current);

    return () => {
      observer?.disconnect();
      loadedRef.current = false;
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, [drawRoutes, fit, hideTooltip]);

  // Marqueurs et tracés.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current = [];
    hideTooltip();

    const addMarker = (
      id: string,
      kind: "depot" | "station" | "stop",
      position: { lat: number; lon: number },
      options: {
        text?: string;
        color?: string;
        opacity?: number;
        variant?: string;
        kindLabel: string;
        title: string;
        detail: string[];
      },
    ) => {
      const element = document.createElement("div");
      element.className = `tn-marker tn-marker--${options.variant ?? kind}${selectedId === id ? " tn-marker--selected" : ""}`;
      if (options.variant) element.dataset.variant = options.variant;
      element.dataset.markerId = id;
      element.setAttribute("aria-label", `${options.kindLabel} ${options.title}`);
      if (options.text) element.textContent = options.text;
      if (options.color) element.style.background = options.color;
      if (options.opacity !== undefined) element.style.opacity = String(options.opacity);
      if (callbacks.current.onSelect) element.style.cursor = "pointer";
      element.addEventListener("mouseenter", () => {
        showTooltip(position, popupContent(options.kindLabel, options.title, options.detail));
      });
      element.addEventListener("mouseleave", hideTooltip);
      element.addEventListener("click", (event) => {
        if (!callbacks.current.onSelect) return;
        event.stopPropagation();
        callbacks.current.onSelect(id, kind);
      });
      markersRef.current.push(
        // L'opacité passe par l'option du marqueur : MapLibre gère lui-même `style.opacity` de l'élément.
        new maplibregl.Marker({
          element,
          opacity: options.opacity === undefined ? undefined : String(options.opacity),
        })
          .setLngLat([position.lon, position.lat])
          .addTo(map),
      );
    };

    points.filter(isValidPosition).forEach((point) =>
      addMarker(point.id, point.kind, point, {
        kindLabel:
          point.variant === "unserved"
            ? fr.map.unserved
            : point.kind === "depot"
              ? fr.map.depot
              : fr.map.station,
        title: point.label,
        detail: point.detail ?? [],
        variant: point.variant,
        opacity: point.inactive ? 0.45 : undefined,
      }),
    );
    routes.forEach((route) =>
      (route.stops ?? []).filter(isValidPosition).forEach((stop) =>
        addMarker(stop.id, "stop", stop, {
          text: String(stop.seq),
          color: route.color,
          opacity: route.dimmed ? 0.45 : undefined,
          kindLabel: fr.map.stop(stop.seq),
          title: stop.label,
          detail: stop.detail ?? [],
        }),
      ),
    );
    drawRoutes();
  }, [points, routes, selectedId, drawRoutes, showTooltip, hideTooltip]);

  // Cadrage automatique quand l'emprise à montrer change (contenu, tournée ciblée ou emprise imposée).
  useEffect(() => {
    if (loadedRef.current) fit(true);
  }, [fitSignature, fit]);

  useEffect(() => {
    const canvas = mapRef.current?.getCanvas();
    if (canvas) canvas.style.cursor = onMapClick ? "crosshair" : "";
  }, [onMapClick]);

  const controls: [string, typeof Plus, () => void][] = [
    [fr.map.zoomIn, Plus, () => mapRef.current?.zoomIn()],
    [fr.map.zoomOut, Minus, () => mapRef.current?.zoomOut()],
    [fr.map.fit, Maximize2, () => fit(true)],
  ];

  return (
    <>
      {/* MapLibre impose `position: relative` à son conteneur : le dimensionnement est porté par le parent. */}
      <div className="absolute inset-0">
        <div ref={containerRef} className="h-full w-full" data-testid="maplibre-map" />
        <div
          ref={tooltipRef}
          role="tooltip"
          hidden
          data-testid="map-tooltip"
          className="pointer-events-none absolute z-10 w-max max-w-64 rounded-md border bg-card px-2.5 py-1.5 text-xs shadow-pop"
        />
      </div>
      <div className="absolute right-2 top-2 z-10 flex flex-col overflow-hidden rounded-md border bg-card shadow-sm">
        {controls.map(([label, Icon, action]) => (
          <button
            key={label}
            type="button"
            title={label}
            aria-label={label}
            onClick={action}
            className="grid size-7 place-items-center border-b last:border-b-0 hover:bg-muted focus-ring"
          >
            <Icon className="size-3.5" />
          </button>
        ))}
      </div>
    </>
  );
}
