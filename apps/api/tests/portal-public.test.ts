/**
 * Public portal API — GET /api/public/portal/:token (+ document download).
 * No auth: these endpoints are consumed by external viewers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const getSignedDownloadUrl = vi.fn();
const downloadFileBuffer = vi.fn();
const fetchStorageObject = vi.fn();
vi.mock('../src/utils/storage.js', () => ({
  getSignedDownloadUrl: (...args: any[]) => getSignedDownloadUrl(...args),
  downloadFileBuffer: (...args: any[]) => downloadFileBuffer(...args),
  fetchStorageObject: (...args: any[]) => fetchStorageObject(...args),
  extractStoragePath: (p: string) => p,
}));

const watermarkPdf = vi.fn();
vi.mock('../src/services/pdfWatermark.js', () => ({
  watermarkPdf: (...args: any[]) => watermarkPdf(...args),
}));

function binaryParser(res: any, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

let shareRow: any;
let dealRow: any;
let statements: any[] = [];
let documents: any[] = [];
let memos: any[] = [];
const memoFilters: Array<[string, string]> = [];
let orgRow: any = { name: 'Acme Capital' };
let recordedViews: any[] = [];
let dealSelects: string[] = [];
let docRow: any;

function tableMock() {
  return (table: string) => {
    if (table === 'DealShare') {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: shareRow, error: null }) }) }) };
    }
    if (table === 'DealShareView') {
      return {
        // recordViewAndNotify() counts existing views for this share before
        // inserting, to detect a first-ever view — mirror that with a live
        // count off recordedViews so the mock stays correct as it grows.
        // Count query (first-view check) and the 60s same-browser dedupe query.
        select: (_cols: string, opts?: { count?: string }) => {
          const f: Record<string, any> = {};
          const b: any = {
            eq: (k: string, v: any) => { f[k] = v; return b; },
            gte: (_k: string, v: string) => { f.since = v; return b; },
            limit: () => b,
            then: (res: any, rej: any) => Promise.resolve(
              opts?.count
                ? { count: recordedViews.length, error: null }
                : { data: recordedViews.filter((r) => r.userAgent === f.userAgent && (!f.since || r.viewedAt >= f.since)), error: null },
            ).then(res, rej),
          };
          return b;
        },
        insert: async (row: any) => {
          // Slow write, like a real network round-trip: the response must not
          // go out before this lands (QA #25b — on Vercel it was killed).
          await new Promise((r) => setTimeout(r, 25));
          recordedViews.push({ ...row, viewedAt: new Date().toISOString() });
          return { error: null };
        },
      };
    }
    if (table === 'Deal') {
      return {
        select: (cols: string) => {
          dealSelects.push(cols);
          // Mirror PostgREST: selecting a column that doesn't exist on Deal
          // errors and yields data:null (this is exactly how the real
          // 2026-08-18 bug 404'd every valid share link — `companyName` is a
          // relation, not a column). Only the real column list + embedded
          // relation succeeds.
          const requestsBogusColumn = /\bcompanyName\b/.test(cols);
          return {
            eq: () => ({
              single: async () =>
                requestsBogusColumn
                  ? { data: null, error: { message: 'column Deal.companyName does not exist' } }
                  : { data: dealRow, error: null },
            }),
          };
        },
      };
    }
    if (table === 'Organization') {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: orgRow, error: null }) }) }) };
    }
    if (table === 'FinancialStatement') {
      return { select: () => ({ eq: () => ({ eq: () => ({ order: async () => ({ data: statements, error: null }) }) }) }) };
    }
    if (table === 'Document') {
      return {
        select: () => ({
          eq: (col: string) => {
            if (col === 'id') {
              return { single: async () => ({ data: docRow, error: null }) };
            }
            return { order: async () => ({ data: documents, error: null }) };
          },
        }),
      };
    }
    if (table === 'Memo') {
      // Memos are bound to BOTH the share's deal and its organization.
      memoFilters.length = 0;
      return {
        select: () => ({
          eq: (c1: string, v1: string) => ({
            eq: (c2: string, v2: string) => {
              memoFilters.push([c1, v1], [c2, v2]);
              return { order: async () => ({ data: memos, error: null }) };
            },
          }),
        }),
      };
    }
    if (table === 'MemoSection') {
      return { select: () => ({ in: () => ({ order: async () => ({ data: [], error: null }) }) }) };
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

function validShare(overrides: Record<string, unknown> = {}) {
  return {
    id: 'share-1', dealId: 'deal-1', organizationId: 'org-1', token: 'tok',
    label: 'Partner', includeFinancials: true, includeDocuments: true, includeMemos: true,
    expiresAt: null, revokedAt: null,
    ...overrides,
  };
}

async function buildApp() {
  const { default: router } = await import('../src/routes/portal.js');
  const app = express();
  app.use(express.json());
  app.use('/api/public/portal', router); // NOTE: no auth middleware — deliberately public
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  shareRow = validShare();
  dealRow = { id: 'deal-1', name: 'Project Neptune', company: { name: 'NeptuneCo' }, industry: 'Software', stage: 'DUE_DILIGENCE', description: 'desc', dealSize: 12, revenue: 10, ebitda: 2, currency: 'USD' };
  dealSelects = [];
  statements = [{ statementType: 'INCOME_STATEMENT', period: 'FY2023', unitScale: 'MILLIONS', currency: 'USD', lineItems: { revenue: 10, ebitda_margin_pct: 19.6, revenue_source: 'Revenue 10,000' } }];
  documents = [{ id: 'doc-1', name: 'CIM.pdf', type: 'CIM', fileSize: 1000 }];
  memos = [];
  recordedViews = [];
  docRow = { id: 'doc-1', dealId: 'deal-1', fileUrl: 'path/CIM.pdf', name: 'CIM.pdf', mimeType: 'application/pdf', fileSize: 1000 };
  mockSupabase.from.mockImplementation(tableMock());
  getSignedDownloadUrl.mockResolvedValue('https://signed.example/CIM.pdf');
  downloadFileBuffer.mockResolvedValue(Buffer.from('%PDF-original'));
  watermarkPdf.mockResolvedValue(Buffer.from('%PDF-watermarked'));
  fetchStorageObject.mockImplementation(async () => new Response('raw-xlsx-bytes', {
    status: 200, headers: { 'content-type': 'application/vnd.ms-excel', 'content-length': '14' },
  }));
});

describe('GET /api/public/portal/:token', () => {
  it('returns the scoped payload and records a view', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/public/portal/tok');
    expect(res.status).toBe(200);
    expect(res.body.deal.name).toBe('Project Neptune');
    // Memos are scoped to the share's deal AND org, so a memo another org
    // re-pointed at this deal can never surface on this portal.
    expect(memoFilters).toEqual([['dealId', 'deal-1'], ['organizationId', 'org-1']]);
    // companyName is derived from the embedded Company relation, never a Deal
    // column — the select must ask for the relation (regression 2026-08-18).
    expect(res.body.deal.companyName).toBe('NeptuneCo');
    // `*_source` provenance keys are internal extraction breadcrumbs — they
    // must never reach an external viewer (regression 2026-08-18: they were
    // rendered as line items on the client-facing portal).
    for (const stmt of res.body.financials ?? []) {
      expect(Object.keys(stmt.lineItems)).not.toContain('revenue_source');
      expect(Object.keys(stmt.lineItems).some((k: string) => k.endsWith('_source'))).toBe(false);
    }
    expect(dealSelects.some((c) => /company:Company\(name\)/.test(c))).toBe(true);
    expect(res.body.share.sharedBy).toBe('Acme Capital');
    expect(res.body.financials).toHaveLength(1);
    expect(res.body.documents).toHaveLength(1);
    // Recorded BEFORE the response was sent (the insert takes 25ms).
    expect(recordedViews).toHaveLength(1);
    // whitelist check — internal fields never leak
    expect(res.body.deal.aiThesis).toBeUndefined();
    expect(res.body.deal.scorecard).toBeUndefined();
  });

  it('counts a quick repeat open from the same browser once (refresh / double fetch)', async () => {
    const app = await buildApp();
    await request(app).get('/api/public/portal/tok').set('User-Agent', 'Chrome-A');
    await request(app).get('/api/public/portal/tok').set('User-Agent', 'Chrome-A');
    expect(recordedViews).toHaveLength(1);
    await request(app).get('/api/public/portal/tok').set('User-Agent', 'Safari-B');
    expect(recordedViews).toHaveLength(2);
  });

  it('omits disabled sections entirely', async () => {
    shareRow = validShare({ includeFinancials: false, includeDocuments: false, includeMemos: false });
    const app = await buildApp();
    const res = await request(app).get('/api/public/portal/tok');
    expect(res.status).toBe(200);
    expect(res.body.financials).toBeUndefined();
    expect(res.body.documents).toBeUndefined();
    expect(res.body.memos).toBeUndefined();
  });

  it('404s on an unknown token', async () => {
    shareRow = null;
    const app = await buildApp();
    const res = await request(app).get('/api/public/portal/nope');
    expect(res.status).toBe(404);
    expect(recordedViews).toHaveLength(0);
  });

  it('410s when revoked', async () => {
    shareRow = validShare({ revokedAt: '2026-08-01T00:00:00Z' });
    const app = await buildApp();
    const res = await request(app).get('/api/public/portal/tok');
    expect(res.status).toBe(410);
  });

  it('410s when expired', async () => {
    shareRow = validShare({ expiresAt: '2020-01-01T00:00:00Z' });
    const app = await buildApp();
    const res = await request(app).get('/api/public/portal/tok');
    expect(res.status).toBe(410);
  });
});

describe('GET /api/public/portal/:token/documents/:documentId/download', () => {
  const url = '/api/public/portal/tok/documents/doc-1/download';

  it('streams a WATERMARKED PDF through the API — never a redirect to a storage signed URL', async () => {
    const app = await buildApp();
    const res = await request(app).get(url).buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers.location).toBeUndefined();
    expect(res.body.toString()).toBe('%PDF-watermarked');
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['x-watermarked']).toBe('1');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(getSignedDownloadUrl).not.toHaveBeenCalled();
    // Viewer identity on the stamp: the share link (label + id) and when.
    expect(watermarkPdf).toHaveBeenCalledTimes(1);
    const [bytes, viewer] = watermarkPdf.mock.calls[0];
    expect(Buffer.from(bytes).toString()).toBe('%PDF-original');
    expect(viewer.email).toContain('Shared via portal link');
    expect(viewer.email).toContain('Partner');
    expect(viewer.timestamp).toBeInstanceOf(Date);
  });

  it('includes the invited email in the watermark when the share was sent to one', async () => {
    shareRow = validShare({ invitedEmail: 'lp@fund.com' });
    const app = await buildApp();
    await request(app).get(url).buffer(true).parse(binaryParser);
    expect(watermarkPdf.mock.calls[0][1].email).toContain('lp@fund.com');
  });

  it('strips characters the PDF font cannot draw from the label (would otherwise skip the watermark)', async () => {
    shareRow = validShare({ label: 'Partner 🚀 東京' });
    const app = await buildApp();
    await request(app).get(url).buffer(true).parse(binaryParser);
    // eslint-disable-next-line no-control-regex
    expect(watermarkPdf.mock.calls[0][1].email).toMatch(/^[\x20-\x7E]+$/);
  });

  it('streams non-PDF files through the API unwatermarked (same rule as internal downloads)', async () => {
    docRow = { ...docRow, name: 'Model.xlsx', mimeType: 'application/vnd.ms-excel', fileUrl: 'path/Model.xlsx' };
    const app = await buildApp();
    const res = await request(app).get(url).buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers.location).toBeUndefined();
    expect(res.body.toString()).toBe('raw-xlsx-bytes');
    expect(res.headers['content-disposition']).toContain('Model.xlsx');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(watermarkPdf).not.toHaveBeenCalled();
    expect(getSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it('404s for a document that belongs to a different deal', async () => {
    docRow = { id: 'doc-1', dealId: 'other-deal', fileUrl: 'x' };
    const app = await buildApp();
    const res = await request(app).get(url);
    expect(res.status).toBe(404);
    expect(downloadFileBuffer).not.toHaveBeenCalled();
    expect(fetchStorageObject).not.toHaveBeenCalled();
  });

  it('404s when documents are disabled on the share', async () => {
    shareRow = validShare({ includeDocuments: false });
    const app = await buildApp();
    const res = await request(app).get(url);
    expect(res.status).toBe(404);
    expect(downloadFileBuffer).not.toHaveBeenCalled();
  });

  it('410s on a revoked share and serves no bytes', async () => {
    shareRow = validShare({ revokedAt: '2026-08-01T00:00:00Z' });
    const app = await buildApp();
    const res = await request(app).get(url);
    expect(res.status).toBe(410);
    expect(downloadFileBuffer).not.toHaveBeenCalled();
    expect(fetchStorageObject).not.toHaveBeenCalled();
  });

  it('410s on an expired share and serves no bytes', async () => {
    shareRow = validShare({ expiresAt: '2020-01-01T00:00:00Z' });
    const app = await buildApp();
    const res = await request(app).get(url);
    expect(res.status).toBe(410);
    expect(downloadFileBuffer).not.toHaveBeenCalled();
    expect(fetchStorageObject).not.toHaveBeenCalled();
  });

  it('revoking takes effect on the very next request for the same download link', async () => {
    const app = await buildApp();
    const first = await request(app).get(url).buffer(true).parse(binaryParser);
    expect(first.status).toBe(200);
    shareRow = validShare({ revokedAt: new Date().toISOString() }); // owner clicks Revoke
    const second = await request(app).get(url);
    expect(second.status).toBe(410);
    expect(watermarkPdf).toHaveBeenCalledTimes(1);
  });
});
