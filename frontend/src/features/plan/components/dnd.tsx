/**
 * Glisser-déposer des arrêts (dnd-kit) : un seul contexte pour tout l'écran, afin qu'un arrêt puisse passer
 * du détail d'une tournée à une autre tournée de la liste, ou d'une tournée à l'autre dans la vue tableau.
 * Dépôt sur un arrêt = insertion à sa place ; dépôt sur une tournée = ajout en fin de tournée.
 * Au clavier : focus sur la poignée, Espace pour saisir, flèches, Espace pour poser (Échap annule).
 */
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type Collision,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";

import { fr } from "@/i18n/fr";
import { cn } from "@/lib/utils";

import { usePlanUi } from "../context";
import { dropOp, findStop, isStopMovable } from "../edits";
import { usePlanStore, type StopZone } from "../store";
import type { Stop, Trip } from "../types";

const t = fr.screens.plan;

interface StopData {
  type: "stop";
  stopId: string;
  tripId: string;
  zone: StopZone;
}
interface TripData {
  type: "trip";
  tripId: string;
}
type DropData = StopData | TripData;

const dataOf = (collision: Collision): DropData | undefined =>
  collision.data?.droppableContainer?.data?.current as DropData | undefined;

/** Sous le pointeur d'abord ; à défaut (clavier) le plus proche. Un arrêt l'emporte sur la tournée qui le contient. */
const collisionDetection: CollisionDetection = (args) => {
  const pointer = pointerWithin(args);
  const hits = pointer.length > 0 ? pointer : closestCenter(args);
  return [...hits].sort(
    (a, b) => (dataOf(a)?.type === "stop" ? 0 : 1) - (dataOf(b)?.type === "stop" ? 0 : 1),
  );
};

export function PlanDnd({ children }: { children: ReactNode }) {
  const { edit, canEdit } = usePlanUi();
  const [active, setActive] = useState<StopData | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragStart = useCallback((event: DragStartEvent) => {
    setActive((event.active.data.current as StopData | undefined) ?? null);
  }, []);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActive(null);
      const dragged = event.active.data.current as StopData | undefined;
      const over = event.over?.data.current as DropData | undefined;
      const plan = usePlanStore.getState().confirmed;
      if (!canEdit || !dragged || !over || !plan) return;
      const op = dropOp(plan, dragged.stopId, over);
      if (!op) return;
      void edit(op, { focusStopId: dragged.stopId, zone: dragged.zone });
      usePlanStore.getState().selectStop(dragged.stopId);
    },
    [canEdit, edit],
  );

  const draggedStop = usePlanStore((state) => (active ? findStop(state.plan, active.stopId)?.stop : null));

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActive(null)}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {draggedStop ? (
          <div className="flex w-64 items-center gap-2 rounded-md border border-primary/50 bg-card px-2 py-1.5 text-sm shadow-pop">
            <GripVertical className="size-3.5 text-muted-foreground" aria-hidden />
            <span className="num text-xs text-muted-foreground">{draggedStop.station_code}</span>
            <span className="truncate font-medium">{draggedStop.station_name}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/** Identifiant dnd d'un arrêt : distinct par zone, le même arrêt pouvant être affiché deux fois. */
export const stopDndId = (zone: StopZone, stopId: string): string => `${zone}:stop:${stopId}`;

/** Arrêt réordonnable : à utiliser dans un `SortableContext` de la tournée. */
export function useStopSortable(zone: StopZone, trip: Trip, stop: Stop) {
  const { canEdit, busy } = usePlanUi();
  const movable = canEdit && isStopMovable(trip, stop);
  const sortable = useSortable({
    id: stopDndId(zone, stop.id),
    data: { type: "stop", stopId: stop.id, tripId: trip.id, zone } satisfies StopData,
    disabled: !movable || busy,
  });
  const activeData = sortable.active?.data.current as StopData | undefined;
  // Arrêt venu d'une autre tournée : pas de décalage visuel de la liste, un repère d'insertion à la place.
  const foreign = !!activeData && activeData.tripId !== trip.id;
  const handle = (
    <button
      type="button"
      aria-label={t.stops.handle(stop.station_name ?? stop.station_code ?? "")}
      disabled={!movable || busy}
      title={movable ? undefined : canEdit ? t.stops.notMovable : undefined}
      className="grid h-7 w-5 shrink-0 cursor-grab touch-none place-items-center rounded-sm text-muted-foreground hover:bg-muted focus-ring active:cursor-grabbing disabled:cursor-default disabled:opacity-30"
      {...sortable.attributes}
      {...sortable.listeners}
    >
      <GripVertical className="size-3.5" aria-hidden />
    </button>
  );
  return {
    movable,
    handle,
    setNodeRef: sortable.setNodeRef,
    style: foreign
      ? undefined
      : { transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition },
    isDragging: sortable.isDragging,
    insertHere: foreign && sortable.isOver,
  };
}

/** Tournée cible d'un dépôt (ajout en fin de tournée). */
export function useTripDroppable(trip: Trip, zone: "list" | "table" | "detail") {
  const { canEdit } = usePlanUi();
  const droppable = useDroppable({
    id: `${zone}:trip:${trip.id}`,
    data: { type: "trip", tripId: trip.id } satisfies TripData,
    disabled: !canEdit || trip.status === "completed",
  });
  const activeData = droppable.active?.data.current as StopData | undefined;
  const accepts = !!activeData && activeData.tripId !== trip.id;
  return { setNodeRef: droppable.setNodeRef, isTarget: accepts && droppable.isOver, accepts };
}

export const dropTargetClass = (isTarget: boolean, accepts: boolean) =>
  cn(
    accepts && "outline-dashed outline-1 outline-primary/40",
    isTarget && "bg-accent outline-2 outline-primary",
  );
