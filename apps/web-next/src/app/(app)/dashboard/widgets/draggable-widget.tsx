"use client";

import { ReactNode, useRef } from "react";
import { cn } from "@/lib/cn";
import { WidgetId } from "./registry";

// Wraps an optional widget so it can be reordered in edit mode. When
// `editing` is true, the wrapper becomes draggable, shows a dashed outline
// and a grab handle in the top-right, and fires `onReorder` with the new
// sibling order on drop. Mirrors the native HTML5 drag-and-drop flow from
// layout-editor.js.
export function DraggableWidget({
  id,
  editing,
  dragState,
  onDragStart,
  onDragEnter,
  onDragEnd,
  children,
}: {
  id: WidgetId;
  editing: boolean;
  dragState: { dragging: WidgetId | null };
  onDragStart: (id: WidgetId) => void;
  onDragEnter: (id: WidgetId) => void;
  onDragEnd: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const isBeingDragged = dragState.dragging === id;

  return (
    <div
      ref={ref}
      data-widget={id}
      draggable={editing}
      onDragStart={(e) => {
        if (!editing) return;
        e.dataTransfer.effectAllowed = "move";
        try {
          e.dataTransfer.setData("text/plain", id);
        } catch (err) {
          // Firefox quirk: dataTransfer.setData can throw — drag still works.
          console.warn("[dashboard/draggable-widget] dataTransfer.setData failed:", err);
        }
        onDragStart(id);
      }}
      onDragOver={(e) => {
        if (!editing || !dragState.dragging || dragState.dragging === id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragEnter(id);
      }}
      onDragEnd={() => {
        if (!editing) return;
        onDragEnd();
      }}
      onDrop={(e) => {
        if (!editing) return;
        e.preventDefault();
      }}
      className={cn(
        "relative transition-opacity",
        editing && "cursor-grab rounded-lg outline-1 outline-offset-4 outline-dashed outline-(--dash-blue-3)",
        isBeingDragged && "opacity-50",
      )}
    >
      {editing && (
        <span
          className="material-symbols-outlined cursor-grab active:cursor-grabbing absolute top-2 right-2 z-20 bg-white text-[#003366] rounded-md p-1 shadow-md text-[18px]"
          title="Drag to reorder"
        >
          drag_indicator
        </span>
      )}
      {children}
    </div>
  );
}
