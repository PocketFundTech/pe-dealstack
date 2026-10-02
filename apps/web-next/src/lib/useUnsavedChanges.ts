"use client";

import { useEffect } from "react";

/**
 * Warns before a tab close / reload / external navigation while `isDirty` is
 * true. Browsers ignore custom message text on `beforeunload` (they show
 * their own generic prompt) but still require `preventDefault()` +
 * `returnValue` set for the prompt to appear at all.
 *
 * This only covers navigation the browser itself intercepts. In-app link
 * clicks and modal backdrop/Escape closes aren't interceptable from a single
 * hook — callers with those need their own confirm-before-discard check
 * using the same `isDirty` value.
 */
export function useUnsavedChanges(isDirty: boolean): void {
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);
}
