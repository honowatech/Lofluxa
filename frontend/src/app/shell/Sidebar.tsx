import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { NavLink, useSearchParams } from "react-router-dom";

import { Tip } from "@/components/ui/tooltip";
import { fr } from "@/i18n/fr";
import { canSee } from "@/lib/auth/roles";
import { useRole } from "@/lib/auth/session";
import { DAY_PARAM, withDay } from "@/lib/useDay";
import { cn } from "@/lib/utils";

import { NAV_GROUPS, SCREENS } from "../screens";
import { useNavStore } from "./navStore";

export function Sidebar() {
  const role = useRole();
  const { collapsed, toggle } = useNavStore();
  const [params] = useSearchParams();
  const day = params.get(DAY_PARAM);
  const visible = SCREENS.filter((screen) => canSee(role, screen.id));

  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col bg-sidebar text-sidebar-foreground transition-[width] duration-150",
        collapsed ? "w-12" : "w-52",
      )}
    >
      <div
        className={cn(
          "flex h-11 items-center gap-2 border-b border-white/10",
          collapsed ? "justify-center" : "px-3",
        )}
      >
        <svg viewBox="0 0 32 32" className="size-6 shrink-0" aria-hidden>
          <path
            d="M5 22c5-11 9 4 13-6s5-6 9-6"
            fill="none"
            stroke="hsl(var(--signal))"
            strokeWidth="3"
            strokeLinecap="round"
          />
          <circle cx="5" cy="22" r="3" fill="#fff" />
          <circle cx="27" cy="10" r="3" fill="hsl(var(--signal))" />
        </svg>
        {!collapsed && (
          <div className="min-w-0 leading-tight">
            <p className="text-base font-semibold tracking-tight text-white">{fr.app.name}</p>
          </div>
        )}
      </div>

      <nav aria-label={fr.nav.title} className="flex-1 overflow-y-auto py-2">
        {NAV_GROUPS.map((group) => {
          const screens = visible.filter((screen) => screen.group === group);
          if (screens.length === 0) return null;
          return (
            <div key={group} className="mb-2">
              {collapsed ? (
                <div className="mx-3 mb-1 border-t border-white/10" />
              ) : (
                <p className="px-3 pb-1 pt-1.5 text-2xs font-medium uppercase tracking-[0.08em] text-sidebar-muted">
                  {fr.nav.groups[group]}
                </p>
              )}
              <ul>
                {screens.map((screen) => {
                  const label = fr.nav.screens[screen.id];
                  const link = (
                    <NavLink
                      to={day ? withDay(screen.path, day) : screen.path}
                      className={({ isActive }) =>
                        cn(
                          "relative flex h-8 items-center gap-2.5 text-sm outline-none transition-colors hover:bg-white/5 hover:text-white focus-visible:bg-white/10 focus-visible:text-white",
                          collapsed ? "justify-center" : "px-3",
                          isActive &&
                            "bg-sidebar-active font-medium text-white before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-r before:bg-signal",
                        )
                      }
                    >
                      <screen.icon className="size-4 shrink-0" aria-hidden />
                      {collapsed ? (
                        <span className="sr-only">{label}</span>
                      ) : (
                        <span className="truncate">{label}</span>
                      )}
                    </NavLink>
                  );
                  return (
                    <li key={screen.id}>
                      {collapsed ? (
                        <Tip label={label} side="right">
                          {link}
                        </Tip>
                      ) : (
                        link
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <div
        className={cn(
          "flex items-center border-t border-white/10 py-1.5",
          collapsed ? "justify-center" : "justify-between px-3",
        )}
      >
        {!collapsed && <p className="truncate text-2xs text-sidebar-muted">{fr.app.client}</p>}
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? fr.nav.expand : fr.nav.collapse}
          title={collapsed ? fr.nav.expand : fr.nav.collapse}
          className="grid size-7 place-items-center rounded-sm text-sidebar-muted outline-none hover:bg-white/10 hover:text-white focus-visible:bg-white/10 focus-visible:text-white"
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </button>
      </div>
    </aside>
  );
}
