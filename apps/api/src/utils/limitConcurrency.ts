/**
 * limitConcurrency.ts — minimal p-limit-style helper.
 *
 * Why: Phase 3 P1 needs to fan out classifyFinancials() across N Excel
 * sheets without flooding the OpenAI / Anthropic rate limits. The
 * existing financialAgent/concurrency.ts is an org-level slot counter
 * (different concern — it caps how many extractions a single
 * organization can run at once). For per-call fanout we want a
 * per-invocation bound on in-flight promises.
 *
 * Kept dependency-free intentionally — pulling in p-limit just for
 * three concurrent calls would be overkill.
 *
 * Behaviour:
 *   - Preserves input order in the output array (mirrors Promise.all).
 *   - Uses Promise.allSettled internally so a single rejection does
 *     not abort the whole batch; the caller decides how to handle
 *     individual failures.
 *   - When `limit` is ≥ items.length the helper degenerates to a
 *     plain Promise.allSettled (no scheduling overhead).
 */

/**
 * Run `task(item, index)` over `items` with at most `limit` calls
 * in flight at any moment. Returns a settled-result array in the
 * SAME order as `items` (so callers can correlate results back to
 * inputs by index without tracking metadata).
 */
export async function mapWithConcurrencyLimit<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  if (items.length === 0) return [];

  // Defensive: a non-positive limit would deadlock the worker loop
  // below. Coerce to 1 so the call still progresses sequentially.
  const cap = Math.max(1, Math.floor(limit));

  // Fast path: limit ≥ items means no scheduling needed.
  if (cap >= items.length) {
    return Promise.allSettled(items.map((it, i) => task(it, i)));
  }

  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      // Atomic-ish pick: JS is single-threaded so reading + bumping
      // `next` between awaits is safe as long as we don't yield in
      // the middle. This block contains zero awaits.
      const idx = next;
      if (idx >= items.length) return;
      next = idx + 1;

      try {
        const value = await task(items[idx], idx);
        results[idx] = { status: 'fulfilled', value };
      } catch (reason) {
        results[idx] = { status: 'rejected', reason };
      }
    }
  }

  const workers = Array.from({ length: cap }, () => worker());
  await Promise.all(workers);
  return results;
}
