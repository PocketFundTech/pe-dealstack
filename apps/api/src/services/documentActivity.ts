/**
 * Deal-timeline Activity rows for document downloads (QA #19).
 *
 * Downloads were written only to AuditLog (admin activity feed), but the
 * deal's activity timeline reads the Activity table, so a download never
 * showed there. Portal (share-link) downloads were not logged anywhere.
 *
 * Awaited by callers (Vercel can freeze the function once the response is
 * sent) but never throws — a logging failure must not fail the download.
 */

import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';

export async function recordDocumentDownload(params: {
  dealId: string | null | undefined;
  documentId: string;
  documentName: string | null | undefined;
  /** Who downloaded: a user's email, or a share label for portal downloads. */
  by: string;
  via: 'app' | 'share_link';
  watermarked?: boolean;
}): Promise<void> {
  if (!params.dealId) return; // org-level docs have no deal timeline
  const name = params.documentName ?? 'document';
  try {
    const { error } = await supabase.from('Activity').insert({
      dealId: params.dealId,
      type: 'DOCUMENT_DOWNLOADED',
      title: `Document downloaded: ${name}`,
      description: params.via === 'share_link' ? `Downloaded via share link (${params.by})` : `Downloaded by ${params.by}`,
      metadata: { documentId: params.documentId, via: params.via, by: params.by, watermarked: params.watermarked ?? null },
    });
    if (error) log.warn('recordDocumentDownload: Activity insert failed', { documentId: params.documentId, error: error.message });
  } catch (err) {
    log.warn('recordDocumentDownload: unexpected error', { documentId: params.documentId, err: err instanceof Error ? err.message : String(err) });
  }
}
