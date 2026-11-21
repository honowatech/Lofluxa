/**
 * Session de l'utilisateur (Zustand).
 *   status : "loading" (jeton présent, `/me` en cours) | "authenticated" | "anonymous"
 */
import { create } from "zustand";

import { api, onSessionExpired } from "@/lib/api/client";
import type { Me, Role, TokenPair } from "@/lib/types";

import { can, canSee, type Capability, type ScreenId } from "./roles";
import { getTokens, onTokensChange, setTokens } from "./tokens";

type Status = "loading" | "authenticated" | "anonymous";

interface SessionState {
  status: Status;
  user: Me | null;
  /** Vrai quand la session a été fermée par expiration (message sur l'écran de connexion). */
  expired: boolean;
  bootstrap: () => Promise<void>;
  login: (email: string, password: string) => Promise<Me>;
  logout: () => Promise<void>;
}

export const useSession = create<SessionState>((set, get) => ({
  status: getTokens() ? "loading" : "anonymous",
  user: null,
  expired: false,

  /** Au démarrage : si des jetons sont stockés, charge `/me` (le 401 éventuel déclenche le rafraîchissement). */
  async bootstrap() {
    if (!getTokens()) {
      set({ status: "anonymous", user: null });
      return;
    }
    try {
      const user = await api<Me>("/me");
      set({ status: "authenticated", user, expired: false });
    } catch {
      if (get().status === "loading") {
        setTokens(null);
        set({ status: "anonymous", user: null });
      }
    }
  },

  async login(email, password) {
    const pair = await api<TokenPair>("/auth/login", {
      method: "POST",
      body: { email, password },
      auth: false,
    });
    setTokens({ access_token: pair.access_token, refresh_token: pair.refresh_token });
    try {
      const user = await api<Me>("/me");
      set({ status: "authenticated", user, expired: false });
      return user;
    } catch (error) {
      setTokens(null);
      set({ status: "anonymous", user: null });
      throw error;
    }
  },

  async logout() {
    try {
      // Révocation côté serveur des deux jetons ; l'échec n'empêche pas la déconnexion locale.
      const tokens = getTokens();
      if (tokens)
        await api("/auth/logout", { method: "POST", body: { refresh_token: tokens.refresh_token } });
    } catch {
      // jeton déjà expiré ou réseau coupé : on ferme quand même la session locale
    }
    setTokens(null);
    set({ status: "anonymous", user: null, expired: false });
  },
}));

onSessionExpired(() => {
  useSession.setState({ status: "anonymous", user: null, expired: true });
});

// Déconnexion depuis un autre onglet.
onTokensChange((tokens) => {
  if (!tokens && useSession.getState().status === "authenticated") {
    useSession.setState({ status: "anonymous", user: null });
  }
});

export function useCurrentUser(): Me | null {
  return useSession((state) => state.user);
}
export function useRole(): Role | null {
  return useSession((state) => state.user?.role ?? null);
}
/** `const canEdit = useCan("referentials.write")` */
export function useCan(capability: Capability): boolean {
  return can(useRole(), capability);
}
export function useCanSee(screen: ScreenId): boolean {
  return canSee(useRole(), screen);
}
