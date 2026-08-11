"use client";

// Lightweight cross-component signal for "deals/documents changed" so list
// surfaces (deals list, data room, dashboard) can refetch WITHOUT a full page
// reload after an out-of-band mutation — e.g. a Google Drive / upload / text
// ingest that creates or updates a deal. Uses a DOM CustomEvent so any mounted
// listener re-runs its loader; no global store or extra dependency needed.
//
// This is deliberately fire-and-forget: emitters don't care who listens, and
// listeners refetch silently (no loading skeleton) so a background refresh
// doesn't flash the UI.

export const DEALS_CHANGED_EVENT = "pe:deals-changed";

export interface DealsChangedDetail {
  /** The deal that changed, if known — lets a data-room page ignore events for
   *  other deals. Omit for "some deal changed, refetch the list". */
  dealId?: string;
  /** Where the change originated, for debugging only. */
  source?: string;
}

/** Announce that a deal (and/or its documents) was created or updated. */
export function emitDealsChanged(detail: DealsChangedDetail = {}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<DealsChangedDetail>(DEALS_CHANGED_EVENT, { detail }),
  );
}

/**
 * Subscribe to deal-changed events. Returns an unsubscribe function suitable
 * for a useEffect cleanup. No-op on the server.
 */
export function onDealsChanged(
  handler: (detail: DealsChangedDetail) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) =>
    handler((e as CustomEvent<DealsChangedDetail>).detail ?? {});
  window.addEventListener(DEALS_CHANGED_EVENT, listener);
  return () => window.removeEventListener(DEALS_CHANGED_EVENT, listener);
}
