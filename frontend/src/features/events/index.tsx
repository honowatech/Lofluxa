/** Écran 6 — Journal des événements : fil horodaté de la journée, assistant de réaffectation, pénurie produit. */
import {
  ClipboardCheck,
  Droplets,
  Fuel,
  Lock,
  PackageCheck,
  PencilLine,
  RefreshCw,
  Send,
  Truck,
  UserX,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Notice, PageHeader } from "@/components/PageHeader";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fr } from "@/i18n/fr";
import { useCan } from "@/lib/auth/session";
import { formatDateLong, formatLocalTime } from "@/lib/format";
import { EVENT_TYPES, type EventType, type IsoDate } from "@/lib/types";
import { useDay } from "@/lib/useDay";
import { cn } from "@/lib/utils";

import { useEvents, type EventItem } from "./api";
import { ReassignDialog } from "./ReassignDialog";
import { ShortageDialog } from "./ShortageDialog";
import { summarize } from "./summary";

const t = fr.screens.events;

const TYPE_STYLE: Record<EventType, { icon: LucideIcon; tone: Tone }> = {
  truck_breakdown: { icon: Truck, tone: "blocking" },
  driver_unavailable: { icon: UserX, tone: "blocking" },
  product_shortage: { icon: Droplets, tone: "warning" },
  manual_edit: { icon: PencilLine, tone: "neutral" },
  publish: { icon: Send, tone: "success" },
  replan: { icon: RefreshCw, tone: "info" },
  loading_recorded: { icon: Fuel, tone: "primary" },
  delivery_recorded: { icon: PackageCheck, tone: "primary" },
};
const FALLBACK_STYLE = { icon: ClipboardCheck, tone: "neutral" as Tone };

function EventRow({ event, day }: { event: EventItem; day: IsoDate }) {
  const summary = summarize(event, day);
  const style = TYPE_STYLE[event.type] ?? FALLBACK_STYLE;
  const Icon = style.icon;
  const planVersion = event.payload.plan_version;
  return (
    <li
      className="grid grid-cols-[3.25rem_11.5rem_minmax(0,1fr)_auto] items-start gap-x-3 border-b px-3 py-2 last:border-b-0"
      data-testid="event-row"
      data-type={event.type}
    >
      <time dateTime={event.occurred_at} className="num pt-0.5 text-sm font-medium tabular-nums">
        {formatLocalTime(event.occurred_at)}
      </time>
      <div className="pt-px">
        <Badge tone={style.tone}>
          <Icon className="size-3" aria-hidden />
          {t.types[event.type] ?? event.type}
        </Badge>
      </div>
      <div className="min-w-0">
        <p className={cn("text-sm", summary.warning && "font-medium")}>{summary.title}</p>
        {summary.details.map((line) => (
          <p
            key={line}
            className={cn("text-xs text-muted-foreground", line === t.feed.rm13 && "text-warning")}
          >
            {line}
          </p>
        ))}
        <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          {event.trip_id && <span>{t.feed.trip(event.trip_seq, event.truck_plate)}</span>}
          {typeof planVersion === "number" && <span>{t.feed.planVersion(planVersion)}</span>}
          <span>{t.feed.by(event.actor_name ?? t.feed.system)}</span>
        </p>
      </div>
      <div className="flex flex-col items-end gap-0.5 pt-0.5">
        {summary.links.map((link) => (
          <Link
            key={link.to}
            to={link.to}
            className="whitespace-nowrap text-xs font-medium text-primary underline-offset-2 hover:underline focus-ring"
          >
            {link.label}
          </Link>
        ))}
      </div>
    </li>
  );
}

function FilterChip({
  label,
  count,
  pressed,
  onClick,
}: {
  label: string;
  count: number;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors focus-ring",
        pressed
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input bg-card text-foreground/80 hover:bg-muted",
        count === 0 && !pressed && "text-muted-foreground/70",
      )}
    >
      {label}
      <span className={cn("num tabular-nums", pressed ? "opacity-80" : "text-muted-foreground")}>
        {count}
      </span>
    </button>
  );
}

export default function EventsPage() {
  const { day } = useDay();
  const canWrite = useCan("events.write");
  const events = useEvents(day);
  const [selected, setSelected] = useState<ReadonlySet<EventType>>(new Set());
  const [reassignOpen, setReassignOpen] = useState(false);
  const [shortageOpen, setShortageOpen] = useState(false);

  const all = useMemo(() => events.data ?? [], [events.data]);
  const counts = useMemo(() => {
    const map = new Map<EventType, number>();
    for (const event of all) map.set(event.type, (map.get(event.type) ?? 0) + 1);
    return map;
  }, [all]);
  const visible = selected.size === 0 ? all : all.filter((event) => selected.has(event.type));

  const toggle = (type: EventType) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });

  return (
    <div className="flex h-full flex-col gap-3 p-4" data-testid="screen-events">
      <PageHeader
        title={fr.nav.screens.events}
        subtitle={t.subtitle(formatDateLong(day), all.length)}
        actions={
          <>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t.refresh}
              title={t.refresh}
              onClick={() => events.refetch()}
              disabled={events.isFetching}
            >
              <RefreshCw className={cn(events.isFetching && "animate-spin")} aria-hidden />
            </Button>
            {canWrite && (
              <>
                <Button variant="outline" onClick={() => setShortageOpen(true)}>
                  <Droplets aria-hidden />
                  {t.actions.shortage}
                </Button>
                <Button onClick={() => setReassignOpen(true)}>
                  <Truck aria-hidden />
                  {t.actions.reassign}
                </Button>
              </>
            )}
          </>
        }
      />
      {!canWrite && (
        <Notice tone="neutral" icon={<Lock className="size-3.5" />}>
          {t.readOnlyNotice}
        </Notice>
      )}

      <div role="group" aria-label={t.filters.label} className="flex flex-wrap items-center gap-1.5">
        <FilterChip
          label={t.filters.all}
          count={all.length}
          pressed={selected.size === 0}
          onClick={() => setSelected(new Set())}
        />
        {EVENT_TYPES.map((type) => (
          <FilterChip
            key={type}
            label={t.types[type]}
            count={counts.get(type) ?? 0}
            pressed={selected.has(type)}
            onClick={() => toggle(type)}
          />
        ))}
      </div>

      <section className="min-h-0 flex-1 overflow-y-auto rounded-md border bg-card" aria-label={t.feedLabel}>
        {events.isLoading ? (
          <LoadingState />
        ) : events.error ? (
          <ErrorState error={events.error} onRetry={() => events.refetch()} />
        ) : all.length === 0 ? (
          <EmptyState title={t.empty.title} description={t.empty.description} />
        ) : visible.length === 0 ? (
          <EmptyState
            title={t.empty.filteredTitle}
            description={t.empty.filteredDescription}
            action={
              <Button variant="outline" size="sm" onClick={() => setSelected(new Set())}>
                {t.empty.resetFilters}
              </Button>
            }
          />
        ) : (
          <ol>
            {visible.map((event) => (
              <EventRow key={event.id} event={event} day={day} />
            ))}
          </ol>
        )}
      </section>

      {canWrite && (
        <>
          <ReassignDialog day={day} open={reassignOpen} onOpenChange={setReassignOpen} />
          <ShortageDialog day={day} open={shortageOpen} onOpenChange={setShortageOpen} />
        </>
      )}
    </div>
  );
}
