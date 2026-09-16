import { PointerSensor, type KeyboardCoordinateGetter, type PointerSensorOptions } from "@dnd-kit/core";
import type { PointerEvent } from "react";

/**
 * PointerSensor for mouse and pen only. Touch pointers are left to TouchSensor (long-press delay), so a
 * horizontal swipe between columns scrolls the board instead of starting a drag after 8px.
 */
export class MousePointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: ({ nativeEvent: event }: PointerEvent, { onActivation }: PointerSensorOptions): boolean => {
        if (event.pointerType === "touch" || !event.isPrimary || event.button !== 0) return false;
        onActivation?.({ event });
        return true;
      },
    },
  ];
}

export interface RectLike {
  left: number;
  width: number;
}

/**
 * Horizontal distance to move a dragged card so it is centered on the neighboring column, or null when
 * there is no neighbor in that direction. Columns are identified by their measured rects.
 */
export function columnStepDelta(current: RectLike, columns: readonly RectLike[], direction: "left" | "right"): number | null {
  if (columns.length === 0) return null;
  const sorted = [...columns].sort((a, b) => a.left - b.left);
  const center = current.left + current.width / 2;
  const index = sorted.findIndex((rect) => center >= rect.left && center < rect.left + rect.width);
  if (index < 0) {
    // Between or outside columns: the nearest column in the direction of travel is the next one.
    const next =
      direction === "right"
        ? sorted.find((rect) => rect.left + rect.width / 2 > center)
        : [...sorted].reverse().find((rect) => rect.left + rect.width / 2 < center);
    return next ? next.left + (next.width - current.width) / 2 - current.left : null;
  }
  const target = sorted[direction === "right" ? index + 1 : index - 1];
  if (!target) return null;
  return target.left + (target.width - current.width) / 2 - current.left;
}

/** Arrow Left/Right jump a keyboard drag one column at a time; other keys do not move it. */
export const columnKeyboardCoordinates: KeyboardCoordinateGetter = (event, { context, currentCoordinates }) => {
  if (event.code !== "ArrowRight" && event.code !== "ArrowLeft") return undefined;
  const { collisionRect, droppableRects, droppableContainers } = context;
  if (!collisionRect) return undefined;
  event.preventDefault();
  const rects: RectLike[] = [];
  for (const container of droppableContainers.getEnabled()) {
    const rect = droppableRects.get(container.id);
    if (rect) rects.push(rect);
  }
  const delta = columnStepDelta(collisionRect, rects, event.code === "ArrowRight" ? "right" : "left");
  if (delta === null) return undefined;
  return { x: currentCoordinates.x + delta, y: currentCoordinates.y };
};
