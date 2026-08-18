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
vi.mock('../src/utils/storage.js', () => ({
  getSignedDownloadUrl: (...args: any[]) => getSignedDownloadUrl(...args),
}));

let shareRow: any;
let dealRow: any;
let statements: any[] = [];
let documents: any[] = [];
let memos: any[] = [];
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
      return { insert: async (row: any) => { recordedViews.push(row); return { error: null }; } };
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
      return { select: () => ({ eq: () => ({ order: async () => ({ data: memos, error: null }) }) }) };
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
  statements = [{ statementType: 'INCOME_STATEMENT', period: 'FY2023', lineItems: { Revenue: 10 } }];
  documents = [{ id: 'doc-1', name: 'CIM.pdf', type: 'CIM', fileSize: 1000 }];
  memos = [];
  recordedViews = [];
  docRow = { id: 'doc-1', dealId: 'deal-1', fileUrl: 'path/CIM.pdf' };
  mockSupabase.from.mockImplementation(tableMock());
  getSignedDownloadUrl.mockResolvedValue('https://signed.example/CIM.pdf');
});

describe('GET /api/public/portal/:token', () => {
  it('returns the scoped payload and records a view', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/public/portal/tok');
    expect(res.status).toBe(200);
    expect(res.body.deal.name).toBe('Project Neptune');
    // companyName is derived from the embedded Company relation, never a Deal
    // column — the select must ask for the relation (regression 2026-08-18).
    expect(res.body.deal.companyName).toBe('NeptuneCo');
    expect(dealSelects.some((c) => /company:Company\(name\)/.test(c))).toBe(true);
    expect(res.body.share.sharedBy).toBe('Acme Capital');
    expect(res.body.financials).toHaveLength(1);
    expect(res.body.documents).toHaveLength(1);
    expect(recordedViews).toHaveLength(1);
    // whitelist check — internal fields never leak
    expect(res.body.deal.aiThesis).toBeUndefined();
    expect(res.body.deal.scorecard).toBeUndefined();
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
  it('302s to a signed URL for an in-deal document', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/public/portal/tok/documents/doc-1/download');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://signed.example/CIM.pdf');
  });

  it('404s for a document that belongs to a different deal', async () => {
    docRow = { id: 'doc-1', dealId: 'other-deal', fileUrl: 'x' };
    const app = await buildApp();
    const res = await request(app).get('/api/public/portal/tok/documents/doc-1/download');
    expect(res.status).toBe(404);
    expect(getSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it('404s when documents are disabled on the share', async () => {
    shareRow = validShare({ includeDocuments: false });
    const app = await buildApp();
    const res = await request(app).get('/api/public/portal/tok/documents/doc-1/download');
    expect(res.status).toBe(404);
    expect(getSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it('410s on a revoked share', async () => {
    shareRow = validShare({ revokedAt: '2026-08-01T00:00:00Z' });
    const app = await buildApp();
    const res = await request(app).get('/api/public/portal/tok/documents/doc-1/download');
    expect(res.status).toBe(410);
  });
});
