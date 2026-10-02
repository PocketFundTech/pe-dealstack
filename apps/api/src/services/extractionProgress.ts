/**
 * Per-document progress for multi-document "Extract all" (QA #12).
 *
 * Stored on Document."financialExtraction" (document-extraction-status-
 * migration.sql) so a poll answered by ANY serverless instance sees it.
 * Best-effort everywhere: progress must never fail or slow an extraction.
 * Before the migration runs, writes are skipped after the first
 * "column does not exist" and the progress endpoint reports unavailable.
 */

import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';

export type DocExtractionStatus = 'queued' | 'running' | 'done' | 'failed' | 'pending';

export interface DocExtractionState {
  runId: string;
  status: DocExtractionStatus;
  updatedAt: string;
  periodsStored?: number;
  error?: string;
}

let columnMissing = false;
const isMissingColumn = (e: { code?: string } | null) => !!e && (e.code === '42703' || e.code === 'PGRST204');

/** Test hook. */
export function resetExtractionProgressProbe(): void {
  columnMissing = false;
}

export async function setDocExtraction(
  documentIds: string[],
  runId: string | undefined,
  status: DocExtractionStatus,
  extra: { periodsStored?: number; error?: string } = {},
): Promise<void> {
  if (!runId || columnMissing || documentIds.length === 0) return;
  const value: DocExtractionState = { runId, status, updatedAt: new Date().toISOString(), ...extra };
  try {
    const { error } = await supabase.from('Document').update({ financialExtraction: value }).in('id', documentIds);
    if (isMissingColumn(error)) {
      columnMissing = true;
      log.warn('Document.financialExtraction missing — run document-extraction-status-migration.sql for live progress');
    } else if (error) {
      log.warn('extraction progress write failed', { error: error.message });
    }
  } catch (err) {
    log.warn('extraction progress write threw', { err: err instanceof Error ? err.message : String(err) });
  }
}

export interface RunProgress {
  available: boolean;
  total: number;
  done: number;
  running: string[];
  docs: { id: string; name: string | null; status: DocExtractionStatus }[];
}

/** Progress of one run for a deal's documents (only rows stamped with this runId). */
export async function getRunProgress(dealId: string, runId: string): Promise<RunProgress> {
  const { data, error } = await supabase
    .from('Document')
    .select('id, name, financialExtraction')
    .eq('dealId', dealId);
  if (error) return { available: false, total: 0, done: 0, running: [], docs: [] };
  const docs = (data ?? [])
    .map((d: { id: string; name: string | null; financialExtraction?: DocExtractionState | null }) => ({ id: d.id, name: d.name, state: d.financialExtraction }))
    .filter((d) => d.state?.runId === runId)
    .map((d) => ({ id: d.id, name: d.name, status: d.state!.status }));
  return {
    available: true,
    total: docs.length,
    done: docs.filter((d) => d.status === 'done' || d.status === 'failed').length,
    running: docs.filter((d) => d.status === 'running').map((d) => d.name ?? 'document'),
    docs,
  };
}
