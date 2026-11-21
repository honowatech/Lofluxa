/** Emprise géographique. */
export interface Bounds {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

export interface LatLon {
  lat: number;
  lon: number;
}

/** Marqueur de dépôt ou de station. */
export interface MapPoint extends LatLon {
  id: string;
  kind: "depot" | "station";
  /** Titre du détail au survol (nom). */
  label: string;
  /** Lignes de détail au survol (code, ville, horaires…). */
  detail?: string[];
  /** Affiché en retrait (référentiel désactivé). */
  inactive?: boolean;
  /** `unserved` : commande non servie — losange à bord pointillé, distinct d'une station inactive. */
  variant?: "unserved";
}

/** Arrêt numéroté d'une tournée. */
export interface MapStop extends LatLon {
  id: string;
  seq: number;
  label: string;
  detail?: string[];
}

/** Tracé d'une tournée : une couleur, un chemin, des arrêts numérotés. */
export interface MapRoute {
  id: string;
  color: string;
  label?: string;
  /** Chemin ordonné (dépôt → arrêts → dépôt, ou géométrie routière si disponible). */
  path: LatLon[];
  stops?: MapStop[];
  /** Tracé atténué (tournée non sélectionnée) ; ses arrêts le sont aussi. */
  dimmed?: boolean;
}

export interface MapRendererProps {
  points: MapPoint[];
  routes: MapRoute[];
  selectedId?: string | null;
  onSelect?: (id: string, kind: "depot" | "station" | "stop") => void;
  /** Clic sur le fond de carte (saisie de coordonnées). */
  onMapClick?: (position: LatLon) => void;
  /** Change quand le cadrage doit être recalculé. */
  fitSignature: string;
  /** Emprise à cadrer (imposée, tournée ciblée, ou tout le contenu). */
  fitBounds: Bounds;
  onRouteClick?: (id: string) => void;
  onRouteHover?: (id: string | null) => void;
}
