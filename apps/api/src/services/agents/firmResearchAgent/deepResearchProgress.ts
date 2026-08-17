// ─── Deep research — progress persistence ────────────────────────
// Writes the current Phase 2 progress to Organization.settings.deepResearch
// so the UI can poll status while the long-running task is in flight.
//
// Also exports `markStaleDeepResearchAsFailed`, used by the status-read
// endpoint to self-heal jobs that were killed mid-flight by the Vercel
// serverless function timeout (the agent can run for minutes but the HTTP
// function is killed after ~30s — if the task dies before reaching the
// 'complete' or 'failed' transition, the status stays 'running' forever).

import { supabase } from '../../../supabase.js';
import { log } from '../../../utils/logger.js';

export interface DeepResearchProgress {
  status: 'running' | 'complete' | 'failed';
  startedAt: string;
  completedAt?: string;
  failedAt?: string;
  queriesRun: number;
  insightsFound: number;
  error?: string;
}

// 5 minutes — comfortably longer than the agent's 120s Phase 2 timeout, so we
// never mark a legitimately running job as stale, but short enough that users
// don't wait forever after a serverless function dies.
export const STALE_THRESHOLD_MS = 5 * 60 * 1000;

export async function updateProgress(orgId: string, progress: DeepResearchProgress): Promise<void> {
  if (!orgId) return;
  try {
    const { data: org } = await supabase
      .from('Organization')
      .select('settings')
      .eq('id', orgId)
      .single();
    const settings = (org?.settings || {}) as Record<string, any>;
    settings.deepResearch = progress;
    await supabase.from('Organization').update({ settings }).eq('id', orgId);
  } catch (error) {
    log.warn('Deep research: failed to update progress', { error: (error as Error).message });
  }
}

/**
 * If `settings.deepResearch.status === 'running'` and `startedAt` is older
 * than STALE_THRESHOLD_MS (or missing — legacy data), flip the status to
 * 'failed' and persist the change back to the Organization row. Returns the
 * (possibly mutated) deepResearch object, or `null` if there is none.
 *
 * Legacy-data policy: a row with `status: 'running'` but no `startedAt` can
 * only have come from old code that no longer exists, so the only safe
 * assumption is that the job is already dead. We mark it as stale so the
 * frontend stops polling and the user can retry.
 */
export async function markStaleDeepResearchAsFailed(
  orgId: string,
  settings: Record<string, any>,
): Promise<DeepResearchProgress | null> {
  const dr = settings?.deepResearch as DeepResearchProgress | undefined;
  if (!dr) return null;
  if (dr.status !== 'running') return dr;

  let isStale = false;
  let reason = 'Background research timed out (likely killed by serverless function timeout)';

  if (!dr.startedAt) {
    isStale = true;
    reason = 'Background research timed out (unknown start time — legacy record)';
  } else {
    const age = Date.now() - new Date(dr.startedAt).getTime();
    if (Number.isNaN(age) || age > STALE_THRESHOLD_MS) {
      isStale = true;
    }
  }

  if (!isStale) return dr;

  const updated: DeepResearchProgress = {
    ...dr,
    status: 'failed',
    error: dr.error || reason,
    failedAt: new Date().toISOString(),
  };

  try {
    const nextSettings = { ...settings, deepResearch: updated };
    await supabase.from('Organization').update({ settings: nextSettings }).eq('id', orgId);
    log.warn('Deep research: marked stale running job as failed', {
      orgId,
      startedAt: dr.startedAt,
      queriesRun: dr.queriesRun,
    });
  } catch (error) {
    // Persistence failure is non-fatal — we still return the derived 'failed'
    // status so the current request stops polling. The next status-read will
    // re-derive and try again.
    log.warn('Deep research: failed to persist stale->failed transition', {
      error: (error as Error).message,
    });
  }

  return updated;
}
