"use client";

import { ReactNode, useEffect } from "react";

// Shared modal shell for the 3 task modals. Mirrors the #modal-card
// markup in onboarding.html.
export function TaskModalShell({
  icon,
  title,
  onClose,
  onComplete,
  completeLabel = "Mark as done",
  busyLabel = "Working...",
  canComplete = true,
  busy = false,
  secondaryAction,
  children,
}: {
  icon: string;
  title: string;
  onClose: () => void;
  onComplete: () => void;
  completeLabel?: string;
  busyLabel?: string;
  canComplete?: boolean;
  busy?: boolean;
  /** Optional extra footer action (e.g. "Skip for now"), left of the primary button. */
  secondaryAction?: { label: string; onClick: () => void };
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Capture the prior inline overflow so we restore it (not "") on unmount.
    // The root body has the `overflow-hidden` Tailwind class set in
    // apps/web-next/src/app/layout.tsx — clearing the inline style to "" would
    // leak the wizard's lock state into the rest of the app.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(17,24,39,0.45)", backdropFilter: "blur(4px)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary-light flex items-center justify-center">
              <span className="material-symbols-outlined text-primary text-[18px]">{icon}</span>
            </div>
            <h3 className="font-semibold text-[16px] text-text-main">{title}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-text-muted hover:text-text-main transition-colors"
            aria-label="Close"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="px-6 py-5 overflow-y-auto">{children}</div>
        <div className="px-6 py-4 bg-gray-50 border-t border-border-subtle flex items-center justify-between flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="text-[13px] text-text-secondary hover:text-text-main transition-colors"
          >
            Cancel
          </button>
          <div className="flex items-center gap-3">
          {secondaryAction && (
            <button
              type="button"
              onClick={secondaryAction.onClick}
              disabled={busy}
              className="text-[13px] text-text-secondary hover:text-text-main transition-colors disabled:opacity-50"
            >
              {secondaryAction.label}
            </button>
          )}
          <button
            type="button"
            onClick={onComplete}
            disabled={!canComplete || busy}
            className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-semibold text-white transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ backgroundColor: "#003366" }}
          >
            {busy ? busyLabel : completeLabel}
            {!busy && <span className="material-symbols-outlined text-[16px]">check</span>}
          </button>
          </div>
        </div>
      </div>
    </div>
  );
}
