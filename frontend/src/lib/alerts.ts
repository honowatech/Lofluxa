/**
 * Zone d'alertes de la coquille (cloche de l'en-tête).
 * Chaque écran publie ses alertes sous une « source » ; republier une source remplace ses alertes.
 *
 *   usePublishAlerts("drivers-expiry", alerts);   // dans un composant : retire les alertes au démontage si `sticky` est faux
 */
import { useEffect } from "react";
import { create } from "zustand";

import type { Severity } from "@/lib/types";

export interface AppAlert {
  id: string;
  severity: Severity | "info";
  title: string;
  description?: string;
  /** Lien interne (chemin du routeur) vers l'endroit où traiter l'alerte. */
  to?: string;
}

interface AlertsState {
  bySource: Record<string, AppAlert[]>;
  publish: (source: string, alerts: AppAlert[]) => void;
  clear: (source: string) => void;
}

export const useAlertsStore = create<AlertsState>((set) => ({
  bySource: {},
  publish: (source, alerts) => set((state) => ({ bySource: { ...state.bySource, [source]: alerts } })),
  clear: (source) =>
    set((state) => {
      const { [source]: _removed, ...rest } = state.bySource;
      return { bySource: rest };
    }),
}));

const ORDER: Record<AppAlert["severity"], number> = { blocking: 0, warning: 1, info: 2 };

/** Toutes les alertes, bloquantes d'abord (à gravité égale, l'ordre de publication des sources est conservé). */
export function selectAlerts(state: AlertsState): AppAlert[] {
  return Object.values(state.bySource)
    .flat()
    .sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

export function usePublishAlerts(
  source: string,
  alerts: AppAlert[],
  options: { sticky?: boolean } = {},
): void {
  const publish = useAlertsStore((state) => state.publish);
  const clear = useAlertsStore((state) => state.clear);
  const signature = JSON.stringify(alerts);
  useEffect(() => {
    publish(source, JSON.parse(signature) as AppAlert[]);
  }, [publish, source, signature]);
  useEffect(() => {
    if (options.sticky) return;
    return () => clear(source);
  }, [clear, source, options.sticky]);
}
