import { DEFAULT_MAP_CENTER } from "@/lib/config";

import type { LatLon, MapPoint, MapRoute } from "./types";

export interface Bounds {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

export const isValidPosition = (p: Partial<LatLon> | null | undefined): p is LatLon =>
  !!p &&
  typeof p.lat === "number" &&
  typeof p.lon === "number" &&
  Number.isFinite(p.lat) &&
  Number.isFinite(p.lon) &&
  Math.abs(p.lat) <= 90 &&
  Math.abs(p.lon) <= 180;

export function allPositions(points: MapPoint[], routes: MapRoute[]): LatLon[] {
  return [...points, ...routes.flatMap((route) => [...route.path, ...(route.stops ?? [])])].filter(
    isValidPosition,
  );
}

/** Emprise de tous les éléments, élargie pour qu'un point isolé ne donne pas une emprise nulle. */
export function computeBounds(positions: LatLon[], minSpanDeg = 0.02): Bounds {
  const source = positions.length > 0 ? positions : [DEFAULT_MAP_CENTER];
  const spanFloor = positions.length > 0 ? minSpanDeg : 0.3;
  let minLat = Math.min(...source.map((p) => p.lat));
  let maxLat = Math.max(...source.map((p) => p.lat));
  let minLon = Math.min(...source.map((p) => p.lon));
  let maxLon = Math.max(...source.map((p) => p.lon));
  if (maxLat - minLat < spanFloor) {
    const mid = (minLat + maxLat) / 2;
    minLat = mid - spanFloor / 2;
    maxLat = mid + spanFloor / 2;
  }
  if (maxLon - minLon < spanFloor) {
    const mid = (minLon + maxLon) / 2;
    minLon = mid - spanFloor / 2;
    maxLon = mid + spanFloor / 2;
  }
  return { minLat, maxLat, minLon, maxLon };
}

export interface Projection {
  project: (position: LatLon) => { x: number; y: number };
  unproject: (x: number, y: number) => LatLon;
}

/** Projection plane locale (équirectangulaire) cadrée dans `width × height` : suffisante à l'échelle d'une région. */
export function fitProjection(bounds: Bounds, width: number, height: number, padding = 28): Projection {
  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180);
  const spanX = (bounds.maxLon - bounds.minLon) * kx;
  const spanY = bounds.maxLat - bounds.minLat;
  const scale = Math.min((width - 2 * padding) / spanX, (height - 2 * padding) / spanY);
  const offsetX = (width - spanX * scale) / 2;
  const offsetY = (height - spanY * scale) / 2;
  return {
    project: ({ lat, lon }) => ({
      x: offsetX + (lon - bounds.minLon) * kx * scale,
      y: offsetY + (bounds.maxLat - lat) * scale,
    }),
    unproject: (x, y) => ({
      lat: bounds.maxLat - (y - offsetY) / scale,
      lon: bounds.minLon + (x - offsetX) / (kx * scale),
    }),
  };
}

/** Signature du contenu : le cadrage n'est recalculé que si les positions changent. */
export function fitSignatureOf(points: MapPoint[], routes: MapRoute[]): string {
  return allPositions(points, routes)
    .map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`)
    .join("|");
}

export function webglAvailable(): boolean {
  // jsdom et certains postes sans accélération : pas de WebGL, on bascule sur la vue schématique.
  if (typeof window === "undefined" || typeof WebGLRenderingContext === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}
