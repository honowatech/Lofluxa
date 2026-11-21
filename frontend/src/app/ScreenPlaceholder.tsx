/** Page d'attente d'un écran de vague 2 : à remplacer par l'écran réel dans son dossier `features/`. */
import { Construction } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { fr } from "@/i18n/fr";
import type { ScreenId } from "@/lib/auth/roles";
import { formatDateLong } from "@/lib/format";
import { useDay } from "@/lib/useDay";

import { screenById } from "./screens";

type PlaceholderScreen = keyof typeof fr.placeholder.scope;

export function ScreenPlaceholder({ screen }: { screen: Extract<ScreenId, PlaceholderScreen> }) {
  const { day } = useDay();
  const def = screenById(screen);
  const title = fr.nav.screens[screen];
  return (
    <div className="flex flex-col gap-4 p-4" data-testid={`screen-${screen}`}>
      <PageHeader
        title={title}
        subtitle={`${fr.shell.day} : ${formatDateLong(day)}`}
        actions={<Badge tone="info">{fr.placeholder.badge}</Badge>}
      />
      <section className="flex max-w-2xl gap-4 rounded-md border bg-card p-5">
        <Construction className="mt-0.5 size-6 shrink-0 text-muted-foreground" aria-hidden />
        <div className="flex flex-col gap-3">
          <div>
            <h2 className="text-sm font-semibold">{fr.placeholder.title}</h2>
            <p className="text-xs text-muted-foreground">{fr.placeholder.body(title)}</p>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground/60">
              {fr.placeholder.contents} — écran {def.number}
            </h3>
            <p className="text-sm">{fr.placeholder.scope[screen]}</p>
          </div>
        </div>
      </section>
    </div>
  );
}
