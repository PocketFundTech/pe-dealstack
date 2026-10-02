/**
 * concurrency.ts — Concurrency guard for financial extraction.
 * Limits concurrent extractions per organization to prevent API overload.
 */

const activeExtractions = new Map<string, number>(); // orgId → count
/**
 * How many financial extractions run at once per org (per instance).
 * QA #12: at 2, six documents took three waves (2m44s). Default 4; set
 * EXTRACTION_CONCURRENCY in Vercel (1–8) to tune without a code change —
 * lower it if Anthropic rate-limit (429) errors appear.
 */
export function extractionConcurrency(raw: string | undefined = process.env.EXTRACTION_CONCURRENCY): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? Math.min(8, Math.max(1, n)) : 4;
}
export const MAX_CONCURRENT_PER_ORG = extractionConcurrency();

/**
 * Try to acquire an extraction slot for an organization.
 * Returns true if slot acquired, false if at capacity.
 */
export function acquireExtractionSlot(orgId: string): boolean {
  const current = activeExtractions.get(orgId) ?? 0;
  if (current >= MAX_CONCURRENT_PER_ORG) return false;
  activeExtractions.set(orgId, current + 1);
  return true;
}

/**
 * Release an extraction slot for an organization.
 * Always call this in a finally block.
 */
export function releaseExtractionSlot(orgId: string): void {
  const current = activeExtractions.get(orgId) ?? 0;
  if (current <= 1) {
    activeExtractions.delete(orgId);
  } else {
    activeExtractions.set(orgId, current - 1);
  }
}

/**
 * Get current extraction count for an organization.
 */
export function getActiveCount(orgId: string): number {
  return activeExtractions.get(orgId) ?? 0;
}

/**
 * Wait (polling) for an extraction slot instead of giving up, until
 * `deadline` (epoch ms). Returns true once a slot is held — the caller must
 * release it. Queuing replaces the old "skipped_no_slot" behaviour, which
 * silently dropped most documents of a 15-document "Extract all".
 */
export async function acquireExtractionSlotBy(
  orgId: string,
  deadline: number,
  pollMs = 500,
): Promise<boolean> {
  while (true) {
    if (acquireExtractionSlot(orgId)) return true;
    if (Date.now() + pollMs > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
