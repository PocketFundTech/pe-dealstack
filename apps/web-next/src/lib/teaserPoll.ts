// Polling helper for the deal-intake "firm teaser" popup.
//
// Teasers used to be ready by the time the ingest response came back because
// the server generated them synchronously as part of the (blocking) ingest
// call. That blocking generation is going away — the server now returns as
// soon as extraction is done and generates teasers in the background — so
// the client has to poll GET /deals/:id/teasers until they show up (or give
// up after a timeout). Extracted as a pure function (injected fetch + cancel
// check) so it's testable without real timers or a mounted component.

import type { DealTeaser } from "@/lib/teaser";

export interface PollTeasersResult {
  teasers: DealTeaser[];
}

export interface PollTeasersOptions {
  /** Ms between polls. Default 2000. */
  intervalMs?: number;
  /** Total time to keep polling before giving up. Default 40000 (~40s). */
  timeoutMs?: number;
  /** Checked before each fetch and after each wait — return true to stop
   *  polling immediately (e.g. the component unmounted or the user closed
   *  the popup). */
  isCancelled: () => boolean;
  /** Injected so tests don't need a real network/Supabase client. Defaults
   *  to calling GET /deals/:id/teasers via the shared api client. */
  fetchTeasers: (dealId: string) => Promise<PollTeasersResult>;
  /** Injected sleep so tests can run without real timers. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Polls GET /deals/:id/teasers until teasers arrive, the caller cancels, or
 * the timeout elapses. Resolves with the teasers array, or null if polling
 * was cancelled/timed out without ever getting a non-empty result.
 *
 * A fetch error stops polling immediately (non-fatal — the popup just never
 * appears) rather than retrying indefinitely.
 */
export async function pollTeasers(dealId: string, options: PollTeasersOptions): Promise<DealTeaser[] | null> {
  const { intervalMs = 2000, timeoutMs = 40000, isCancelled, fetchTeasers, sleep = defaultSleep } = options;
  const start = Date.now();

  while (!isCancelled() && Date.now() - start < timeoutMs) {
    let result: PollTeasersResult;
    try {
      result = await fetchTeasers(dealId);
    } catch (err) {
      console.warn("[teaserPoll] fetch failed, stopping poll:", err);
      return null;
    }

    if (isCancelled()) return null;
    if (result.teasers && result.teasers.length > 0) return result.teasers;

    if (Date.now() - start >= timeoutMs) return null;
    await sleep(intervalMs);
  }

  return null;
}
