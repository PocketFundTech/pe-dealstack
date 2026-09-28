"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * Right-side sheet for dash-styled pages. Keeps the page visible behind it —
 * cheaper to scan and dismiss than a centred modal. Esc / overlay click
 * closes; focus moves into the sheet on open and returns to the trigger on
 * close; body scroll is locked while open.
 *
 * Must render inside a `.dash` element so the design tokens resolve.
 */
export function SideSheet({
  open,
  onClose,
  eyebrow,
  title,
  subtitle,
  children,
  footer,
  width = 440,
}: {
  open: boolean;
  onClose: () => void;
  eyebrow?: string;
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const returnFocus = document.activeElement as HTMLElement | null;
    // Focus the first field when there is one, otherwise the panel itself.
    const first = panelRef.current?.querySelector<HTMLElement>("input, select, textarea");
    (first ?? panelRef.current)?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
      returnFocus?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="dash-fade absolute inset-0 bg-[oklch(0.22_0.03_252/0.32)]" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ maxWidth: width }}
        className="dash-sheet relative flex h-full w-full flex-col border-l border-(--dash-rule) bg-(--dash-panel) shadow-[-24px_0_48px_-24px_oklch(0.25_0.05_252/0.3)] outline-none"
      >
        <header className="flex items-start justify-between gap-4 border-b border-(--dash-rule) px-6 pt-6 pb-4">
          <div className="min-w-0">
            {eyebrow && <p className="dash-label">{eyebrow}</p>}
            <h2 id={titleId} className="dash-display mt-1 truncate text-2xl text-(--dash-ink)">{title}</h2>
            {subtitle && <div className="mt-1 text-sm text-(--dash-ink-2)">{subtitle}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-8 shrink-0 place-items-center rounded-md text-(--dash-ink-3) hover:bg-(--dash-wash) hover:text-(--dash-ink)"
          >
            <span aria-hidden className="material-symbols-outlined">close</span>
          </button>
        </header>
        <div className="flex-1 overflow-y-auto">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-(--dash-rule) px-6 py-3.5">{footer}</footer>}
      </div>
    </div>
  );
}
