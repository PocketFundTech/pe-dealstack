import { supabase } from '../../supabase.js';
import { log } from '../../utils/logger.js';
import { addFileToDeal } from '../documentStore.js';
import { getExpectedMimeType, FILE_SIZE_LIMITS } from '../fileValidator.js';
import { HubSpotScopeError, type HubSpotClient } from './client.js';
import type { ImportCounters } from './types.js';

// Files attached to deals. The engagement phases enqueue (deal, file) pairs;
// the final `files` phase drains the queue a few files at a time so a slow
// download can't stall the CRM import or overrun the serverless time limit.

export const MIGRATION_PENDING_NOTE =
  'files: not imported — database migration pending (apps/api/hubspot-relationships-files-migration.sql).';

/** Count `n` skipped records with `reason` (skips also count as processed). */
export function skipWithReason(c: ImportCounters, reason: string, n = 1): void {
  if (n <= 0) return;
  c.skipped += n;
  c.processed += n;
  c.reasons = { ...(c.reasons ?? {}), [reason]: (c.reasons?.[reason] ?? 0) + n };
}

/** Append notes to the job's message (" | "-separated), never twice. */
export function mergeNotes(existing: string | null, notes: string[]): string | null {
  const parts = existing ? existing.split(' | ') : [];
  for (const n of notes) if (!parts.includes(n)) parts.push(n);
  return parts.length ? parts.join(' | ') : null;
}

/** Queue each (deal, file) pair. Returns false (never throws) if the queue can't be written. */
export async function enqueueAttachments(input: {
  jobId: string; orgId: string; dealIds: string[]; fileIds: string[]; engagementId: string;
}): Promise<boolean> {
  const rows = input.dealIds.flatMap((dealId) => input.fileIds.map((hubspotFileId) => ({
    jobId: input.jobId, organizationId: input.orgId, dealId, hubspotFileId, sourceEngagementId: input.engagementId,
  })));
  if (rows.length === 0) return true;
  const { error } = await supabase
    .from('HubSpotFileQueue')
    .upsert(rows, { onConflict: 'jobId,dealId,hubspotFileId', ignoreDuplicates: true });
  if (error) {
    log.warn(`[hubspot] could not queue attachments for engagement ${input.engagementId}: ${(error as { message?: string }).message}`);
    return false;
  }
  return true;
}

type FileClient = Pick<HubSpotClient, 'getFileMeta' | 'getFileSignedUrl' | 'downloadSignedUrl'>;
type FileOutcome = { status: 'done'; documentId: string; created: boolean } | { status: 'skipped'; reason: string };

async function importOneFile(
  client: FileClient, row: { dealId: string; hubspotFileId: string }, uploadedBy: string | null,
): Promise<FileOutcome> {
  const meta = await client.getFileMeta(row.hubspotFileId);
  if (!meta) return { status: 'skipped', reason: 'not_found' };
  const ext = meta.extension?.toLowerCase() ?? null;
  const filename = ext && !meta.name.toLowerCase().endsWith(`.${ext}`) ? `${meta.name}.${ext}` : meta.name;
  const mimeType = getExpectedMimeType(filename);
  if (!mimeType) return { status: 'skipped', reason: 'unsupported_type' };
  const limit = FILE_SIZE_LIMITS[mimeType] ?? FILE_SIZE_LIMITS.default;
  if (meta.size != null && meta.size > limit) return { status: 'skipped', reason: 'too_large' };

  const url = await client.getFileSignedUrl(row.hubspotFileId);
  const buffer = await client.downloadSignedUrl(url);
  if (buffer.length > limit) return { status: 'skipped', reason: 'too_large' };

  const res = await addFileToDeal({
    dealId: row.dealId, filename, buffer, mimeType, uploadedBy, hubspotFileId: row.hubspotFileId,
  });
  if (res.outcome === 'rejected') return { status: 'skipped', reason: 'invalid_file' };
  return { status: 'done', documentId: res.documentId, created: res.outcome === 'created' };
}

async function markRow(id: string, status: 'done' | 'skipped' | 'failed', reason: string | null, documentId: string | null) {
  await supabase.from('HubSpotFileQueue').update({ status, reason, documentId }).eq('id', id);
}

function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 160 ? `${msg.slice(0, 157)}…` : msg;
}

/**
 * Import up to `maxFiles` queued files, stopping early at `budgetMs`.
 * `done` = nothing left for this job; `note` = a message for the job (or null).
 */
export async function drainFileQueue(opts: {
  jobId: string; orgId: string; client: FileClient; uploadedBy: string | null; counts: ImportCounters;
  budgetMs?: number; maxFiles?: number; now?: () => number;
}): Promise<{ done: boolean; note: string | null }> {
  const { jobId, client, uploadedBy, counts } = opts;
  const budgetMs = opts.budgetMs ?? 60_000;
  const maxFiles = opts.maxFiles ?? 10;
  const now = opts.now ?? Date.now;
  const started = now();

  if (counts.total === undefined || counts.total === null) {
    const { count, error } = await supabase
      .from('HubSpotFileQueue').select('id', { count: 'exact', head: true }).eq('jobId', jobId);
    if (error) return { done: true, note: MIGRATION_PENDING_NOTE };
    // Already processed here = attachments skipped (no deal) or failed to queue.
    counts.total = (count ?? 0) + counts.processed;
  }

  const { data: rows, error } = await supabase
    .from('HubSpotFileQueue').select('id, dealId, hubspotFileId')
    .eq('jobId', jobId).eq('status', 'pending')
    .order('createdAt', { ascending: true }).limit(maxFiles);
  if (error) return { done: true, note: MIGRATION_PENDING_NOTE };
  const pending = (rows ?? []) as Array<{ id: string; dealId: string; hubspotFileId: string }>;
  if (pending.length === 0) return { done: true, note: null };

  for (const row of pending) {
    if (now() - started >= budgetMs) return { done: false, note: null };
    try {
      const out = await importOneFile(client, row, uploadedBy);
      if (out.status === 'done') {
        await markRow(row.id, 'done', null, out.documentId);
        if (out.created) counts.created += 1; else counts.updated += 1;
        counts.processed += 1;
      } else {
        await markRow(row.id, 'skipped', out.reason, null);
        skipWithReason(counts, out.reason);
      }
    } catch (err) {
      if (err instanceof HubSpotScopeError) {
        const { count } = await supabase
          .from('HubSpotFileQueue').update({ status: 'skipped', reason: 'missing_scope' }, { count: 'exact' })
          .eq('jobId', jobId).eq('status', 'pending');
        skipWithReason(counts, 'missing_scope', count ?? 0);
        return {
          done: true,
          note: `files: skipped — your HubSpot token is missing the ${err.scopes} scopes. Add them to the Private App, then run the import again.`,
        };
      }
      log.warn(`[hubspot] file ${row.hubspotFileId} for deal ${row.dealId} failed: ${shortError(err)}`);
      await markRow(row.id, 'failed', shortError(err), null);
      counts.failed += 1;
      counts.processed += 1;
    }
  }
  return { done: false, note: null };
}
