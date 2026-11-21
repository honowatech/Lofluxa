import { ScreenPlaceholder } from "@/app/ScreenPlaceholder";

/** Page d'attente : l'écran réel est construit en vague 2 dans ce dossier. */
export default function Page() {
  return <ScreenPlaceholder screen="loading" />;
}
