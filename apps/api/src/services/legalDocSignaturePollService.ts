// ACTIVE NDA-signature detection path on Vercel / preview deployments.
//
// Google Drive `files.watch` PUSH notifications only fire to a callback whose
// DOMAIN is verified in GCP / Google Search Console. `*.vercel.app` domains
// cannot be verified, so the push wiring (legalDocSignatureWatchService +
// /api/webhooks/legal-docs) never receives a notification on preview/Vercel.
// That push path is COMMENTED OUT until prod (see
// docs/nda-signature-detection-setup.md). Until then, signature detection runs
// here: ON-DEMAND POLLING triggered by POST /legal-documents/check-signatures.
//
// For every SENT-but-unsigned NDA in the org we re-read the Google Doc metadata
// (via getFileSignatureState, which reuses the SAME readOnly heuristic the push
// path used and does NOT depend on the webhook) and flip the row to SIGNED when
// it looks signed. The heuristic is UNCONFIRMED, so we ALWAYS log the raw Drive
// metadata to let it be validated in production.

import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getProviderAccessToken } from '../integrations/_platform/tokenStore.js';
import { getFileSignatureState } from '../integrations/googleDrive/watch.js';

// Don't re-poll the same Doc against Drive more than once per minute — a user
// hammering the "check" button shouldn't fan out a Drive call per row each time.
const POLL_THROTTLE_MS = 60_000;

interface SentDocRow {
  id: string;
  organizationId: string;
  createdById: string;
  status: string;
  googleDocId: string | null;
  metadata: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Read `metadata.signaturePoll.lastCheckedAt` (ms epoch) without `any`.
 * Returns null when absent or malformed.
 */
function readLastCheckedAt(metadata: unknown): number | null {
  if (!isRecord(metadata)) return null;
  const poll = metadata.signaturePoll;
  if (!isRecord(poll)) return null;
  return typeof poll.lastCheckedAt === 'number' ? poll.lastCheckedAt : null;
}

/**
 * Poll every SENT-but-unsigned NDA in `args.organizationId` against Google Drive
 * and flip any that now look signed to SIGNED. Per-doc failures are isolated so
 * one bad row never aborts the batch.
 */
export async function pollOrgSignatures(args: {
  organizationId: string;
}): Promise<{ checked: number; updated: number; signedDocumentIds: string[] }> {
  const { organizationId } = args;
  const empty = { checked: 0, updated: 0, signedDocumentIds: [] as string[] };

  const { data, error } = await supabase
    .from('LegalDocument')
    .select('id, organizationId, createdById, status, googleDocId, metadata')
    .eq('organizationId', organizationId)
    .eq('status', 'SENT');

  if (error) {
    // Missing table => nothing to poll. Anything else: log and bail with zeros
    // so the route returns a clean (empty) result rather than a 500.
    if (error.code === '42P01' || error.code === 'PGRST205') {
      return empty;
    }
    log.warn('pollOrgSignatures: query failed', {
      organizationId,
      message: error.message,
    });
    return empty;
  }

  const rows = (data ?? []) as SentDocRow[];

  let checked = 0;
  let updated = 0;
  const signedDocumentIds: string[] = [];
  const now = Date.now();

  for (const row of rows) {
    if (!row.googleDocId) continue;

    // Throttle: skip rows polled within POLL_THROTTLE_MS of now.
    const lastCheckedAt = readLastCheckedAt(row.metadata);
    if (lastCheckedAt !== null && now - lastCheckedAt < POLL_THROTTLE_MS) {
      continue;
    }

    checked++;

    try {
      const token = await getProviderAccessToken({
        userId: row.createdById,
        organizationId,
        providerId: 'google_calendar',
      });
      if (!token) {
        log.warn('pollOrgSignatures: no Google Workspace token for sender', {
          documentId: row.id,
          userId: row.createdById,
          organizationId,
        });
        continue;
      }

      const state = await getFileSignatureState(token, row.googleDocId);

      // ALWAYS log the raw Drive metadata so the (unconfirmed) readOnly
      // heuristic can be validated/tuned in production.
      log.info('legalDocSignaturePoll: drive metadata', {
        documentId: row.id,
        signed: state.signed,
        raw: state.raw,
      });

      const nowIso = new Date().toISOString();
      const existingMetadata = isRecord(row.metadata) ? row.metadata : {};
      // Preserve any existing keys (incl. a dormant `signatureWatch` blob) and
      // always bump the poll timestamp.
      const nextMeta: Record<string, unknown> = {
        ...existingMetadata,
        signaturePoll: { lastCheckedAt: Date.now() },
      };

      if (state.signed) {
        nextMeta.signatureDetectedVia = 'drive-poll';
        nextMeta.signatureDetectedAt = nowIso;

        const { error: updateErr } = await supabase
          .from('LegalDocument')
          .update({
            status: 'SIGNED',
            signedAt: nowIso,
            metadata: nextMeta,
            updatedAt: nowIso,
          })
          .eq('id', row.id)
          .eq('organizationId', organizationId);
        if (updateErr) {
          log.warn('pollOrgSignatures: failed to persist SIGNED status', {
            documentId: row.id,
            message: updateErr.message,
          });
          continue;
        }

        updated++;
        signedDocumentIds.push(row.id);
        log.info('pollOrgSignatures: NDA marked SIGNED via drive-poll', {
          documentId: row.id,
          googleDocId: row.googleDocId,
        });
      } else {
        // Not signed — just persist the bumped poll timestamp.
        const { error: updateErr } = await supabase
          .from('LegalDocument')
          .update({ metadata: nextMeta, updatedAt: nowIso })
          .eq('id', row.id)
          .eq('organizationId', organizationId);
        if (updateErr) {
          log.warn('pollOrgSignatures: failed to persist poll timestamp', {
            documentId: row.id,
            message: updateErr.message,
          });
        }
      }
    } catch (err) {
      // One Doc failing (Drive error, revoked token, etc.) must not abort the
      // batch — log and move on to the next row.
      log.warn('pollOrgSignatures: per-document poll failed (non-fatal)', {
        documentId: row.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { checked, updated, signedDocumentIds };
}
