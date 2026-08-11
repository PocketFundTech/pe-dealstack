// Dropbox Sign (formerly HelloSign) eSignature client. NOT a registered
// provider — invoked directly from legalDocEsignService.
//
// Why this exists: our current NDA "send" shares an *editable* Google Doc
// link, so the counterparty can alter the text and there's no locked,
// signed PDF + audit trail at the end. Dropbox Sign replicates Google's
// native eSignature behaviour — the signer gets a non-editable document,
// signs it, and we get back a flattened, tamper-evident signed PDF.
//
// Raw fetch (not the @dropbox/sign SDK) to match repo conventions and avoid
// pulling a node-only SDK into the Vercel lambda bundle (serverExternalPackages).
//
// Auth: HTTP Basic with the API key as the username and an empty password.
// Test mode: when DROPBOX_SIGN_TEST_MODE !== 'false' every request sets
// test_mode=1 — no legally-binding signature, no charge. Flip the env to
// 'false' to go live.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { log } from '../../utils/logger.js';

const API_BASE = 'https://api.hellosign.com/v3';
const REQUEST_TIMEOUT_MS = 30_000;

export type DropboxSignErrorCode =
  | 'NOT_CONFIGURED'
  | 'INVALID_API_KEY'
  | 'API_ERROR'
  | 'RATE_LIMITED'
  | 'DOWNLOAD_FAILED';

export class DropboxSignError extends Error {
  code: DropboxSignErrorCode;
  status: number;
  details?: string;
  constructor(
    code: DropboxSignErrorCode,
    message: string,
    status: number,
    details?: string,
  ) {
    super(message);
    this.name = 'DropboxSignError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface DropboxSignConfig {
  apiKey: string;
  testMode: boolean;
}

/**
 * Reads DROPBOX_SIGN_API_KEY + DROPBOX_SIGN_TEST_MODE from the environment.
 * Test mode defaults ON — only an explicit DROPBOX_SIGN_TEST_MODE=false
 * sends real, billable, legally-binding requests. Returns null when no API
 * key is set so callers can surface a clean NOT_CONFIGURED instead of a 401.
 */
export function getDropboxSignConfig(): DropboxSignConfig | null {
  const apiKey = process.env.DROPBOX_SIGN_API_KEY?.trim();
  if (!apiKey) return null;
  const testMode = process.env.DROPBOX_SIGN_TEST_MODE?.trim() !== 'false';
  return { apiKey, testMode };
}

function authHeader(apiKey: string): string {
  // Dropbox Sign uses Basic auth: API key as username, empty password.
  return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
}

function mapHttpError(status: number, bodyText: string): DropboxSignError {
  const preview = bodyText.slice(0, 500);
  if (status === 401 || status === 403) {
    return new DropboxSignError(
      'INVALID_API_KEY',
      'Dropbox Sign rejected the API key (401/403)',
      status,
      preview,
    );
  }
  if (status === 429) {
    return new DropboxSignError(
      'RATE_LIMITED',
      'Dropbox Sign rate limit exceeded',
      status,
      preview,
    );
  }
  return new DropboxSignError(
    'API_ERROR',
    `Dropbox Sign request failed (${status})`,
    status,
    preview,
  );
}

export interface SignerInput {
  email: string;
  name: string;
}

export interface SendSignatureRequestInput {
  apiKey: string;
  testMode: boolean;
  pdf: Buffer;
  filename: string;
  title: string;
  subject: string;
  message?: string;
  signer: SignerInput;
  // Echoed back on every webhook event — used to correlate the signed PDF
  // with our LegalDocument row.
  metadata: Record<string, string>;
  // When true, send use_text_tags=1 + hide_text_tags=1 so Dropbox places
  // signer fields where our [sig|…]/[date|…] markers sit in the document and
  // whites the markers out — instead of auto-placing fields at the end.
  useTextTags?: boolean;
}

export interface SendSignatureRequestResult {
  signatureRequestId: string;
  testMode: boolean;
}

/**
 * Sends a single-signer signature request with the PDF as an uploaded file.
 * Multipart form-data: Dropbox Sign reads the binary from `file[0]` and the
 * scalar fields by name. Returns the signature_request_id we persist for
 * later download + webhook correlation.
 *
 * Field placement: with `useTextTags` we tell Dropbox to read in-document
 * text tags (see integrations/dropboxSign/textTags.ts) so the signature lands
 * where our marker is; without it, Dropbox auto-places the field.
 */
export async function sendSignatureRequest(
  input: SendSignatureRequestInput,
): Promise<SendSignatureRequestResult> {
  const form = new FormData();
  form.append(
    'file[0]',
    new Blob([new Uint8Array(input.pdf)], { type: 'application/pdf' }),
    input.filename,
  );
  form.append('title', input.title);
  form.append('subject', input.subject);
  if (input.message) form.append('message', input.message);
  form.append('signers[0][email_address]', input.signer.email);
  form.append('signers[0][name]', input.signer.name);
  form.append('test_mode', input.testMode ? '1' : '0');
  if (input.useTextTags) {
    // Parse [type|req|signerN] markers in the document and whiteout the marker
    // text in the output PDF. hide_text_tags requires each tag on its own line
    // — signatureBlockHtml() guarantees that.
    form.append('use_text_tags', '1');
    form.append('hide_text_tags', '1');
  }
  for (const [key, value] of Object.entries(input.metadata)) {
    form.append(`metadata[${key}]`, value);
  }

  const res = await fetch(`${API_BASE}/signature_request/send`, {
    method: 'POST',
    headers: { Authorization: authHeader(input.apiKey) },
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log.warn('dropboxSign.sendSignatureRequest: non-2xx', {
      status: res.status,
      bodyPreview: text.slice(0, 200),
    });
    throw mapHttpError(res.status, text);
  }

  const json = (await res.json()) as {
    signature_request?: { signature_request_id?: string; test_mode?: boolean };
  };
  const id = json.signature_request?.signature_request_id;
  if (!id) {
    throw new DropboxSignError(
      'API_ERROR',
      'Dropbox Sign response missing signature_request_id',
      res.status,
      JSON.stringify(json).slice(0, 500),
    );
  }
  return {
    signatureRequestId: id,
    testMode: Boolean(json.signature_request?.test_mode),
  };
}

/**
 * Downloads the flattened, signed PDF for a completed signature request.
 * `file_type=pdf` returns a single merged PDF (vs `zip` for per-file). Returns
 * the raw bytes — the caller decides where to store them.
 */
export async function downloadSignedPdf(
  apiKey: string,
  signatureRequestId: string,
): Promise<Buffer> {
  const url = `${API_BASE}/signature_request/files/${encodeURIComponent(
    signatureRequestId,
  )}?file_type=pdf`;
  const res = await fetch(url, {
    headers: { Authorization: authHeader(apiKey) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log.warn('dropboxSign.downloadSignedPdf: non-2xx', {
      status: res.status,
      bodyPreview: text.slice(0, 200),
    });
    throw new DropboxSignError(
      'DOWNLOAD_FAILED',
      `Failed to download signed PDF (${res.status})`,
      res.status,
      text.slice(0, 500),
    );
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) {
    throw new DropboxSignError(
      'DOWNLOAD_FAILED',
      'Dropbox Sign returned an empty signed PDF',
      res.status,
    );
  }
  return buf;
}

/**
 * Verifies a webhook event's authenticity. Dropbox Sign signs each event with
 * HMAC-SHA256 over (event_time + event_type) keyed by the account API key; the
 * result is `event.event_hash`. Constant-time comparison guards against timing
 * attacks. Returns false on any malformed input rather than throwing so the
 * route can answer a flat 401.
 */
export function verifyWebhookEvent(
  apiKey: string,
  event: {
    event_time?: string;
    event_type?: string;
    event_hash?: string;
  } | null,
): boolean {
  if (!event?.event_time || !event.event_type || !event.event_hash) {
    return false;
  }
  const expected = createHmac('sha256', apiKey)
    .update(event.event_time + event.event_type)
    .digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(event.event_hash, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
