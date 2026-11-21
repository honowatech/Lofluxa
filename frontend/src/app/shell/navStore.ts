import { create } from "zustand";

const KEY = "tourneo.nav.collapsed";

function initial(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Menu latéral réduit aux icônes (préférence conservée sur le poste). */
export const useNavStore = create<{ collapsed: boolean; toggle: () => void }>((set, get) => ({
  collapsed: initial(),
  toggle: () => {
    const collapsed = !get().collapsed;
    try {
      window.localStorage.setItem(KEY, collapsed ? "1" : "0");
    } catch {
      // préférence non conservée
    }
    set({ collapsed });
  },
}));
