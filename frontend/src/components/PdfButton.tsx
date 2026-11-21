/**
 * Bouton de téléchargement d'un PDF généré par le serveur (feuille de route, fiche de chargement, rapport A/B).
 *   <PdfButton path={`/trips/${trip.id}/route-sheet.pdf`} label="Feuille de route" />
 *   <PdfButton path="/comparison.pdf" query={{ plan_a, plan_b }} fallbackName="comparaison.pdf" />
 */
import { FileDown } from "lucide-react";
import { useState } from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { fr } from "@/i18n/fr";
import { downloadFile, openFile } from "@/lib/api/files";
import type { Query } from "@/lib/api/client";

import { notify } from "./notify";
import { Spinner } from "./states";

export interface PdfButtonProps extends Omit<ButtonProps, "onClick" | "children"> {
  /** Chemin de l'API, sans le préfixe `/api/v1`. */
  path: string;
  query?: Query;
  label?: string;
  /** Nom du fichier si le serveur n'en fournit pas. */
  fallbackName?: string;
  /** `download` (défaut) enregistre le fichier ; `open` l'ouvre dans un nouvel onglet. */
  mode?: "download" | "open";
}

export function PdfButton({
  path,
  query,
  label = fr.pdf.download,
  fallbackName = "document.pdf",
  mode = "download",
  variant = "outline",
  disabled,
  ...props
}: PdfButtonProps) {
  const [busy, setBusy] = useState(false);

  const handleClick = async () => {
    setBusy(true);
    try {
      if (mode === "open") await openFile(path, { query });
      else notify.success(fr.pdf.done(await downloadFile(path, { query, fallbackName })));
    } catch (error) {
      notify.apiError(error, fr.pdf.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button variant={variant} onClick={handleClick} disabled={disabled || busy} aria-busy={busy} {...props}>
      {busy ? <Spinner className="text-current" /> : <FileDown aria-hidden />}
      {busy ? fr.pdf.generating : label}
    </Button>
  );
}
