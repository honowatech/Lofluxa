/**
 * Alerte « version restée en brouillon » de la coquille : après un événement (panne, pénurie…), le serveur
 * peut laisser la nouvelle version du plan en brouillon ; les tournées publiées ne sont alors plus à jour.
 * `GET /dashboard` le signale (`pending_draft` + alerte `code: "pending_draft"`) : on l'affiche dans la cloche,
 * quel que soit l'écran, avec un lien vers le plan à vérifier.
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { fr } from "@/i18n/fr";
import type { AppAlert } from "@/lib/alerts";
import { api } from "@/lib/api/client";
import type { ApiError } from "@/lib/api/errors";
import type { Schema } from "@/lib/types";
import { useDay } from "@/lib/useDay";

type Dashboard = Schema<"DashboardOut">;

/** Intervalle de rafraîchissement : l'alerte peut naître d'une action faite sur un autre poste. */
const REFRESH_MS = 60_000;

export function pendingDraftAlert(dashboard: Dashboard | undefined, day: string): AppAlert[] {
  const draft = dashboard?.pending_draft;
  if (!draft) return [];
  const fromServer = dashboard.alerts.find((alert) => alert.code === "pending_draft");
  return [
    {
      id: `pending-draft-${draft.plan_id}`,
      severity: fromServer?.severity ?? (draft.blocking_count > 0 ? "blocking" : "warning"),
      title: fr.shell.pendingDraft(draft.version),
      description: fromServer?.message ?? draft.message,
      to: `/plan?plan=${draft.plan_id}&day=${day}`,
    },
  ];
}

/** `enabled` : l'utilisateur voit l'écran Plan (sinon le lien ne mènerait nulle part). */
export function usePendingDraftAlert(enabled: boolean): AppAlert[] {
  const { day } = useDay();
  // Même clé de cache que l'écran Journée : une seule requête, et ses invalidations valent pour la cloche.
  const dashboard = useQuery<Dashboard, ApiError>({
    queryKey: ["/dashboard", day],
    queryFn: ({ signal }) => api<Dashboard>("/dashboard", { query: { day }, signal }),
    enabled,
    refetchInterval: REFRESH_MS,
    retry: false,
  });
  return useMemo(
    () => (enabled ? pendingDraftAlert(dashboard.data, day) : []),
    [enabled, dashboard.data, day],
  );
}
