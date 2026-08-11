// Save Outlook email file-attachments into a deal's Documents (Data Room).
// Outlook-only; reuses the shared Storage bucket + Document table + dedup helper
// (nothing from the Gmail integration). v1 stores the file only — financial
// extraction stays a one-click action via the existing "Extract Financials".

import { supabase } from '../../supabase.js';
import { log } from '../../utils/logger.js';
import { findExistingDocument } from '../../services/documentDedup.js';
import type { GraphFileAttachment } from './types.js';

// Graph returns attachment bytes inline (base64). Cap the size we'll pull into
// memory on a serverless function; larger files are skipped (logged) for now.
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10MB

function docTypeForFile(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'PDF';
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.csv')) return 'EXCEL';
  if (lower.endsWith('.doc') || lower.endsWith('.docx')) return 'DOC';
  return 'OTHER';
}

// Sanitise for use in a storage object key.
function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 200);
}

/**
 * Upload each file attachment to the deal's Documents. Best-effort and
 * idempotent: deduped by (dealId, name, size) so re-syncs don't duplicate, and
 * a single failure is logged without aborting the rest. Returns how many were
 * newly stored.
 */
export async function uploadEmailAttachmentsToDeal(params: {
  organizationId: string;
  dealId: string;
  userId: string | null;
  attachments: GraphFileAttachment[];
}): Promise<number> {
  const { dealId, userId, attachments } = params;
  let stored = 0;

  for (const att of attachments) {
    const name = att.name?.trim();
    try {
      if (!name || !att.contentBytes) continue;
      const size = att.size ?? 0;
      if (size > MAX_ATTACHMENT_BYTES) {
        log.warn('outlook: attachment too large, skipping', { dealId, name, size });
        continue;
      }

      // Dedup — same file already on this deal?
      const existing = await findExistingDocument(dealId, name, size || null);
      if (existing) continue;

      const buffer = Buffer.from(att.contentBytes, 'base64');
      const filePath = `${dealId}/${Date.now()}_${safeName(name)}`;
      const contentType = att.contentType || 'application/octet-stream';

      const { error: uploadErr } = await supabase.storage
        .from('documents')
        .upload(filePath, buffer, { contentType, upsert: false });
      // If storage fails (e.g. bucket misconfig) we still record the Document
      // row without a fileUrl rather than losing the reference — matches the
      // manual-upload route's graceful degradation.
      const fileUrl = uploadErr ? null : filePath;
      if (uploadErr) {
        log.warn('outlook: attachment storage upload failed', { dealId, name, err: uploadErr.message });
      }

      const { error: docErr } = await supabase.from('Document').insert({
        dealId,
        uploadedBy: userId,
        name,
        type: docTypeForFile(name),
        fileUrl,
        fileSize: size || buffer.byteLength,
        mimeType: att.contentType ?? null,
        status: 'completed',
      });
      if (docErr) {
        log.warn('outlook: attachment Document insert failed', { dealId, name, err: docErr.message });
        continue;
      }
      stored++;
    } catch (err) {
      log.warn('outlook: attachment upload threw (continuing)', {
        dealId, name, err: (err as Error).message,
      });
    }
  }

  return stored;
}
