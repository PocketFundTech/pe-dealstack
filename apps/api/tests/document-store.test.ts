import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseChainMock, filterValue, type ChainOp, type ChainResult } from './helpers/supabaseChainMock';

let resolver: (op: ChainOp) => ChainResult | undefined = () => undefined;
const chain = makeSupabaseChainMock((op) => resolver(op));
const storageUpload = vi.fn(async () => ({ data: { path: 'p' }, error: null as unknown }));
vi.mock('../src/supabase.js', () => ({
  supabase: { from: (t: string) => chain.from(t), storage: { from: () => ({ upload: storageUpload }) } },
}));
vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const validateFile = vi.fn();
vi.mock('../src/services/fileValidator.js', () => ({
  validateFile: (...a: unknown[]) => validateFile(...a),
  isPotentiallyDangerous: () => false,
  sanitizeFilename: (n: string) => n,
}));
vi.mock('../src/services/pdfExtractor.js', () => ({
  extractTextFromPDF: vi.fn(async () => ({ text: 'pdf text\u0000', numPages: 3 })),
}));
vi.mock('../src/services/excelToMarkdown.js', () => ({ excelToMarkdown: () => '| a |' }));
vi.mock('../src/services/excelFinancialExtractor.js', () => ({
  isExcelFile: (mime: string | null) => !!mime && mime.includes('spreadsheet'),
}));
const embedDocument = vi.fn();
vi.mock('../src/rag.js', () => ({ embedDocument: (...a: unknown[]) => embedDocument(...a) }));

import { inferDocumentType, resolveDefaultFolderId, extractLocalText, addFileToDeal } from '../src/services/documentStore.js';

beforeEach(() => {
  chain.calls.length = 0;
  resolver = () => undefined;
  storageUpload.mockClear();
  validateFile.mockReset().mockReturnValue({ isValid: true, sanitizedFilename: 'CIM.pdf' });
  embedDocument.mockClear();
});

describe('inferDocumentType', () => {
  it.each([
    ['Project Atlas CIM.pdf', 'application/pdf', 'CIM'],
    ['teaser.pdf', 'application/pdf', 'TEASER'],
    ['model.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'FINANCIALS'],
    ['data.csv', 'text/csv', 'FINANCIALS'],
    ['Mutual NDA.docx', null, 'NDA'],
    ['photo.png', 'image/png', 'OTHER'],
  ])('%s → %s', (name, mime, expected) => {
    expect(inferDocumentType(name, mime)).toBe(expected);
  });
});

describe('resolveDefaultFolderId', () => {
  it('creates the default folders when the deal has none, then matches by type', async () => {
    resolver = (op) => {
      if (op.table === 'Folder' && op.action === 'select') return { data: [] };
      if (op.table === 'Folder' && op.action === 'insert') {
        return { data: [{ id: 'f-fin', name: '100 Financials' }, { id: 'f-legal', name: '200 Legal' }] };
      }
      return undefined;
    };
    expect(await resolveDefaultFolderId('deal-1', 'NDA')).toBe('f-legal');
    expect(chain.calls.some((c) => c.table === 'Folder' && c.action === 'insert')).toBe(true);
  });

  it('uses the first folder for a type without a pattern', async () => {
    resolver = (op) => (op.table === 'Folder' ? { data: [{ id: 'f-a', name: '100 Financials' }] } : undefined);
    expect(await resolveDefaultFolderId('deal-1', 'OTHER')).toBe('f-a');
  });
});

describe('extractLocalText', () => {
  it('PDF: text without NULs, page count, completed', async () => {
    expect(await extractLocalText(Buffer.from('x'), 'application/pdf', 'a.pdf'))
      .toEqual({ text: 'pdf text', numPages: 3, status: 'completed' });
  });
  it('Excel with content: text, still processing (matches the upload route)', async () => {
    const r = await extractLocalText(Buffer.from('x'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'm.xlsx');
    expect(r).toEqual({ text: '| a |', numPages: null, status: 'processing' });
  });
  it('other types: no text, completed', async () => {
    expect(await extractLocalText(Buffer.from('x'), 'image/png', 'p.png')).toEqual({ text: null, numPages: null, status: 'completed' });
  });
});

describe('addFileToDeal', () => {
  const input = {
    dealId: 'deal-1', filename: 'CIM.pdf', buffer: Buffer.from('%PDF-1.4 body'),
    mimeType: 'application/pdf', uploadedBy: 'user-1', hubspotFileId: 'hs-f1',
  };

  it('returns the existing document when this HubSpot file is already on the deal — no upload', async () => {
    resolver = (op) => (op.table === 'Document' && filterValue(op, 'hubspotFileId') === 'hs-f1'
      ? { data: { id: 'doc-old' } } : undefined);
    expect(await addFileToDeal(input)).toEqual({ outcome: 'existing', documentId: 'doc-old' });
    expect(storageUpload).not.toHaveBeenCalled();
  });

  it('rejects a file that fails validation', async () => {
    validateFile.mockReturnValue({ isValid: false, error: 'bad magic bytes' });
    expect(await addFileToDeal(input)).toEqual({ outcome: 'rejected', reason: 'bad magic bytes' });
    expect(storageUpload).not.toHaveBeenCalled();
  });

  it('links an identical file already on the deal (same sha256) instead of copying it', async () => {
    resolver = (op) => {
      if (op.table === 'Document' && op.action === 'select' && filterValue(op, 'fileSha256')) {
        return { data: { id: 'doc-same', hubspotFileId: null } };
      }
      return undefined;
    };
    expect(await addFileToDeal(input)).toEqual({ outcome: 'existing', documentId: 'doc-same' });
    const upd = chain.calls.find((c) => c.table === 'Document' && c.action === 'update');
    expect(upd?.payload).toEqual({ hubspotFileId: 'hs-f1' });
    expect(storageUpload).not.toHaveBeenCalled();
  });

  it('stores, inserts the Document with hubspotFileId and never embeds', async () => {
    resolver = (op) => {
      if (op.table === 'Folder' && op.action === 'select') return { data: [{ id: 'f-fin', name: '100 Financials' }] };
      if (op.table === 'Document' && op.action === 'insert') return { data: { id: 'doc-new' } };
      return undefined;
    };
    expect(await addFileToDeal(input)).toEqual({ outcome: 'created', documentId: 'doc-new' });
    expect(storageUpload).toHaveBeenCalledTimes(1);
    const ins = chain.calls.find((c) => c.table === 'Document' && c.action === 'insert');
    expect(ins?.payload).toMatchObject({
      dealId: 'deal-1', folderId: 'f-fin', uploadedBy: 'user-1', name: 'CIM.pdf', type: 'CIM',
      mimeType: 'application/pdf', extractedText: 'pdf text', status: 'completed', hubspotFileId: 'hs-f1',
    });
    expect(embedDocument).not.toHaveBeenCalled();
  });

  it('omits hubspotFileId entirely for non-HubSpot callers', async () => {
    resolver = (op) => (op.table === 'Document' && op.action === 'insert' ? { data: { id: 'doc-x' } } : undefined);
    await addFileToDeal({ ...input, hubspotFileId: null });
    const ins = chain.calls.find((c) => c.table === 'Document' && c.action === 'insert');
    expect(ins?.payload).not.toHaveProperty('hubspotFileId');
  });

  it('throws when storage fails (the caller marks the file failed)', async () => {
    storageUpload.mockResolvedValueOnce({ data: null as unknown as { path: string }, error: { message: 'bucket gone' } });
    await expect(addFileToDeal(input)).rejects.toThrow(/bucket gone/);
  });
});
