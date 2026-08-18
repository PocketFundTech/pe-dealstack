/**
 * Public document-request portal — GET/POST /api/public/doc-requests/:token.
 * No auth: the token IS the credential (spec §3.6, §3.7).
 *
 * The whitelist test here is the highest-value test in the feature. An
 * external broker must never be able to see financials, memos, scorecards
 * or anything else about a deal through this surface.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The document pipeline itself is exercised by its own tests and reaches
// storage + extraction; here we only care that the portal delegates to it
// with the right deal + org and links the result back to the checklist.
const handleDocumentUpload = vi.fn();
vi.mock('../src/routes/documents-upload.js', () => ({
  handleDocumentUpload: (...args: any[]) => handleDocumentUpload(...args),
  default: {},
}));

const notifyDealTeam = vi.fn(async () => undefined);
vi.mock('../src/routes/notifications.js', () => ({
  notifyDealTeam: (...args: any[]) => notifyDealTeam(...args),
  resolveUserId: vi.fn(async () => null),
}));

let requestRow: any;
let itemRows: any[] = [];
let dealRow: any;
let orgRow: any;
let recordedEvents: any[] = [];
let itemPatch: any = null;
let requestPatch: any = null;

function tableMock() {
  return (table: string) => {
    if (table === 'DocRequest') {
      const chain: any = {
        eq: () => chain,
        single: async () => ({ data: requestRow, error: null }),
        then: (resolve: any) => resolve({ error: null }),
      };
      return {
        select: () => chain,
        update: (patch: any) => { requestPatch = patch; return chain; },
      };
    }
    if (table === 'DocRequestItem') {
      const chain: any = {
        eq: () => chain,
        order: async () => ({ data: itemRows, error: null }),
        single: async () => ({
          data: itemRows.find((i) => i.id === chain._id) ?? itemRows[0] ?? null,
          error: null,
        }),
        then: (resolve: any) => resolve({ error: null }),
      };
      return {
        select: () => chain,
        update: (patch: any) => { itemPatch = patch; return chain; },
      };
    }
    if (table === 'DocRequestEvent') {
      return { insert: async (row: any) => { recordedEvents.push(row); return { error: null }; } };
    }
    if (table === 'Deal') {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: dealRow, error: null }) }) }) };
    }
    if (table === 'Organization') {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: orgRow, error: null }) }) }) };
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

function validRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1', dealId: 'deal-1', organizationId: 'org-1', token: 'tok',
    message: 'Please send these over.', status: 'OPEN',
    recipientName: 'Dana Broker', recipientEmail: 'dana@brokers.com',
    expiresAt: null, revokedAt: null, completedAt: null,
    ...overrides,
  };
}

async function buildApp() {
  const { default: router } = await import('../src/routes/doc-request-portal.js');
  const app = express();
  app.use(express.json());
  app.use('/api/public/doc-requests', router); // NOTE: no auth — deliberately public
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  requestRow = validRequest();
  itemRows = [
    { id: 'item-1', requestId: 'req-1', label: '3-year P&L', docType: 'FINANCIALS', notes: null, required: true, sortOrder: 0, documentId: null, fulfilledAt: null },
    { id: 'item-2', requestId: 'req-1', label: 'Balance sheet', docType: 'FINANCIALS', notes: null, required: true, sortOrder: 1, documentId: 'doc-9', fulfilledAt: '2026-08-10T00:00:00Z' },
  ];
  dealRow = {
    id: 'deal-1', name: 'Project Neptune', companyName: 'NeptuneCo',
    // fields that must NOT surface:
    industry: 'Software', stage: 'DUE_DILIGENCE', revenue: 10, ebitda: 2,
    dealSize: 12, aiThesis: 'secret thesis', scorecard: { overallScore: 88 },
    description: 'internal description',
  };
  orgRow = { name: 'Acme Capital' };
  recordedEvents = [];
  itemPatch = null;
  requestPatch = null;
  mockSupabase.from.mockImplementation(tableMock());
});

describe('GET /api/public/doc-requests/:token', () => {
  it('returns the checklist, deal label and requesting firm', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/public/doc-requests/tok');

    expect(res.status).toBe(200);
    expect(res.body.dealName).toBe('Project Neptune');
    expect(res.body.companyName).toBe('NeptuneCo');
    expect(res.body.firmName).toBe('Acme Capital');
    expect(res.body.message).toBe('Please send these over.');
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toEqual({
      id: 'item-1', label: '3-year P&L', notes: null, required: true, fulfilled: false,
    });
    expect(res.body.items[1].fulfilled).toBe(true);
  });

  it('leaks nothing beyond the documented whitelist', async () => {
    // Pinned to the EXACT key set on purpose: adding a field here must be a
    // deliberate act with a test change, not an accident of a wider select.
    const app = await buildApp();
    const res = await request(app).get('/api/public/doc-requests/tok');

    expect(Object.keys(res.body).sort()).toEqual(
      ['companyName', 'dealName', 'firmName', 'items', 'message', 'recipientName', 'status'].sort(),
    );
    for (const item of res.body.items) {
      expect(Object.keys(item).sort()).toEqual(
        ['fulfilled', 'id', 'label', 'notes', 'required'].sort(),
      );
    }
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('secret thesis');
    expect(serialized).not.toContain('overallScore');
    expect(serialized).not.toContain('org-1');
    expect(serialized).not.toContain('deal-1');
    expect(serialized).not.toContain('tok');
  });

  it('records a view without blocking the response', async () => {
    const app = await buildApp();
    await request(app).get('/api/public/doc-requests/tok');
    expect(recordedEvents.filter((e) => e.kind === 'VIEWED')).toHaveLength(1);
  });

  it('404s an unknown token', async () => {
    requestRow = null;
    const app = await buildApp();
    const res = await request(app).get('/api/public/doc-requests/nope');
    expect(res.status).toBe(404);
  });

  it('410s a revoked token', async () => {
    requestRow = validRequest({ revokedAt: '2026-08-01T00:00:00Z' });
    const app = await buildApp();
    expect((await request(app).get('/api/public/doc-requests/tok')).status).toBe(410);
  });

  it('410s an expired token', async () => {
    requestRow = validRequest({ expiresAt: '2020-01-01T00:00:00Z' });
    const app = await buildApp();
    expect((await request(app).get('/api/public/doc-requests/tok')).status).toBe(410);
  });
});

describe('POST /api/public/doc-requests/:token/items/:itemId/upload', () => {
  beforeEach(() => {
    handleDocumentUpload.mockImplementation(async (_req: any, res: any) => {
      res.status(201).json({ id: 'doc-new', name: 'pl.pdf' });
    });
  });

  it('routes the file through the shared document pipeline with the token’s deal and org', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/public/doc-requests/tok/items/item-1/upload')
      .attach('file', Buffer.from('%PDF-1.4 fake'), 'pl.pdf');

    expect(res.status).toBe(201);
    expect(handleDocumentUpload).toHaveBeenCalledTimes(1);

    const passedReq = handleDocumentUpload.mock.calls[0][0];
    // Org comes from the DocRequest row, never from anything the uploader sent.
    expect(passedReq.user.organizationId).toBe('org-1');
    expect(passedReq.params.dealId).toBe('deal-1');
    expect(passedReq.file.originalname).toBe('pl.pdf');
  });

  it('links the created document onto the checklist item', async () => {
    const app = await buildApp();
    await request(app)
      .post('/api/public/doc-requests/tok/items/item-1/upload')
      .attach('file', Buffer.from('%PDF-1.4 fake'), 'pl.pdf');

    expect(itemPatch).toMatchObject({ documentId: 'doc-new' });
    expect(itemPatch.fulfilledAt).toBeTruthy();
    expect(recordedEvents.filter((e) => e.kind === 'UPLOADED')).toHaveLength(1);
  });

  it('notifies the deal team that something arrived', async () => {
    const app = await buildApp();
    await request(app)
      .post('/api/public/doc-requests/tok/items/item-1/upload')
      .attach('file', Buffer.from('%PDF-1.4 fake'), 'pl.pdf');

    expect(notifyDealTeam).toHaveBeenCalled();
    expect(notifyDealTeam.mock.calls[0][0]).toBe('deal-1');
  });

  it('does not mark the item fulfilled when the pipeline rejects the file', async () => {
    handleDocumentUpload.mockImplementation(async (_req: any, res: any) => {
      res.status(400).json({ error: 'File validation failed' });
    });
    const app = await buildApp();
    const res = await request(app)
      .post('/api/public/doc-requests/tok/items/item-1/upload')
      .attach('file', Buffer.from('MZ fake exe'), 'disguised.pdf');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('File validation failed');
    expect(itemPatch).toBeNull();
    expect(recordedEvents.filter((e) => e.kind === 'UPLOADED')).toHaveLength(0);
  });

  it('400s a disallowed file type instead of surfacing a multer 500', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/public/doc-requests/tok/items/item-1/upload')
      .attach('file', Buffer.from('MZ fake exe'), 'payload.exe');

    expect(res.status).toBe(400);
    expect(handleDocumentUpload).not.toHaveBeenCalled();
    expect(itemPatch).toBeNull();
  });

  it('404s an item that belongs to a different request', async () => {
    itemRows = [];
    const app = await buildApp();
    const res = await request(app)
      .post('/api/public/doc-requests/tok/items/someone-elses-item/upload')
      .attach('file', Buffer.from('%PDF-1.4 fake'), 'pl.pdf');

    expect(res.status).toBe(404);
    expect(handleDocumentUpload).not.toHaveBeenCalled();
  });

  it('410s uploads against a revoked link', async () => {
    requestRow = validRequest({ revokedAt: '2026-08-01T00:00:00Z' });
    const app = await buildApp();
    const res = await request(app)
      .post('/api/public/doc-requests/tok/items/item-1/upload')
      .attach('file', Buffer.from('%PDF-1.4 fake'), 'pl.pdf');

    expect(res.status).toBe(410);
    expect(handleDocumentUpload).not.toHaveBeenCalled();
  });

  it('400s when no file is attached', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/public/doc-requests/tok/items/item-1/upload');
    expect(res.status).toBe(400);
    expect(handleDocumentUpload).not.toHaveBeenCalled();
  });
});

describe('POST /api/public/doc-requests/:token/complete', () => {
  it('stamps completion and logs the event', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/public/doc-requests/tok/complete');

    expect(res.status).toBe(200);
    expect(requestPatch.completedAt).toBeTruthy();
    expect(recordedEvents.filter((e) => e.kind === 'COMPLETED')).toHaveLength(1);
    expect(notifyDealTeam).toHaveBeenCalled();
  });

  it('410s on a revoked link', async () => {
    requestRow = validRequest({ revokedAt: '2026-08-01T00:00:00Z' });
    const app = await buildApp();
    expect((await request(app).post('/api/public/doc-requests/tok/complete')).status).toBe(410);
  });
});
