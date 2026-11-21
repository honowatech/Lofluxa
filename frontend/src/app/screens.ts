/**
 * Registre des écrans (spec §10) : chemin, icône, groupe de navigation, composant chargé à la demande.
 * Ajouter un écran = une entrée ici + un dossier `src/features/<écran>/` exportant sa page par défaut
 * + ses libellés dans `fr.nav.screens` + ses rôles dans `lib/auth/roles.ts`.
 */
import {
  ArrowLeftRight,
  CalendarClock,
  ClipboardList,
  Database,
  Fuel,
  Gauge,
  PackageCheck,
  Route,
  Settings,
  Siren,
  type LucideIcon,
} from "lucide-react";
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

import type { ScreenId } from "@/lib/auth/roles";

export type NavGroup = "preparation" | "execution" | "analysis" | "setup";

export interface ScreenDef {
  id: ScreenId;
  /** Numéro de l'écran dans la spec §10. */
  number: number;
  path: string;
  icon: LucideIcon;
  group: NavGroup;
  component: LazyExoticComponent<ComponentType>;
}

export const LOGIN_PATH = "/connexion";
export const HOME_PATH = "/journee";

export const SCREENS: ScreenDef[] = [
  {
    id: "day",
    number: 2,
    path: "/journee",
    icon: Gauge,
    group: "preparation",
    component: lazy(() => import("@/features/day")),
  },
  {
    id: "orders",
    number: 3,
    path: "/commandes",
    icon: ClipboardList,
    group: "preparation",
    component: lazy(() => import("@/features/orders")),
  },
  {
    id: "availability",
    number: 4,
    path: "/disponibilite",
    icon: CalendarClock,
    group: "preparation",
    component: lazy(() => import("@/features/availability")),
  },
  {
    id: "plan",
    number: 5,
    path: "/plan",
    icon: Route,
    group: "preparation",
    component: lazy(() => import("@/features/plan")),
  },
  {
    id: "events",
    number: 6,
    path: "/journal",
    icon: Siren,
    group: "execution",
    component: lazy(() => import("@/features/events")),
  },
  {
    id: "loading",
    number: 7,
    path: "/chargement",
    icon: Fuel,
    group: "execution",
    component: lazy(() => import("@/features/loading")),
  },
  {
    id: "deliveries",
    number: 8,
    path: "/suivi",
    icon: PackageCheck,
    group: "execution",
    component: lazy(() => import("@/features/deliveries")),
  },
  {
    id: "comparison",
    number: 9,
    path: "/comparaison",
    icon: ArrowLeftRight,
    group: "analysis",
    component: lazy(() => import("@/features/comparison")),
  },
  {
    id: "referentials",
    number: 10,
    path: "/referentiels",
    icon: Database,
    group: "setup",
    component: lazy(() => import("@/features/referentials")),
  },
  {
    id: "administration",
    number: 11,
    path: "/administration",
    icon: Settings,
    group: "setup",
    component: lazy(() => import("@/features/administration")),
  },
];

export const NAV_GROUPS: NavGroup[] = ["preparation", "execution", "analysis", "setup"];

export const screenById = (id: ScreenId): ScreenDef =>
  SCREENS.find((screen) => screen.id === id) as ScreenDef;
