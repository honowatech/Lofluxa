/**
 * Liste réordonnable par glisser-déposer (dnd-kit), utilisable aussi au clavier
 * (focus sur la poignée, Espace pour saisir, flèches pour déplacer, Espace pour poser).
 *
 *   <SortableList items={stops} getId={(s) => s.id} onReorder={setStops}
 *     renderItem={(stop, handle) => <div className="flex">{handle}{stop.name}</div>} />
 *
 * Dans un tableau : `as="tbody"` rend `<tbody>` / `<tr>`, `renderItem` renvoie alors les `<td>` de la ligne.
 *   <table><SortableList as="tbody" items={stops} getId={…} onReorder={…}
 *     isDisabled={(stop) => stop.status !== "pending"}            // un arrêt livré ou sauté est figé seul
 *     rowClassName={(stop, state) => cn(state.insert === "before" && "border-t-2 border-primary")}
 *     renderItem={(stop, handle) => (<><td>{handle}</td><td>{stop.name}</td></>)} /></table>
 * Le 4ᵉ argument de `renderItem` (et le 2ᵉ de `rowClassName`) décrit le glisser en cours : `isDragging`,
 * `isOver`, `activeId`, et `insert` (« before » / « after ») pour dessiner le repère d'insertion.
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
import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

/** État de glisser-déposer d'une ligne, pour le rendu (repère d'insertion, ligne en cours de déplacement). */
export interface SortableRowState {
  /** Cette ligne est celle qu'on déplace. */
  isDragging: boolean;
  /** L'élément déplacé survole cette ligne. */
  isOver: boolean;
  /** Un glisser est en cours dans le contexte (cette liste ou, en mode `parent`, une autre). */
  isSorting: boolean;
  /** Identifiant de l'élément déplacé (`null` hors glisser). */
  activeId: string | null;
  /** Où l'élément déplacé s'insérerait par rapport à cette ligne survolée ; `null` si elle n'est pas survolée. */
  insert: "before" | "after" | null;
  /** Ligne figée (`disabled` ou `isDisabled`). */
  disabled: boolean;
}

export interface SortableListProps<T> {
  items: T[];
  getId: (item: T) => string;
  /** Liste réordonnée, et déplacement effectué (pour `useFieldArray().move`). */
  onReorder: (items: T[], move: { from: number; to: number }) => void;
  /** `handle` : poignée à placer dans la ligne. */
  renderItem: (item: T, handle: ReactNode, index: number, state: SortableRowState) => ReactNode;
  disabled?: boolean;
  /** Fige certains éléments seulement : ni déplaçables, ni poignée active (les autres restent mobiles). */
  isDisabled?: (item: T, index: number) => boolean;
  /** Balises rendues : `"ul"` (défaut) → `<ul>` / `<li>` ; `"tbody"` → `<tbody>` / `<tr>` (lignes de tableau). */
  as?: "ul" | "tbody";
  /** Classes d'une ligne (`<li>` ou `<tr>`), éventuellement selon l'état du glisser. */
  rowClassName?: string | ((item: T, state: SortableRowState, index: number) => string | undefined);
  /** Attributs supplémentaires d'une ligne (`data-*`, `aria-*`, `onClick`…). */
  rowProps?: (item: T, index: number) => HTMLAttributes<HTMLElement>;
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
  as,
  className,
  rowProps,
  children,
}: {
  id: string;
  disabled?: boolean;
  label: string;
  as: "li" | "tr";
  className?: string | ((state: SortableRowState) => string | undefined);
  rowProps?: HTMLAttributes<HTMLElement>;
  children: (handle: ReactNode, state: SortableRowState) => ReactNode;
}) {
  const sortable = useSortable({ id, disabled });
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable;
  const isOver = sortable.isOver && !isDragging;
  const state: SortableRowState = {
    isDragging,
    isOver,
    isSorting: sortable.isSorting,
    activeId: sortable.active ? String(sortable.active.id) : null,
    // Élément venu d'une autre liste (`activeIndex` < 0) ou de plus bas : il s'insère avant la ligne survolée.
    insert: !isOver
      ? null
      : sortable.activeIndex >= 0 && sortable.activeIndex < sortable.index
        ? "after"
        : "before",
    disabled: !!disabled,
  };
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
  const Tag = as;
  return (
    <Tag
      {...rowProps}
      ref={setNodeRef as (node: HTMLElement | null) => void}
      style={{ ...rowProps?.style, transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        isDragging && "relative z-10 rounded-md bg-card shadow-pop",
        rowProps?.className,
        typeof className === "function" ? className(state) : className,
      )}
    >
      {children(handle, state)}
    </Tag>
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
  isDisabled,
  as = "ul",
  rowClassName,
  rowProps,
}: SortableListProps<T>) {
  const sensors = useSortableSensors();
  const ids = items.map(getId);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from >= 0 && to >= 0) onReorder(arrayMove(items, from, to), { from, to });
  };

  const Container = as;
  const list = (
    <SortableContext id={id} items={ids} strategy={verticalListSortingStrategy}>
      <Container className={as === "ul" ? cn("flex flex-col", className) : className}>
        {items.map((item, index) => (
          <Row
            key={ids[index]}
            id={ids[index]}
            as={as === "ul" ? "li" : "tr"}
            disabled={disabled || isDisabled?.(item, index)}
            label={handleLabel?.(item, index) ?? `${index + 1}`}
            rowProps={rowProps?.(item, index)}
            className={
              typeof rowClassName === "function" ? (state) => rowClassName(item, state, index) : rowClassName
            }
          >
            {(handle, state) => renderItem(item, handle, index, state)}
          </Row>
        ))}
      </Container>
    </SortableContext>
  );
  if (context === "parent") return list;

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      {list}
    </DndContext>
  );
}
