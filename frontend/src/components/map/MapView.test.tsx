import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  boundsOf,
  computeBounds,
  fitProjection,
  fitSignatureOf,
  isValidPosition,
  routeBounds,
} from "./geometry";
import { MapView, routeColor, ROUTE_COLORS } from "./MapView";
import type { MapPoint, MapRoute } from "./types";

const POINTS: MapPoint[] = [
  { id: "d1", kind: "depot", lat: 4.0551, lon: 9.7083, label: "SCDP Douala", detail: ["SCDP-DLA"] },
  { id: "s1", kind: "station", lat: 4.0502, lon: 9.6958, label: "OLA Akwa", detail: ["DLA-001", "Douala"] },
  { id: "s2", kind: "station", lat: 4.0892, lon: 9.7376, label: "OLA Bonamoussadi", inactive: true },
];
const ROUTES: MapRoute[] = [
  {
    id: "t1",
    color: routeColor(0),
    path: [POINTS[0], POINTS[1], POINTS[2], POINTS[0]],
    stops: [
      { id: "st1", seq: 1, lat: 4.0502, lon: 9.6958, label: "OLA Akwa", detail: ["07:30 — 12 000 L"] },
      { id: "st2", seq: 2, lat: 4.0892, lon: 9.7376, label: "OLA Bonamoussadi" },
    ],
  },
  { id: "t2", color: routeColor(1), path: [POINTS[0], POINTS[2]], dimmed: true },
];

// jsdom n'a pas de WebGL : MapView bascule de lui-même sur la vue schématique (le repli lisible).
describe("MapView — repli sans WebGL ni tuiles", () => {
  it("marqueurs dépôts / stations, tracés colorés, arrêts numérotés", () => {
    render(<MapView points={POINTS} routes={ROUTES} selectedId="s1" legend />);
    const map = screen.getByTestId("schematic-map");
    expect(screen.getByText("Vue schématique")).toBeInTheDocument();
    expect(map.querySelectorAll('[data-kind="depot"]')).toHaveLength(1);
    expect(map.querySelectorAll('[data-kind="station"]')).toHaveLength(2);
    expect(map.querySelector('[data-point="s1"]')).toHaveAttribute("data-selected", "true");
    expect(map.querySelector('[data-point="s2"]')).toHaveAttribute("opacity", "0.45");

    const routes = map.querySelectorAll("[data-route]");
    expect(routes).toHaveLength(2);
    expect(routes[0].querySelectorAll("path")[1]).toHaveAttribute("stroke", ROUTE_COLORS[0]);
    expect(routes[1]).toHaveAttribute("opacity", "0.35");
    expect([...map.querySelectorAll("[data-stop] text")].map((node) => node.textContent)).toEqual(["1", "2"]);
    expect(screen.getByText("Dépôt")).toBeInTheDocument();
    expect(screen.queryByText("Aucun point à afficher")).not.toBeInTheDocument();
  });

  it("survol = détail ; clic = sélection", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<MapView points={POINTS} routes={ROUTES} onSelect={onSelect} />);
    await user.hover(screen.getByRole("button", { name: "Station OLA Akwa" }));
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("OLA Akwa");
    expect(tooltip).toHaveTextContent("DLA-001");
    await user.unhover(screen.getByRole("button", { name: "Station OLA Akwa" }));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await user.hover(screen.getByRole("button", { name: "Arrêt 1 OLA Akwa" }));
    expect(within(screen.getByRole("tooltip")).getByText("07:30 — 12 000 L")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Dépôt SCDP Douala" }));
    expect(onSelect).toHaveBeenLastCalledWith("d1", "depot");
    await user.click(screen.getByRole("button", { name: "Arrêt 2 OLA Bonamoussadi" }));
    expect(onSelect).toHaveBeenLastCalledWith("st2", "stop");
  });

  it("sans point : message lisible ; clic sur le fond = coordonnées (autour de Douala)", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<MapView />);
    expect(screen.getByText("Aucun point à afficher")).toBeInTheDocument();

    const onMapClick = vi.fn();
    rerender(<MapView onMapClick={onMapClick} />);
    expect(screen.queryByText("Aucun point à afficher")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("schematic-map"));
    const position = onMapClick.mock.calls[0][0];
    expect(isValidPosition(position)).toBe(true);
    expect(Math.abs(position.lat - 4.05)).toBeLessThan(1);
    expect(Math.abs(position.lon - 9.77)).toBeLessThan(1);
  });

  it("ignore les positions invalides sans casser le cadrage", () => {
    render(
      <MapView
        points={[...POINTS, { id: "x", kind: "station", lat: Number.NaN, lon: 9, label: "Sans position" }]}
      />,
    );
    expect(screen.getByTestId("schematic-map").querySelectorAll("[data-point]")).toHaveLength(3);
  });
});

describe("MapView — ajouts", () => {
  const xOf = (id: string) =>
    Number(
      /translate\(([\d.]+)/.exec(
        document.querySelector(`[data-point="${id}"]`)?.getAttribute("transform") ?? "",
      )?.[1],
    );

  it("emprise imposée : deux cartes au contenu différent ont le même cadrage", () => {
    const bounds = boundsOf(POINTS, ROUTES);
    const { unmount } = render(<MapView points={POINTS} routes={ROUTES} bounds={bounds} />);
    const full = xOf("s1");
    unmount();
    // Sans emprise imposée, une carte réduite à deux points les écarte au maximum ; avec, s1 ne bouge pas.
    render(<MapView points={POINTS.slice(0, 2)} />);
    const free = xOf("s1");
    cleanup();
    render(<MapView points={POINTS.slice(0, 2)} bounds={bounds} />);
    expect(xOf("s1")).toBeCloseTo(full, 1);
    expect(free).not.toBeCloseTo(full, 1);
  });

  it("recadrage sur une tournée, puis retour à l'ensemble", () => {
    const far: MapPoint = { id: "far", kind: "station", lat: 4.95, lon: 9.94, label: "OLA Nkongsamba" };
    const { rerender } = render(<MapView points={[...POINTS, far]} routes={ROUTES} />);
    const all = xOf("s1");
    rerender(<MapView points={[...POINTS, far]} routes={ROUTES} focusRouteId="t1" />);
    const focused = xOf("s1");
    expect(focused).not.toBeCloseTo(all, 1);
    expect(routeBounds(ROUTES[0])?.maxLat).toBeLessThan(4.2);
    rerender(<MapView points={[...POINTS, far]} routes={ROUTES} focusRouteId={null} />);
    expect(xOf("s1")).toBeCloseTo(all, 1);
    // Tournée inconnue : cadrage sur l'ensemble.
    rerender(<MapView points={[...POINTS, far]} routes={ROUTES} focusRouteId="inconnue" />);
    expect(xOf("s1")).toBeCloseTo(all, 1);
  });

  it("clic et survol sur le tracé d'une tournée ; sans ces props, le tracé n'est pas interactif", async () => {
    const user = userEvent.setup();
    const onRouteClick = vi.fn();
    const onRouteHover = vi.fn();
    const labelled = ROUTES.map((route, index) => ({ ...route, label: `Tournée ${index + 1}` }));
    const { rerender } = render(<MapView points={POINTS} routes={labelled} />);
    expect(document.querySelector("[data-route-hit]")).toBeNull();

    rerender(
      <MapView points={POINTS} routes={labelled} onRouteClick={onRouteClick} onRouteHover={onRouteHover} />,
    );
    const line = screen.getByRole("button", { name: "Tournée 2" });
    await user.hover(line);
    expect(onRouteHover).toHaveBeenLastCalledWith("t2");
    await user.unhover(line);
    expect(onRouteHover).toHaveBeenLastCalledWith(null);
    await user.click(line);
    expect(onRouteClick).toHaveBeenCalledWith("t2");
    line.focus();
    await user.keyboard("{Enter}");
    expect(onRouteClick).toHaveBeenCalledTimes(2);
  });

  it("marqueur « non servie » distinct d'une station inactive ; arrêts d'une tournée en retrait atténués", async () => {
    const user = userEvent.setup();
    const unserved: MapPoint = {
      id: "u1",
      kind: "station",
      variant: "unserved",
      lat: 4.06,
      lon: 9.72,
      label: "OLA Deido",
      detail: ["Stock dépôt insuffisant"],
    };
    const dimmedStops: MapRoute[] = [{ ...ROUTES[0], dimmed: true }];
    render(<MapView points={[...POINTS, unserved]} routes={dimmedStops} />);
    const marker = document.querySelector('[data-point="u1"]') as SVGGElement;
    expect(marker).toHaveAttribute("data-variant", "unserved");
    expect(marker.querySelector("rect")).toHaveAttribute("stroke-dasharray");
    expect(marker).toHaveAttribute("opacity", "1");
    await user.hover(marker);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Commande non servie");
    expect(document.querySelector('[data-stop="st1"]')).toHaveAttribute("opacity", "0.45");
  });

  it("palette : 30 couleurs distinctes, les 10 premières inchangées (reprises par le PDF de comparaison)", () => {
    expect(ROUTE_COLORS.slice(0, 10)).toEqual([
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
    ]);
    expect(new Set(ROUTE_COLORS).size).toBe(30);
    expect(new Set(Array.from({ length: 30 }, (_, index) => routeColor(index))).size).toBe(30);
    expect(routeColor(30)).toBe(routeColor(0));
  });
});

describe("géométrie", () => {
  it("cadrage automatique : tous les points dans le cadre, projection réversible", () => {
    const bounds = computeBounds(POINTS);
    const projection = fitProjection(bounds, 800, 480);
    for (const point of POINTS) {
      const { x, y } = projection.project(point);
      expect(x).toBeGreaterThanOrEqual(28);
      expect(x).toBeLessThanOrEqual(772);
      expect(y).toBeGreaterThanOrEqual(28);
      expect(y).toBeLessThanOrEqual(452);
      const back = projection.unproject(x, y);
      expect(back.lat).toBeCloseTo(point.lat, 6);
      expect(back.lon).toBeCloseTo(point.lon, 6);
    }
    // Le nord est en haut, l'est à droite.
    expect(projection.project(POINTS[2]).y).toBeLessThan(projection.project(POINTS[1]).y);
    expect(projection.project(POINTS[2]).x).toBeGreaterThan(projection.project(POINTS[1]).x);
  });

  it("un point isolé garde une emprise non nulle ; la signature suit les positions", () => {
    const bounds = computeBounds([POINTS[0]]);
    expect(bounds.maxLat - bounds.minLat).toBeGreaterThan(0.01);
    expect(fitSignatureOf(POINTS, [])).not.toBe(fitSignatureOf(POINTS.slice(1), []));
    expect(fitSignatureOf([], [])).toBe("");
  });
});
