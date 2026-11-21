/**
 * Notifications (toasts).
 *   notify.success("Station enregistrée");
 *   notify.apiError(error, fr.errors.saveFailed);   // affiche le message du serveur et les codes RM-xx
 */
import { toast } from "sonner";

import { errorMessage, isApiError } from "@/lib/api/errors";

export const notify = {
  success: (title: string, description?: string) => toast.success(title, { description }),
  info: (title: string, description?: string) => toast.message(title, { description }),
  warning: (title: string, description?: string) => toast.warning(title, { description, duration: 7000 }),
  error: (title: string, description?: string) => toast.error(title, { description, duration: 9000 }),

  /** Erreur attrapée (API ou autre). Les expirations de session sont déjà traitées par la redirection. */
  apiError(error: unknown, title: string): void {
    if (isApiError(error) && error.code === "session_expired") return;
    const message = errorMessage(error);
    const rules = isApiError(error) && error.ruleCodes.length ? ` (${error.ruleCodes.join(", ")})` : "";
    toast.error(title, { description: `${message}${rules}`, duration: 9000 });
  },
};
