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

import { FilterChip, FilterChipGroup } from "@/components/FilterChip";
import { Notice, PageHeader } from "@/components/PageHeader";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fr } from "@/i18n/fr";
import { useCan } from "@/lib/auth/session";
import { formatDate, formatDateLong, formatLocalTime, todayLocal } from "@/lib/format";
import { EVENT_TYPES, type EventType, type IsoDate } from "@/lib/types";
import { useDay } from "@/lib/useDay";
import { cn } from "@/lib/utils";

import { useEvents, type EventOut, type ShortageStatus } from "./api";
import { ImpactDialog } from "./ImpactDialog";
import { ReassignDialog } from "./ReassignDialog";
import { ShortageDialog } from "./ShortageDialog";
import { present } from "./summary";

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
const SHORTAGE_TONE: Record<ShortageStatus, Tone> = {
  open: "warning",
  resolved: "success",
  no_impact: "muted",
};

function EventRow({
  event,
  day,
  canResolve,
  onOpenImpact,
}: {
  event: EventOut;
  day: IsoDate;
  canResolve: boolean;
  onOpenImpact: (eventId: string) => void;
}) {
  const view = present(event, day);
  const otherDay = todayLocal(new Date(event.occurred_at)) !== day;
  const style = TYPE_STYLE[event.type] ?? FALLBACK_STYLE;
  const Icon = style.icon;
  return (
    <li
      className="grid grid-cols-[5rem_11.5rem_minmax(0,1fr)_auto] items-start gap-x-3 border-b px-3 py-2 last:border-b-0"
      data-testid="event-row"
      data-type={event.type}
    >
      <time dateTime={event.occurred_at} className="flex flex-col pt-0.5">
        {otherDay && (
          // Événement daté d'un autre jour que le jour J affiché (saisie faite un autre jour) : date en clair.
          <span className="num text-xs text-warning" title={t.feed.otherDay(formatDate(event.occurred_at))}>
            {formatDate(event.occurred_at)}
          </span>
        )}
        <span className="num text-sm font-medium tabular-nums">{formatLocalTime(event.occurred_at)}</span>
      </time>
      <div className="flex flex-col items-start gap-1 pt-px">
        <Badge tone={style.tone}>
          <Icon className="size-3" aria-hidden />
          {t.types[event.type] ?? event.type_label}
        </Badge>
        {view.shortageStatus && (
          <Badge tone={SHORTAGE_TONE[view.shortageStatus]}>
            {t.feed.shortageStatus[view.shortageStatus]}
          </Badge>
        )}
      </div>
      <div className="min-w-0">
        <p className={cn("text-sm", view.warning && "font-medium")}>{event.summary}</p>
        {view.details.map((line) => (
          <p key={line} className="text-xs text-muted-foreground">
            {line}
          </p>
        ))}
        <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          {event.trip_id && <span>{t.feed.trip(event.trip_seq, event.truck_plate)}</span>}
          {event.plan_version != null && <span>{t.feed.planVersion(event.plan_version)}</span>}
          <span>{t.feed.by(event.actor_name ?? t.feed.system)}</span>
        </p>
      </div>
      <div className="flex flex-col items-end gap-1 pt-0.5">
        {view.shortageStatus && view.shortageStatus !== "no_impact" && (
          <Button
            variant={view.shortageStatus === "open" && canResolve ? "default" : "outline"}
            size="sm"
            onClick={() => onOpenImpact(event.id)}
          >
            {view.shortageStatus === "open" && canResolve ? t.feed.resolve : t.feed.viewImpact}
          </Button>
        )}
        {view.links.map((link) => (
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

export default function EventsPage() {
  const { day } = useDay();
  // Réaffectation et résolution d'une pénurie : dispatcher. Déclaration d'une pénurie : Supply (lot L10).
  const canWrite = useCan("events.write");
  const canDeclare = useCan("events.shortage.write");
  const events = useEvents(day);
  const [selected, setSelected] = useState<ReadonlySet<EventType>>(new Set());
  const [reassignOpen, setReassignOpen] = useState(false);
  const [shortageOpen, setShortageOpen] = useState(false);
  const [impactEventId, setImpactEventId] = useState<string | null>(null);

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
            {canDeclare && (
              <Button variant="outline" onClick={() => setShortageOpen(true)}>
                <Droplets aria-hidden />
                {t.actions.shortage}
              </Button>
            )}
            {canWrite && (
              <Button onClick={() => setReassignOpen(true)}>
                <Truck aria-hidden />
                {t.actions.reassign}
              </Button>
            )}
          </>
        }
      />
      {!canWrite && !canDeclare && (
        <Notice tone="neutral" icon={<Lock className="size-3.5" />}>
          {t.readOnlyNotice}
        </Notice>
      )}

      <FilterChipGroup label={t.filters.label} className="gap-1.5">
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
      </FilterChipGroup>

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
              <EventRow
                key={event.id}
                event={event}
                day={day}
                canResolve={canWrite}
                onOpenImpact={setImpactEventId}
              />
            ))}
          </ol>
        )}
      </section>

      {canWrite && <ReassignDialog day={day} open={reassignOpen} onOpenChange={setReassignOpen} />}
      {canDeclare && (
        <ShortageDialog
          day={day}
          open={shortageOpen}
          onOpenChange={setShortageOpen}
          onResolve={canWrite ? setImpactEventId : undefined}
        />
      )}
      <ImpactDialog
        day={day}
        eventId={impactEventId}
        canResolve={canWrite}
        onClose={() => setImpactEventId(null)}
      />
    </div>
  );
}
