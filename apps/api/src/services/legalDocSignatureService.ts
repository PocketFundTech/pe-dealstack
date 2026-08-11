// Google Workspace eSignature integration — DEEP-LINK approach.
//
// As of late 2025 / early 2026, Google's eSignature feature (Workspace
// Business Standard+ / Enterprise / Individual) is a UI-only product:
//
//   * The Drive v3 REST API has NO signature-related endpoints
//     (verified against the published REST reference — no
//     `signatureRequests` resource, no `requestSignature` method).
//   * The Docs API `batchUpdate` does NOT expose a
//     `createSignatureField` request type.
//   * Issue Tracker #239527000 ("Provide an API for Google Docs
//     eSignatures") has been open for years with no API delivery.
//   * Google's marketplace pushes third-party signers (DocuSign,
//     SignRequest, Sign.Plus) for any programmatic flow.
//
// What we CAN do is land the user in the Google Doc itself; the
// eSignature panel is one click away (Tools -> eSignature). The Doc
// already exists from the original `sendLegalDocument` call, so we
// just hand back the webViewLink + persist `metadata.signatureRequestedAt`
// so the row knows the user kicked off the flow.
//
// When Google ships an API for this (the issue tracker is still open),
// swap the body of `requestLegalDocSignature` for a real Drive call and
// promote the response shape from `{ deeplinkUrl }` to `{ signatureRequestId,
// signatureUrl }` — the route + frontend already accept both via optional
// fields.
//
// Failure modes mapped onto the existing legal-doc error pattern:
//   * GOOGLE_NOT_CONNECTED  — user has no Workspace integration   (409)
//   * NOT_SENT              — doc is DRAFT, no Google Doc to sign (409)
//   * DOCUMENT_NOT_FOUND    — row missing                         (404)
//   * NO_GOOGLE_DOC         — SENT row missing googleDocUrl       (409)
//   * ESIGNATURE_API_ERROR  — upstream (reserved for the eventual
//                             programmatic path)                  (502)

import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getProviderAccessToken } from '../integrations/_platform/tokenStore.js';
import { isWorkspaceAccount } from '../integrations/googleCalendar/client.js';

export type LegalDocSignatureErrorCode =
  | 'GOOGLE_NOT_CONNECTED'
  | 'GOOGLE_SCOPES_MISSING'
  | 'WORKSPACE_REQUIRED'
  | 'NOT_SENT'
  | 'NO_GOOGLE_DOC'
  | 'DOCUMENT_NOT_FOUND'
  | 'ESIGNATURE_API_ERROR';

export class LegalDocSignatureError extends Error {
  code: LegalDocSignatureErrorCode;
  status: number;
  details?: string;
  constructor(
    code: LegalDocSignatureErrorCode,
    message: string,
    status: number,
    details?: string,
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface RequestSignatureInput {
  documentId: string;
  organizationId: string;
  userId: string;
}

export interface RequestSignatureResult {
  ok: true;
  // Deep-link to land the user inside the Google Doc; they then open
  // Tools -> eSignature in the UI. When/if Google ships a programmatic
  // signature API, this field becomes the signer-facing URL (e.g. the
  // signature request landing page) and we add a `signatureRequestId`.
  deeplinkUrl: string;
  // ISO timestamp persisted on the row's metadata so the UI can show
  // "Signature requested at …" provenance.
  signatureRequestedAt: string;
  // Reserved for the future programmatic path — null today.
  signatureRequestId: string | null;
}

interface DocRow {
  id: string;
  organizationId: string;
  status: string;
  googleDocId: string | null;
  googleDocUrl: string | null;
  metadata: Record<string, unknown> | null;
}

async function loadDocument(id: string, orgId: string): Promise<DocRow> {
  const { data, error } = await supabase
    .from('LegalDocument')
    .select('id, organizationId, status, googleDocId, googleDocUrl, metadata')
    .eq('id', id)
    .eq('organizationId', orgId)
    .maybeSingle();
  if (error) {
    throw new LegalDocSignatureError(
      'DOCUMENT_NOT_FOUND',
      'Failed to load document',
      502,
      error.message,
    );
  }
  if (!data) {
    throw new LegalDocSignatureError(
      'DOCUMENT_NOT_FOUND',
      'Legal document not found',
      404,
    );
  }
  return data as DocRow;
}

/**
 * Initiates an eSignature flow on a SENT legal document. Today this is a
 * deep-link to the Google Doc itself — the user opens Tools -> eSignature
 * in the Google Docs UI to add signer fields and send. The service-layer
 * shape is forward-compatible with the future programmatic API: callers
 * receive `{ deeplinkUrl, signatureRequestId: null }` today and will get
 * `{ deeplinkUrl, signatureRequestId: '…' }` once Google ships the API.
 */
export async function requestLegalDocSignature(
  input: RequestSignatureInput,
): Promise<RequestSignatureResult> {
  const doc = await loadDocument(input.documentId, input.organizationId);

  if (doc.status !== 'SENT') {
    throw new LegalDocSignatureError(
      'NOT_SENT',
      'Signature can only be requested on a sent NDA — send the document first',
      409,
    );
  }
  if (!doc.googleDocId || !doc.googleDocUrl) {
    throw new LegalDocSignatureError(
      'NO_GOOGLE_DOC',
      'No Google Doc attached to this legal document — re-send to create one',
      409,
    );
  }

  // Confirm the user is still connected to Workspace before sending them
  // off-site. The Drive Doc was created against their token, so the same
  // token will let them open it — but if they've since disconnected, we
  // want to surface the error here rather than have Google's login wall
  // greet them after the click.
  const accessToken = await getProviderAccessToken({
    userId: input.userId,
    organizationId: input.organizationId,
    providerId: 'google_calendar',
  });
  if (!accessToken) {
    throw new LegalDocSignatureError(
      'GOOGLE_NOT_CONNECTED',
      'Google is not connected for this user — open Settings → Integrations',
      409,
    );
  }

  // Google Docs native eSignature (Tools -> eSignature) is a Workspace-only
  // feature — personal @gmail.com accounts have no eSignature panel. Block the
  // deep-link for non-Workspace accounts so we don't send them somewhere they
  // can't complete. Detected via the OAuth `hd` (hosted domain) claim.
  if (!(await isWorkspaceAccount(accessToken))) {
    throw new LegalDocSignatureError(
      'WORKSPACE_REQUIRED',
      'Google Docs eSignature requires a Google Workspace account',
      403,
    );
  }

  // Persist the request marker on the row's metadata so the UI can show
  // "Signature requested at …" provenance and avoid double-dipping. We
  // merge into the existing metadata blob (preserves deletedAt etc.).
  const signatureRequestedAt = new Date().toISOString();
  const nextMetadata = {
    ...(doc.metadata ?? {}),
    signatureRequestedAt,
    // Sentinel for future swap to programmatic API — see file header.
    signatureRequestId: null as string | null,
  };
  const { error: updateErr } = await supabase
    .from('LegalDocument')
    .update({ metadata: nextMetadata, updatedAt: signatureRequestedAt })
    .eq('id', doc.id)
    .eq('organizationId', input.organizationId);
  if (updateErr) {
    // Non-fatal — log loudly but still return the deeplink so the user
    // isn't blocked on a metadata write.
    log.warn('legalDocSignatureService: metadata write failed (continuing)', {
      documentId: doc.id,
      message: updateErr.message,
    });
  }

  log.info('legalDocSignatureService: deeplink issued', {
    documentId: doc.id,
    googleDocId: doc.googleDocId,
  });

  return {
    ok: true,
    deeplinkUrl: doc.googleDocUrl,
    signatureRequestedAt,
    signatureRequestId: null,
  };
}
