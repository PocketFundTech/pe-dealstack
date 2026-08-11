// Creates a real Google Doc from the LegalDocument HTML using the user's
// Google Workspace token (stored under the `google_calendar` provider —
// scopes were expanded to include drive.file + documents + gmail.send),
// grants the counterparty `writer` access by email, then emails the Doc
// link via Gmail FROM THE USER'S OWN MAILBOX. Persists googleDocId +
// googleDocUrl on the LegalDocument row.
//
// Multi-tenant by construction: each user's NDA email goes out from
// their actual Workspace Gmail address — no firm-wide domain
// verification needed, and recipients see the real sender.
//
// Failure modes the route layer maps onto frontend error codes:
//   * GOOGLE_NOT_CONNECTED  — no Workspace integration for this user  (409)
//   * GOOGLE_SCOPES_MISSING — connected before Drive/Gmail scope was added (409)
//   * NO_RECIPIENT          — neither override email nor row email    (409)
//   * NO_CONTENT            — content null/empty                      (409)
//   * DOCUMENT_NOT_FOUND    — row missing                             (404)
//   * DRIVE_API_ERROR       — Drive call failed (non-auth)            (502)
//   * EMAIL_SEND_FAILED     — Gmail send failed (Gmail's error in details) (502)

import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getProviderAccessToken } from '../integrations/_platform/tokenStore.js';
import {
  createDocFromHtml,
  setDocPermission,
} from '../integrations/googleDrive/client.js';
import { sendMail, getMyProfile } from '../integrations/googleGmail/client.js';
import {
  LegalDocSendError,
  DEFAULT_COVER_HTML,
  buildEmailHtml,
  mapDriveErrorToSendError,
  mapGmailErrorToSendError,
} from './legalDocSendHelpers.js';
import { substituteTokens } from './legalDocSubstituteService.js';
import { placeVisibleSignatureBlock } from './legalDocSignatureBlock.js';
import {
  loadDealForLegalDoc,
  loadOrgForLegalDoc,
  buildLegalDocTokenValues,
} from './legalDocLookups.js';
// (disabled — see banner below)
// import { registerSignatureWatch } from './legalDocSignatureWatchService.js';

// Re-exported from legalDocSendHelpers so the public import surface (routes/
// legal-documents.ts imports LegalDocSendError from here) is unchanged after
// the helper extraction.
export {
  LegalDocSendError,
  type LegalDocSendErrorCode,
} from './legalDocSendHelpers.js';

export interface SendLegalDocumentInput {
  documentId: string;
  organizationId: string;
  userId: string;            // internal User.id — needed to look up the Workspace token
  senderEmailHint?: string;  // optional pre-known sender email (e.g. from JWT)
  toEmail?: string;
  subject?: string;
  message?: string;          // cover message body (HTML, passed through verbatim)
}

export interface SendLegalDocumentResult {
  ok: true;
  alreadySent?: boolean;
  googleDocId: string;
  googleDocUrl: string;
  // `messageId` retained for backwards compat; populated from Gmail's id.
  messageId: string | null;
  gmailMessageId: string | null;
  senderEmail: string | null;
  sentAt: string;
}

interface DocRow {
  id: string;
  organizationId: string;
  dealId: string;
  title: string;
  content: string | null;
  counterpartyName: string | null;
  counterpartyEmail: string | null;
  counterpartyAddress: string | null;
  jurisdiction: string | null;
  effectiveDate: string | null;
  status: string;
  googleDocId: string | null;
  googleDocUrl: string | null;
  sentAt: string | null;
  sentToEmail: string | null;
  metadata: Record<string, unknown> | null;
}

function resolveDealLabel(
  deal: { name: string | null; company: { name: string | null } | null } | null,
  fallbackTitle: string,
): string {
  if (!deal) return fallbackTitle;
  return deal.name ?? deal.company?.name ?? fallbackTitle;
}

async function loadDocument(id: string, orgId: string): Promise<DocRow> {
  const { data, error } = await supabase
    .from('LegalDocument')
    .select(
      'id, organizationId, dealId, title, content, counterpartyName, counterpartyEmail, counterpartyAddress, jurisdiction, effectiveDate, status, googleDocId, googleDocUrl, sentAt, sentToEmail, metadata',
    )
    .eq('id', id)
    .eq('organizationId', orgId)
    .maybeSingle();
  if (error) {
    throw new LegalDocSendError('DOCUMENT_NOT_FOUND', 'Failed to load document', 502, error.message);
  }
  if (!data) {
    throw new LegalDocSendError('DOCUMENT_NOT_FOUND', 'Legal document not found', 404);
  }
  return data as DocRow;
}

// metadata.source value written by legalDocImportGdocService for a "bring your
// own Google Doc" import. Kept in sync with IMPORTED_GDOC_SOURCE there; an
// imported doc reuses its existing googleDocId instead of creating a new Doc.
const IMPORTED_GDOC_SOURCE = 'imported-gdoc';

interface ShareAndEmailArgs {
  doc: DocRow;
  organizationId: string;
  accessToken: string;
  recipient: string;
  dealLabel: string;
  senderEmailHint?: string;
  subject?: string;
  message?: string;
  // The Doc the counterparty edits + the link we email. For a composed NDA
  // this is the just-created Doc; for an imported one it's the user's own Doc.
  googleDocId: string;
  googleDocUrl: string;
  // Substituted HTML to snapshot, or null for an imported doc (no in-app HTML
  // exists, so there is nothing to snapshot and we must not touch the column).
  contentSnapshot: string | null;
  // When true, persist googleDocId/googleDocUrl on the row (composed path,
  // where the Doc was just created). Imported docs already have these saved
  // at import time, so we leave them untouched.
  persistDocIds: boolean;
}

/**
 * Shared "share + resolve sender + email + persist" tail used by both the
 * composed-NDA and imported-Google-Doc send paths. Grants the recipient
 * writer access, resolves the sender mailbox, emails the Doc link via Gmail,
 * then flips the row to SENT. Keeps sendLegalDocument under the 500-line cap.
 */
async function shareResolveEmailAndPersist(
  args: ShareAndEmailArgs,
): Promise<{ gmailMessageId: string | null; senderEmail: string | null; sentAt: string }> {
  const {
    doc,
    organizationId,
    accessToken,
    recipient,
    dealLabel,
    googleDocId,
    googleDocUrl,
    contentSnapshot,
    persistDocIds,
  } = args;

  // ── Grant the counterparty writer access ────────────────────────────
  try {
    await setDocPermission(accessToken, googleDocId, recipient, 'writer');
  } catch (err) {
    log.error('legalDocSendService: setDocPermission failed', err, {
      documentId: doc.id,
      googleDocId,
    });
    throw mapDriveErrorToSendError(err, 'permission');
  }

  // ── Resolve sender's mailbox address ────────────────────────────────
  // Prefer the JWT-supplied email (free); only round-trip to Gmail's
  // profile endpoint if it's missing.
  let senderEmail: string | null = args.senderEmailHint?.trim() || null;
  if (!senderEmail) {
    try {
      const profile = await getMyProfile(accessToken);
      senderEmail = profile.emailAddress;
    } catch (err) {
      // Profile fetch is best-effort — log and continue so a transient
      // failure here doesn't block the send.
      log.warn('legalDocSendService: getMyProfile failed (continuing)', {
        documentId: doc.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Email the Doc link via Gmail (from the user's own mailbox) ──────
  // `From:` is set by Gmail automatically to the authenticated user.
  // `Reply-To:` is omitted — replies naturally go to From, which is
  // already the sender's address.
  const subject = args.subject?.trim() || `${dealLabel} — NDA`;
  const coverHtml = (args.message && args.message.trim()) || DEFAULT_COVER_HTML;
  const html = buildEmailHtml(coverHtml, googleDocUrl);

  let gmailMessageId: string | null = null;
  try {
    const sent = await sendMail(accessToken, { to: recipient, subject, html });
    gmailMessageId = sent.id;
    log.info('legalDocSendService: gmail send ok', {
      documentId: doc.id,
      googleDocId,
      gmailMessageId,
      senderEmail,
    });
  } catch (err) {
    log.error('legalDocSendService: gmail send failed', err, {
      documentId: doc.id,
      googleDocId,
    });
    throw mapGmailErrorToSendError(err);
  }

  // ── Persist final state ─────────────────────────────────────────────
  const sentAt = new Date().toISOString();
  const update: Record<string, unknown> = {
    status: 'SENT',
    sentAt,
    sentToEmail: recipient,
    updatedAt: sentAt,
  };
  if (persistDocIds) {
    // Snapshot the SUBSTITUTED output (what we actually pushed to the
    // Google Doc), not the raw editable draft. This is the wording the
    // counterparty sees — any later "view sent snapshot" must reflect
    // that exact text, including the resolved token values. Imported docs
    // have no in-app HTML, so contentSnapshot stays null + we skip both.
    update.contentSnapshot = contentSnapshot;
    update.googleDocId = googleDocId;
    update.googleDocUrl = googleDocUrl;
  }
  const { error: updateErr } = await supabase
    .from('LegalDocument')
    .update(update)
    .eq('id', doc.id)
    .eq('organizationId', organizationId);
  if (updateErr) {
    // The Doc was shared + the email went out — log loudly but don't
    // throw. Next list-fetch will resolve eventual consistency.
    log.error('legalDocSendService: failed to update status after send', updateErr, {
      documentId: doc.id,
      googleDocId,
      gmailMessageId,
    });
  }

  return { gmailMessageId, senderEmail, sentAt };
}

export async function sendLegalDocument(
  input: SendLegalDocumentInput,
): Promise<SendLegalDocumentResult> {
  // ── Load + validate inputs ──────────────────────────────────────────
  const doc = await loadDocument(input.documentId, input.organizationId);

  // Idempotency: if already sent AND we have a googleDocId, return it.
  if (doc.status === 'SENT' && doc.googleDocId && doc.googleDocUrl) {
    return {
      ok: true,
      alreadySent: true,
      googleDocId: doc.googleDocId,
      googleDocUrl: doc.googleDocUrl,
      messageId: null,
      gmailMessageId: null,
      senderEmail: input.senderEmailHint ?? null,
      sentAt: doc.sentAt ?? new Date().toISOString(),
    };
  }

  // Imported-Google-Doc rows have NO in-app HTML — they reuse a Doc the user
  // already prepared in their own Drive (metadata.source === 'imported-gdoc',
  // written by legalDocImportGdocService). For those we skip the NO_CONTENT
  // check + the createDocFromHtml call entirely and reuse the saved Doc.
  const isImportedGdoc =
    !!doc.googleDocId &&
    (doc.metadata as { source?: string } | null)?.source === IMPORTED_GDOC_SOURCE;

  if (!isImportedGdoc && (!doc.content || !doc.content.trim())) {
    throw new LegalDocSendError(
      'NO_CONTENT',
      'Document has no HTML content to send',
      409,
    );
  }
  const recipient = (input.toEmail ?? doc.counterpartyEmail ?? '').trim();
  if (!recipient) {
    throw new LegalDocSendError(
      'NO_RECIPIENT',
      'No recipient email — set counterpartyEmail or pass toEmail',
      409,
    );
  }

  // ── Resolve the user's Google Workspace access token ────────────────
  // Provider id stays `google_calendar` (display name was relabeled to
  // "Google Workspace" — the id is the storage key).
  const accessToken = await getProviderAccessToken({
    userId: input.userId,
    organizationId: input.organizationId,
    providerId: 'google_calendar',
  });
  if (!accessToken) {
    throw new LegalDocSendError(
      'GOOGLE_NOT_CONNECTED',
      'Google Workspace is not connected for this user — open Settings → Integrations',
      409,
    );
  }

  const deal = await loadDealForLegalDoc(doc.dealId, input.organizationId);
  const org = await loadOrgForLegalDoc(input.organizationId);
  const dealLabel = resolveDealLabel(deal, doc.title);

  // ── Imported-Google-Doc path ────────────────────────────────────────
  // Reuse the user's own Doc (already saved on the row at import time). No
  // HTML, no createDocFromHtml, no token substitution, no snapshot — just
  // share + email + flip to SENT via the shared tail.
  if (isImportedGdoc) {
    const googleDocId = doc.googleDocId as string;
    const googleDocUrl = (doc.googleDocUrl ?? '') || googleDocId;
    const tail = await shareResolveEmailAndPersist({
      doc,
      organizationId: input.organizationId,
      accessToken,
      recipient,
      dealLabel,
      senderEmailHint: input.senderEmailHint,
      subject: input.subject,
      message: input.message,
      googleDocId,
      googleDocUrl,
      contentSnapshot: null,
      persistDocIds: false,
    });
    return {
      ok: true,
      googleDocId,
      googleDocUrl,
      messageId: tail.gmailMessageId,
      gmailMessageId: tail.gmailMessageId,
      senderEmail: tail.senderEmail,
      sentAt: tail.sentAt,
    };
  }

  // ── Two-stage token substitution ────────────────────────────────────
  // Tokens are also substituted at CREATE time (see
  // routes/legal-documents.ts POST handler) against the create-form
  // values. We re-substitute here against the LIVE LegalDocument row +
  // current deal/org metadata so that:
  //   (a) tokens the user typed into the editor AFTER create
  //       (e.g. they hand-inserted "[COUNTERPARTY_NAME]" themselves)
  //       get replaced.
  //   (b) tokens whose values were blank at create time but filled in
  //       later via PATCH (e.g. counterparty email was unknown initially)
  //       get the current value.
  //   (c) TODAY always reflects the send date, not the create date.
  // The live `content` column is left untouched — the user keeps their
  // tokens visible in the editor for repeated sends. Only the snapshot
  // + the Google Doc body see the substituted output.
  const tokenValues = buildLegalDocTokenValues(doc, deal, org);
  // `doc.content` is guaranteed non-null here — the NO_CONTENT check above
  // only skips for the imported path, which already returned. A
  // [SIGNATURE_BLOCK] marker (if the user placed one) becomes a visible
  // signature line in the hand-signed Google Doc.
  const substitutedContent = placeVisibleSignatureBlock(
    substituteTokens(doc.content as string, tokenValues),
  );

  // ── Create the Google Doc ───────────────────────────────────────────
  let createdDoc: { id: string; webViewLink: string };
  try {
    createdDoc = await createDocFromHtml(accessToken, doc.title, substitutedContent);
  } catch (err) {
    log.error('legalDocSendService: createDocFromHtml failed', err, {
      documentId: doc.id,
    });
    throw mapDriveErrorToSendError(err, 'create');
  }

  // ── Share + resolve sender + email + persist (shared tail) ──────────
  const tail = await shareResolveEmailAndPersist({
    doc,
    organizationId: input.organizationId,
    accessToken,
    recipient,
    dealLabel,
    senderEmailHint: input.senderEmailHint,
    subject: input.subject,
    message: input.message,
    googleDocId: createdDoc.id,
    googleDocUrl: createdDoc.webViewLink,
    contentSnapshot: substitutedContent,
    persistDocIds: true,
  });

  // ─── DISABLED UNTIL PROD (Drive push signature detection) ───────────────
  // files.watch push needs a GCP-domain-verified HTTPS callback; *.vercel.app
  // cannot be verified, so push never fires on preview/Vercel. Active detection
  // now runs via on-demand polling (legalDocSignaturePollService +
  // POST /legal-documents/check-signatures). RE-ENABLE before prod — see
  // docs/nda-signature-detection-setup.md "Enabling push in production".
  // ────────────────────────────────────────────────────────────────────────
  // Register a Drive watch so we can auto-detect when the counterparty signs.
  // Best-effort: registerSignatureWatch reloads the row itself (so it sees the
  // just-saved googleDocId) and never throws — it must not affect the send.
  // try {
  //   await registerSignatureWatch({ documentId: doc.id, userId: input.userId, organizationId: input.organizationId });
  // } catch (watchErr) {
  //   log.warn('legalDocSendService: registerSignatureWatch failed (non-fatal)', {
  //     documentId: doc.id,
  //     message: watchErr instanceof Error ? watchErr.message : String(watchErr),
  //   });
  // }

  return {
    ok: true,
    googleDocId: createdDoc.id,
    googleDocUrl: createdDoc.webViewLink,
    messageId: tail.gmailMessageId,
    gmailMessageId: tail.gmailMessageId,
    senderEmail: tail.senderEmail,
    sentAt: tail.sentAt,
  };
}
