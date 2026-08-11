/**
 * Document deduplication helper.
 *
 * Prevents the "user re-uploads the same file" case from creating a second
 * Document row (which would then re-ingest, re-extract, and double Anthropic
 * cost). The dedup key is the (dealId, name, fileSize) triple — we deliberately
 * do NOT use a content hash since we'd have to stream the buffer for that and
 * none of the existing routes have that wired up.
 *
 * Scope: per-deal. Uploading the same file to two different deals is a
 * legitimate user action (same target company, two deal threads) and must not
 * be collapsed.
 *
 * Semantics:
 *   - If a Document with matching (dealId, name, fileSize) exists AND has a
 *     non-null fileUrl, treat it as the duplicate and return it.
 *   - If the existing row has a null fileUrl, it was a failed upload — return
 *     null so the caller proceeds with a fresh insert (and ideally overwrites
 *     the prior row, but that's caller-controlled).
 *
 * Used by every Document-insert site in the ingest / upload routes.
 */
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';

export interface ExistingDocument {
  id: string;
  fileUrl: string | null;
  name: string;
  type: string | null;
  mimeType: string | null;
  fileSize: number | null;
  fileSha256: string | null;
  createdAt: string;
}

export interface FindExistingDocumentOptions {
  /**
   * If true, an existing row with `fileUrl: null` is treated as a failed
   * prior upload — the function returns null so the caller can proceed with
   * a fresh insert. Set this for binary upload routes (PDF / Excel / Word)
   * where fileUrl IS the storage path and a null value means the storage
   * upload step failed before. Leave false for routes that legitimately
   * produce docs without a fileUrl (text paste, URL research, email body).
   *
   * Defaults to false.
   */
  requireFileUrl?: boolean;
}

/**
 * Look for a Document row that matches (dealId, name, fileSize).
 *
 * `fileSize` may legitimately be null (e.g. text / email ingest paths that
 * don't store a size). In that case the query matches rows where fileSize is
 * also null.
 *
 * By default any matching row is returned. Pass `requireFileUrl: true` for
 * binary upload paths where a row with a null fileUrl should be treated as
 * a failed prior upload (and therefore NOT a duplicate).
 */
export async function findExistingDocument(
  dealId: string,
  name: string,
  fileSize: number | null,
  options: FindExistingDocumentOptions = {},
): Promise<ExistingDocument | null> {
  if (!dealId || !name) return null;

  let query = supabase
    .from('Document')
    .select('id, fileUrl, name, type, mimeType, fileSize, fileSha256, createdAt')
    .eq('dealId', dealId)
    .eq('name', name)
    .limit(1);

  if (fileSize === null || fileSize === undefined) {
    query = query.is('fileSize', null);
  } else {
    query = query.eq('fileSize', fileSize);
  }

  const { data: existing, error } = await query.maybeSingle();
  if (error) {
    log.warn('findExistingDocument query failed; treating as not-a-duplicate', {
      dealId,
      name,
      fileSize,
      error: error.message,
    });
    return null;
  }

  if (!existing) return null;

  // For binary upload paths, treat null-fileUrl rows as failed prior uploads.
  if (options.requireFileUrl && !existing.fileUrl) {
    log.info('findExistingDocument: existing row has null fileUrl, treating as not-a-duplicate', {
      dealId,
      docId: existing.id,
      name,
      fileSize,
    });
    return null;
  }

  return existing as ExistingDocument;
}

/**
 * Log a uniform "we skipped a duplicate" line and return the existing row.
 * Centralising this keeps the log shape consistent across every call site so
 * dashboard filters / log searches stay simple.
 */
export function logDuplicateSkip(
  existing: ExistingDocument,
  context: { dealId: string; name: string; fileSize: number | null; newFileUrl?: string | null },
): ExistingDocument {
  log.info('Skipping duplicate Document insert; reusing existing', {
    dealId: context.dealId,
    docId: existing.id,
    name: context.name,
    fileSize: context.fileSize,
  });
  if (context.newFileUrl && context.newFileUrl !== existing.fileUrl) {
    // The new upload already wrote a blob to storage at a different key.
    // We don't delete it here (avoiding accidental data loss); flag it so an
    // orphan-blob sweeper can pick it up later.
    log.info('Duplicate Document: orphan storage blob from re-upload (left in place)', {
      dealId: context.dealId,
      docId: existing.id,
      existingFileUrl: existing.fileUrl,
      orphanFileUrl: context.newFileUrl,
    });
  }
  return existing;
}
