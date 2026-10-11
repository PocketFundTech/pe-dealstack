import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseChainMock, type ChainOp, type ChainResult } from './helpers/supabaseChainMock.js';

/**
 * Dropbox Sign's event_hash only signs (event_time + event_type) — the
 * signature_request body (id + metadata.legalDocumentId/organizationId) is
 * unauthenticated. A replayed valid hash with a forged body could mark ANY
 * org's legal document SIGNED and store an attacker-controlled PDF. The
 * completion handler now only acts when the event's signature_request_id is
 * the one we stored when we sent that document for signature.
 */

let resolver: (op: ChainOp) => ChainResult | undefined = () => ({});
let mock = makeSupabaseChainMock((op) => resolver(op));

vi.mock('../src/supabase.js', () => ({
  supabase: {
    from: (t: string) => mock.from(t),
    storage: { from: () => ({ upload: async () => ({ data: { path: 'p' }, error: null }) }) },
  },
}));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const downloadSignedPdf = vi.fn(async () => Buffer.from('%PDF'));
vi.mock('../src/integrations/dropboxSign/client.js', () => ({
  getDropboxSignConfig: () => ({ apiKey: 'k', testMode: true }),
  sendSignatureRequest: vi.fn(),
  downloadSignedPdf: (...a: unknown[]) => downloadSignedPdf(...(a as [])),
  DropboxSignError: class extends Error {},
}));
vi.mock('../src/services/legalDocExportService.js', () => ({
  exportLegalDocument: vi.fn(), LegalDocExportError: class extends Error {},
}));
vi.mock('../src/services/legalDocSignatureBlock.js', () => ({ placeEsignSignatureBlock: vi.fn() }));
vi.mock('../src/services/legalDocSubstituteService.js', () => ({ substituteTokens: vi.fn() }));
vi.mock('../src/services/legalDocLookups.js', () => ({
  loadDealForLegalDoc: vi.fn(), loadOrgForLegalDoc: vi.fn(), buildLegalDocTokenValues: vi.fn(),
}));

function completionEvent(signatureRequestId: string) {
  return {
    event: { event_type: 'signature_request_all_signed', event_time: '1', event_hash: 'h' },
    signature_request: {
      signature_request_id: signatureRequestId,
      metadata: { legalDocumentId: 'legal-doc-b', organizationId: 'org-B' },
    },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mock = makeSupabaseChainMock((op) => resolver(op));
  resolver = (op) => {
    if (op.table === 'LegalDocument' && op.action === 'select') {
      return {
        data: {
          id: 'legal-doc-b',
          metadata: { esign: { provider: 'dropbox_sign', signatureRequestId: 'sr-real', status: 'sent' } },
        },
      };
    }
    return { data: null };
  };
});

describe('handleDropboxSignEvent — event must match the stored signature request', () => {
  it('ignores a completion whose signature_request_id is not the one stored on the document', async () => {
    const { handleDropboxSignEvent } = await import('../src/services/legalDocEsignService.js');
    await handleDropboxSignEvent(completionEvent('sr-attacker'));
    expect(mock.calls.some((c) => c.table === 'LegalDocument' && c.action === 'update')).toBe(false);
    expect(downloadSignedPdf).not.toHaveBeenCalled();
  });

  it('marks the document SIGNED when the signature_request_id matches', async () => {
    const { handleDropboxSignEvent } = await import('../src/services/legalDocEsignService.js');
    await handleDropboxSignEvent(completionEvent('sr-real'));
    const upd = mock.calls.find((c) => c.table === 'LegalDocument' && c.action === 'update');
    expect(upd).toBeDefined();
    expect((upd!.payload as any).status).toBe('SIGNED');
  });
});
