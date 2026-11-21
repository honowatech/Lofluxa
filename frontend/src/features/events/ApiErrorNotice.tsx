/** Refus du serveur expliqué : texte propre au code d'erreur, message du serveur, règles en cause. */
import { Notice } from "@/components/PageHeader";
import { ViolationsPanel } from "@/components/ViolationsPanel";
import { fr } from "@/i18n/fr";
import { errorMessage, isApiError } from "@/lib/api";

const codes: Record<string, string> = fr.screens.events.errorCodes;

export function ApiErrorNotice({ title, error }: { title: string; error: unknown }) {
  if (!error) return null;
  const explanation = isApiError(error) ? codes[error.code] : undefined;
  return (
    <>
      <Notice tone="blocking">
        <strong className="font-semibold">{title}.</strong> {errorMessage(error)}
        {explanation && <span className="mt-0.5 block font-normal">{explanation}</span>}
      </Notice>
      {isApiError(error) && <ViolationsPanel violations={error.violations} hideWhenEmpty />}
    </>
  );
}
