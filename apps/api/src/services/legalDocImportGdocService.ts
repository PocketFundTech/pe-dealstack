// Imports a reference to an EXISTING Google Doc the user already prepared in
// their own Drive (Google has no API to insert an eSignature field, so the
// user adds it manually in the Docs UI, then pastes the Doc URL here). We
// validate the user's Workspace token can read the Doc, fetch its name +
// webViewLink, and insert a LegalDocument row that points at that Doc —
// `content` stays null because there is no in-app HTML for an imported doc.
//
// The `metadata.source === 'imported-gdoc'` marker is how the send pipeline
// (legalDocSendService) and the frontend recognize an imported doc: /send
// shares + emails THIS doc instead of creating a brand-new one. Signature
// polling already works on any row with a googleDocId, so detection is free.
//
// Failure modes the route layer maps onto the JSON envelope:
//   * INVALID_GDOC_URL     — no file id parseable from `url`            (400)
//   * GOOGLE_NOT_CONNECTED — no Workspace integration for this user     (409)
//   * GOOGLE_SCOPES_MISSING— connected before Drive scope was added     (409)
//   * GDOC_NOT_ACCESSIBLE  — Doc isn't in / shared to the connected acct(404)
//   * DRIVE_API_ERROR      — any other Drive failure                    (502)

import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getProviderAccessToken } from '../integrations/_platform/tokenStore.js';
import { extractGoogleDocId, getDocMetadata } from '../integrations/googleDrive/client.js';
import { isWorkspaceAccount } from '../integrations/googleCalendar/client.js';
import { GoogleDriveError } from '../integrations/googleDrive/types.js';

// Shared marker written to metadata.source so send + the frontend can tell an
// imported Doc apart from a composed (HTML template) NDA. Keep in sync with
// the read-side check in legalDocSendService.ts.
export const IMPORTED_GDOC_SOURCE = 'imported-gdoc';

// Same storage key the send service uses — Drive piggybacks on the Workspace
// (`google_calendar`) provider's OAuth token (display name aside).
const GOOGLE_PROVIDER_ID = 'google_calendar' as const;

export type LegalDocImportGdocErrorCode =
  | 'INVALID_GDOC_URL'
  | 'GOOGLE_NOT_CONNECTED'
  | 'GOOGLE_SCOPES_MISSING'
  | 'WORKSPACE_REQUIRED'
  | 'GDOC_NOT_ACCESSIBLE'
  | 'DRIVE_API_ERROR';

export class LegalDocImportGdocError extends Error {
  code: LegalDocImportGdocErrorCode;
  status: number;
  details?: string;
  constructor(
    code: LegalDocImportGdocErrorCode,
    message: string,
    status: number,
    details?: string,
  ) {
    super(message);
    this.name = 'LegalDocImportGdocError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface ImportGoogleDocInput {
  dealId: string;
  organizationId: string;
  userId: string; // internal User.id — needed to look up the Workspace token
  url?: string;
  fileId?: string; // concrete Drive file id from the Google Picker (preferred over url)
  title?: string;
  counterpartyName?: string;
  counterpartyEmail?: string;
  counterpartyAddress?: string;
  jurisdiction?: string;
  effectiveDate?: string; // YYYY-MM-DD
}

function mapDriveErrorToImportError(err: unknown): LegalDocImportGdocError {
  if (err instanceof GoogleDriveError) {
    if (err.code === 'INVALID_TOKEN' || err.code === 'INSUFFICIENT_SCOPE') {
      return new LegalDocImportGdocError(
        'GOOGLE_SCOPES_MISSING',
        'Google connection lacks Drive scope — please reconnect Google Workspace',
        409,
        err.details ?? err.message,
      );
    }
    // 404 (file not found) or PERMISSION_DENIED both mean the Doc isn't in or
    // shared to the connected Google account — surface a single 404 code.
    if (err.code === 'PERMISSION_DENIED' || err.status === 404) {
      return new LegalDocImportGdocError(
        'GDOC_NOT_ACCESSIBLE',
        'That Google Doc is not in (or shared to) the connected Google account',
        404,
        err.details ?? err.message,
      );
    }
    return new LegalDocImportGdocError(
      'DRIVE_API_ERROR',
      `Drive metadata fetch failed: ${err.message}`,
      502,
      err.details ?? err.message,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new LegalDocImportGdocError(
    'DRIVE_API_ERROR',
    'Drive metadata fetch failed',
    502,
    message,
  );
}

/**
 * Validate + import a reference to an existing Google Doc. Throws
 * LegalDocImportGdocError on every expected failure so the route can map the
 * typed error to the JSON envelope; returns the inserted LegalDocument row
 * (select('*') shape) on success.
 */
export async function importGoogleDoc(input: ImportGoogleDocInput) {
  // ── Parse the file id from the pasted URL / bare id ─────────────────
  const googleDocId =
    input.fileId?.trim() || (input.url ? extractGoogleDocId(input.url) : null);
  if (!googleDocId) {
    throw new LegalDocImportGdocError(
      'INVALID_GDOC_URL',
      'Could not parse a Google Doc id from the provided URL',
      400,
    );
  }

  // ── Resolve the user's Google Workspace access token ────────────────
  const accessToken = await getProviderAccessToken({
    userId: input.userId,
    organizationId: input.organizationId,
    providerId: GOOGLE_PROVIDER_ID,
  });
  if (!accessToken) {
    throw new LegalDocImportGdocError(
      'GOOGLE_NOT_CONNECTED',
      'Google is not connected for this user — open Settings → Integrations',
      409,
    );
  }

  // Importing a Doc for the native Google Docs eSignature flow only makes
  // sense on a Workspace account (personal accounts can't add an eSignature
  // field). Gate it via the OAuth `hd` (hosted domain) claim.
  if (!(await isWorkspaceAccount(accessToken))) {
    throw new LegalDocImportGdocError(
      'WORKSPACE_REQUIRED',
      'Importing a Google Doc for signature requires a Google Workspace account',
      403,
    );
  }

  // ── Validate access + fetch the Doc name / webViewLink ──────────────
  let meta: { id: string; name: string; webViewLink: string };
  try {
    meta = await getDocMetadata(accessToken, googleDocId);
  } catch (err) {
    log.error('legalDocImportGdocService: getDocMetadata failed', err, {
      dealId: input.dealId,
      googleDocId,
    });
    throw mapDriveErrorToImportError(err);
  }

  // ── Insert the LegalDocument row ────────────────────────────────────
  const insertRow = {
    organizationId: input.organizationId,
    dealId: input.dealId,
    createdById: input.userId,
    // /nda surface is NDA-only for v1; broader doc-type picker is future work.
    docType: 'NDA' as const,
    title: input.title ?? meta.name,
    counterpartyName: input.counterpartyName ?? null,
    counterpartyEmail: input.counterpartyEmail ?? null,
    counterpartyAddress: input.counterpartyAddress ?? null,
    jurisdiction: input.jurisdiction ?? null,
    effectiveDate: input.effectiveDate ?? null,
    status: 'DRAFT' as const,
    // No template linkage + no in-app HTML — this row points at a Doc the
    // user already prepared in their own Drive.
    templateId: null,
    content: null,
    googleDocId: meta.id,
    googleDocUrl: meta.webViewLink,
    // The marker send + the frontend key off to recognize an imported doc.
    metadata: { source: IMPORTED_GDOC_SOURCE },
  };

  const { data, error } = await supabase
    .from('LegalDocument')
    .insert(insertRow)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}
