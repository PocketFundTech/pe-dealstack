"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface MenuItem {
  key: string;
  label: ReactNode;
  icon?: string;
  hint?: string;
  onSelect: () => void;
}

/**
 * Small dropdown for dash-styled pages. Outside click / Esc close it;
 * ArrowUp/Down move, Enter picks. Opens upward when there's no room below.
 */
export function Menu({
  trigger,
  triggerClassName,
  triggerLabel,
  items,
  align = "right",
  heading,
}: {
  trigger: ReactNode;
  triggerClassName?: string;
  /** Accessible name when the trigger is icon-only. */
  triggerLabel?: string;
  items: MenuItem[];
  align?: "left" | "right";
  heading?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [dropUp, setDropUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const toggle = () => {
    if (open) { setOpen(false); return; }
    const rect = rootRef.current?.getBoundingClientRect();
    setDropUp(Boolean(rect && window.innerHeight - rect.bottom < 300 && rect.top > 300));
    setActive(0);
    setOpen(true);
    requestAnimationFrame(() => listRef.current?.focus());
  };

  const pick = (item: MenuItem) => {
    setOpen(false);
    item.onSelect();
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerLabel}
        onClick={toggle}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open && (
        <div
          ref={listRef}
          role="menu"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, items.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
            if (e.key === "Enter" && items[active]) { e.preventDefault(); pick(items[active]); }
            if (e.key === "Escape") setOpen(false);
          }}
          className={cn(
            "dash-pop absolute z-40 max-h-72 w-max min-w-52 overflow-y-auto rounded-lg border border-(--dash-rule) bg-(--dash-panel) py-1 shadow-[0_16px_40px_-16px_oklch(0.25_0.05_252/0.35)] outline-none",
            align === "right" ? "right-0" : "left-0",
            dropUp ? "bottom-full mb-1.5" : "top-full mt-1.5",
          )}
        >
          {heading && <p className="dash-label px-3 pt-2 pb-1">{heading}</p>}
          {items.length === 0 && <p className="px-3 py-2 text-xs text-(--dash-ink-3)">Nothing to show</p>}
          {items.map((item, i) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(item)}
              className={cn(
                "flex w-full items-center gap-2.5 whitespace-nowrap px-3 py-2 text-left text-sm",
                i === active ? "bg-(--dash-wash) text-(--dash-blue)" : "text-(--dash-ink)",
              )}
            >
              {item.icon && <span aria-hidden className="material-symbols-outlined text-[18px]">{item.icon}</span>}
              <span className="flex-1">{item.label}</span>
              {item.hint && <span className="text-xs text-(--dash-ink-3)">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
