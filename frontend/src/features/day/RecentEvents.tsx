/** Derniers événements du jour sur l'accueil, avec l'accès au Journal des événements. */
import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";

import { ErrorState, Skeleton } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { fr } from "@/i18n/fr";
import { formatLocalTime } from "@/lib/format";
import { withDay } from "@/lib/useDay";

import type { DayEvent } from "./api";
import { Card } from "./SummaryCards";

const t = fr.screens.day.events;

/** Chemin de l'écran Journal des événements (`src/app/screens.ts`). */
export const EVENTS_PATH = "/journal";

export function RecentEvents({
  day,
  events,
  total,
  loading,
  error,
  onRetry,
}: {
  day: string;
  events: DayEvent[];
  total: number;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <Card
      title={t.title}
      testId="recent-events"
      aside={
        <Link
          to={withDay(EVENTS_PATH, day)}
          className="inline-flex items-center gap-1 rounded-sm text-xs font-medium text-primary underline-offset-2 hover:underline focus-ring"
        >
          {t.openJournal}
          <ArrowRight className="size-3" aria-hidden />
        </Link>
      }
    >
      {loading ? (
        <div className="flex flex-col gap-2" aria-busy>
          <Skeleton className="w-3/4" />
          <Skeleton className="w-1/2" />
        </div>
      ) : error && events.length === 0 ? (
        <ErrorState compact error={error} onRetry={onRetry} />
      ) : events.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t.none}</p>
      ) : (
        <>
          <ul className="-my-1 divide-y">
            {events.map((event) => (
              <li
                key={event.id}
                className="flex items-start gap-2 py-1.5 text-xs"
                data-event-type={event.type}
              >
                <span className="num w-10 shrink-0 text-muted-foreground">
                  {formatLocalTime(event.occurred_at)}
                </span>
                <Badge tone="neutral" className="shrink-0">
                  {event.type_label}
                </Badge>
                <span className="min-w-0 flex-1 leading-snug">
                  {event.summary}
                  {event.actor_name && (
                    <span className="text-muted-foreground"> — {t.by(event.actor_name)}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {total > events.length && (
            <p className="text-xs text-muted-foreground">{t.more(total - events.length)}</p>
          )}
        </>
      )}
    </Card>
  );
}
