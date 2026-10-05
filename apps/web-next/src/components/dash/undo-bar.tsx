"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Dashboard-local "did something · Undo" bar. The global ToastProvider has no
// action support, and undo only makes sense next to the thing that changed.

export interface UndoNotice {
  id: number;
  message: string;
  tone?: "neutral" | "error";
  undo?: () => void;
}

const DISMISS_MS = 6000;

export function useUndoBar() {
  const [notice, setNotice] = useState<UndoNotice | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setNotice(null);
  }, []);

  const show = useCallback((n: Omit<UndoNotice, "id">) => {
    if (timer.current) clearTimeout(timer.current);
    setNotice({ ...n, id: Date.now() });
    timer.current = setTimeout(() => setNotice(null), DISMISS_MS);
  }, []);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return { notice, show, dismiss };
}

export function UndoBar({ notice, onDismiss }: { notice: UndoNotice | null; onDismiss: () => void }) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4"
    >
      {notice && (
        <div
          key={notice.id}
          role="status"
          className="dash-toast pointer-events-auto flex items-center gap-4 rounded-lg border border-(--dash-rule-strong) bg-(--dash-panel) py-2.5 pl-4 pr-2 text-sm shadow-[0_12px_32px_-12px_oklch(0.25_0.05_252/0.35)]"
        >
          <span className={notice.tone === "error" ? "text-(--dash-red) font-medium" : "text-(--dash-ink)"}>
            {notice.message}
          </span>
          <span className="flex items-center gap-1">
            {notice.undo && (
              <button
                type="button"
                onClick={() => { notice.undo?.(); onDismiss(); }}
                className="rounded-md px-2.5 py-1 font-semibold text-(--dash-blue) hover:bg-(--dash-wash)"
              >
                Undo
              </button>
            )}
            <button
              type="button"
              aria-label="Dismiss"
              onClick={onDismiss}
              className="grid size-7 place-items-center rounded-md text-(--dash-ink-3) hover:bg-(--dash-wash) hover:text-(--dash-ink)"
            >
              <span aria-hidden className="material-symbols-outlined text-[16px]">close</span>
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
