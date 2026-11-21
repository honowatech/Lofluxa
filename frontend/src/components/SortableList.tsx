/**
 * Liste réordonnable par glisser-déposer (dnd-kit), utilisable aussi au clavier
 * (focus sur la poignée, Espace pour saisir, flèches pour déplacer, Espace pour poser).
 *
 *   <SortableList items={stops} getId={(s) => s.id} onReorder={setStops}
 *     renderItem={(stop, handle) => <div className="flex">{handle}{stop.name}</div>} />
 */
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface SortableListProps<T> {
  items: T[];
  getId: (item: T) => string;
  /** Liste réordonnée, et déplacement effectué (pour `useFieldArray().move`). */
  onReorder: (items: T[], move: { from: number; to: number }) => void;
  /** `handle` : poignée à placer dans la ligne. */
  renderItem: (item: T, handle: ReactNode, index: number) => ReactNode;
  disabled?: boolean;
  /**
   * `"standalone"` (défaut) : la liste gère seule son glisser-déposer.
   * `"parent"` : la liste s'inscrit dans le `<DndContext>` fourni par le parent (déplacement d'une liste à une
   * autre) ; c'est alors le parent qui traite `onDragEnd` — `onReorder` n'est pas appelé. Utiliser
   * `useSortableSensors()` pour les mêmes capteurs, et `id` pour reconnaître la liste d'arrivée.
   */
  context?: "standalone" | "parent";
  /** Identifiant du `SortableContext` (liste d'arrivée dans `onDragEnd` du parent). */
  id?: string;
  /** Libellé accessible de la poignée. */
  handleLabel?: (item: T, index: number) => string;
  className?: string;
}

function Row({
  id,
  disabled,
  label,
  children,
}: {
  id: string;
  disabled?: boolean;
  label: string;
  children: (handle: ReactNode) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });
  const handle = (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      className="grid h-7 w-5 shrink-0 cursor-grab touch-none place-items-center rounded-sm text-muted-foreground hover:bg-muted focus-ring active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
      {...attributes}
      {...listeners}
    >
      <GripVertical className="size-3.5" />
    </button>
  );
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && "relative z-10 rounded-md bg-card shadow-pop")}
    >
      {children(handle)}
    </li>
  );
}

/** Capteurs de `SortableList` (souris avec seuil de 4 px, clavier) : à passer au `<DndContext>` du parent. */
export function useSortableSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

export function SortableList<T>({
  items,
  getId,
  onReorder,
  renderItem,
  disabled,
  handleLabel,
  className,
  context = "standalone",
  id,
}: SortableListProps<T>) {
  const sensors = useSortableSensors();
  const ids = items.map(getId);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from >= 0 && to >= 0) onReorder(arrayMove(items, from, to), { from, to });
  };

  const list = (
    <SortableContext id={id} items={ids} strategy={verticalListSortingStrategy}>
      <ul className={cn("flex flex-col", className)}>
        {items.map((item, index) => (
          <Row
            key={ids[index]}
            id={ids[index]}
            disabled={disabled}
            label={handleLabel?.(item, index) ?? `${index + 1}`}
          >
            {(handle) => renderItem(item, handle, index)}
          </Row>
        ))}
      </ul>
    </SortableContext>
  );
  if (context === "parent") return list;

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      {list}
    </DndContext>
  );
}
